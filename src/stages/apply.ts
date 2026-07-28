// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, EntityGraph, FieldValue } from "../types/entity.ts";
import type { IR, IRTextRun, ImageAssets } from "../types/ir.ts";
import type { BlockSpec, EmitRule, FieldSpec, ImageAssocSpec, Profile, Selector } from "../types/profile.ts";
import { compilePattern } from "../dsl/regex.ts";
import { isExcluded, matchesSelector } from "../dsl/selectors.ts";
import { applyTransforms, type TransformValue } from "../dsl/transforms.ts";
import { BAND_HEIGHT } from "../util/rounding.ts";
import { byteCompare, chain, numAsc } from "../util/ordered.ts";

/**
 * Stage 5 — Apply (spec §8). Interprets the validated profile against the IR:
 * segments blocks, extracts fields through the DSL, associates images by
 * geometry, then binds block instances into entities through the emit rules.
 *
 * Reads only the IR and ImageAssets — never raw extractor output (§3). Fails
 * loud: an unmatched *required* field is an error with page/coordinate context,
 * the entry is skipped, and the run exits non-zero at the end (§8.6). Ambiguous
 * image association that `pick` cannot resolve emits no image and warns (§6.3).
 */

export interface ApplyResult {
    graph: EntityGraph;
    /** Fatal-at-end-of-run errors (required fields, unresolved references). */
    errors: string[];
}

interface BlockInstance {
    runs: IRTextRun[];
    /** Page → content region occupied by this instance's runs. */
    regions: Map<number, { minX: number; minY: number; maxX: number; maxY: number }>;
    values: Map<string, FieldValue>;
    images: Map<string, string>;
    firstRun: IRTextRun;
}

function selector(profile: Profile, name: string): Selector {
    const sel = profile.selectors[name];
    if (sel === undefined) {
        throw new Error(`profile references undefined selector ${JSON.stringify(name)}`);
    }
    return sel;
}

function endSelectorName(block: BlockSpec): string {
    return "next" in block.ends_at ? block.ends_at.next : block.ends_at.selector;
}

function segmentBlock(profile: Profile, block: BlockSpec, runs: readonly IRTextRun[]): BlockInstance[] {
    const startSel = selector(profile, block.starts_at);
    const endSel = selector(profile, endSelectorName(block));
    const startIdx: number[] = [];
    runs.forEach((run, i) => {
        if (matchesSelector(startSel, run)) {
            startIdx.push(i);
        }
    });

    const instances: BlockInstance[] = [];
    for (let s = 0; s < startIdx.length; s += 1) {
        const start = startIdx[s]!;
        let end = runs.length;
        for (let i = start + 1; i < runs.length; i += 1) {
            if (matchesSelector(endSel, runs[i]!)) {
                end = i;
                break;
            }
        }
        const slice = runs.slice(start, end);
        const regions = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
        for (const r of slice) {
            const region = regions.get(r.pageIndex) ?? {
                minX: Number.POSITIVE_INFINITY,
                minY: Number.POSITIVE_INFINITY,
                maxX: Number.NEGATIVE_INFINITY,
                maxY: Number.NEGATIVE_INFINITY,
            };
            region.minX = Math.min(region.minX, r.x);
            region.minY = Math.min(region.minY, r.y);
            region.maxX = Math.max(region.maxX, r.x + r.width);
            region.maxY = Math.max(region.maxY, r.y + r.height);
            regions.set(r.pageIndex, region);
        }
        instances.push({
            runs: slice,
            regions,
            values: new Map(),
            images: new Map(),
            firstRun: runs[start]!,
        });
    }
    return instances;
}

function coerceScalar(value: TransformValue): FieldValue {
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    return value;
}

function extractField(profile: Profile, field: FieldSpec, instance: BlockInstance, errors: string[]): void {
    const fromSel = selector(profile, field.from);
    const sourceText = instance.runs
        .filter((r) => matchesSelector(fromSel, r))
        .map((r) => r.text)
        .join("\n");

    let value: TransformValue = sourceText;
    if (field.match !== undefined) {
        const group = field.capture ?? 1;
        value = compilePattern(field.match).capture(sourceText, group);
    }
    if (field.transform !== undefined) {
        value = applyTransforms(field.transform, value);
    }
    const scalar = coerceScalar(value);
    const missing = scalar === null || (typeof scalar === "string" && scalar.length === 0);
    if (missing) {
        if (field.required === true) {
            const r = instance.firstRun;
            errors.push(
                `required field ${JSON.stringify(field.name)} unmatched (page ${r.pageIndex + 1}, y=${r.y}); entry skipped`,
            );
        }
        return;
    }
    instance.values.set(field.name, scalar);
}

interface ImageCandidate {
    assetId: string;
    pageIndex: number;
    cx: number;
    cy: number;
    area: number;
    aspect: number;
    x: number;
}

function associateImage(
    assoc: ImageAssocSpec,
    instance: BlockInstance,
    assets: ImageAssets,
    ir: IR,
    warnings: string[],
): void {
    const pageHeight = new Map(ir.pages.map((p) => [p.pageIndex, p.height] as const));
    const candidates: ImageCandidate[] = [];
    for (const placement of assets.placements) {
        const [x0, y0, x1, y1] = placement.bbox;
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        const area = w * h;
        const aspect = h > 0 ? w / h : 0;
        if (assoc.where.within_block === true) {
            const region = instance.regions.get(placement.pageIndex);
            if (region === undefined) {
                continue;
            }
            if (cx < region.minX || cx > region.maxX || cy < region.minY || cy > region.maxY) {
                continue;
            }
        }
        if (assoc.where.max_area_pt2 !== undefined && area > assoc.where.max_area_pt2) {
            continue;
        }
        if (
            assoc.where.aspect !== undefined &&
            (aspect < assoc.where.aspect.min || aspect > assoc.where.aspect.max)
        ) {
            continue;
        }
        candidates.push({
            assetId: placement.assetId,
            pageIndex: placement.pageIndex,
            cx,
            cy,
            area,
            aspect,
            x: x0,
        });
    }

    if (candidates.length === 0) {
        return;
    }

    let chosen: ImageCandidate | undefined;
    if (assoc.pick === "largest") {
        chosen = [...candidates].sort(
            chain<ImageCandidate>(
                (a, b) => numAsc(b.area, a.area),
                (a, b) => byteCompare(a.assetId, b.assetId),
            ),
        )[0];
    } else {
        // first_by_sort / all: §5.1 order applied to image bboxes, tiebreak assetId asc.
        const ordered = [...candidates].sort(
            chain<ImageCandidate>(
                (a, b) => numAsc(a.pageIndex, b.pageIndex),
                (a, b) =>
                    numAsc(
                        Math.floor(((pageHeight.get(a.pageIndex) ?? 0) - a.cy) / BAND_HEIGHT),
                        Math.floor(((pageHeight.get(b.pageIndex) ?? 0) - b.cy) / BAND_HEIGHT),
                    ),
                (a, b) => numAsc(a.x, b.x),
                (a, b) => byteCompare(a.assetId, b.assetId),
            ),
        );
        if (assoc.pick === "all" && ordered.length > 1) {
            warnings.push(
                `image ${JSON.stringify(assoc.id)}: pick 'all' collapses to first_by_sort for a single-valued field; ${ordered.length} candidates`,
            );
        }
        chosen = ordered[0];
    }
    if (chosen !== undefined) {
        instance.images.set(assoc.id, chosen.assetId);
    }
}

function resolveRef(
    ref: string,
    instance: BlockInstance,
): { kind: "field" | "image" | "literal"; value: FieldValue | string } {
    if (!ref.startsWith("$")) {
        return { kind: "literal", value: ref };
    }
    const name = ref.slice(1);
    if (instance.images.has(name)) {
        return { kind: "image", value: instance.images.get(name)! };
    }
    if (instance.values.has(name)) {
        return { kind: "field", value: instance.values.get(name)! };
    }
    return { kind: "field", value: null };
}

export function apply(profile: Profile, ir: IR, assets: ImageAssets): ApplyResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    const entities: Entity[] = [];
    const ordinalByPack = new Map<string, number>();

    const activeRuns = ir.runs.filter((r) => !isExcluded(r, profile.exclude ?? []));
    const instancesByBlock = new Map<string, BlockInstance[]>();

    for (const block of profile.blocks) {
        const instances = segmentBlock(profile, block, activeRuns);
        for (const instance of instances) {
            for (const field of block.fields) {
                extractField(profile, field, instance, errors);
            }
            for (const assoc of block.images ?? []) {
                associateImage(assoc, instance, assets, ir, warnings);
            }
        }
        instancesByBlock.set(block.id, instances);
    }

    for (const rule of profile.emit) {
        const instances = instancesByBlock.get(rule.block) ?? [];
        const group = rule.group ?? rule.pack;
        for (const instance of instances) {
            const entity = bindEntity(rule, group, instance, ordinalByPack, warnings);
            if (entity !== null) {
                entities.push(entity);
            }
        }
    }

    return { graph: { entities, warnings }, errors };
}

function bindEntity(
    rule: EmitRule,
    group: string,
    instance: BlockInstance,
    ordinalByPack: Map<string, number>,
    warnings: string[],
): Entity | null {
    const fields: Record<string, FieldValue> = {};
    const images: Record<string, string> = {};
    for (const [path, ref] of Object.entries(rule.map)) {
        const resolved = resolveRef(ref, instance);
        if (resolved.kind === "image") {
            images[path] = resolved.value as string;
        } else if (resolved.kind === "literal") {
            fields[path] = resolved.value as string;
        } else if (resolved.value !== null) {
            fields[path] = resolved.value;
        }
    }

    const enrichmentRequests: { path: string; key: string }[] = [];
    for (const [path, target] of Object.entries(rule.enrichment ?? {})) {
        const resolved = resolveRef(target.key, instance);
        if (typeof resolved.value === "string" && resolved.value.length > 0) {
            enrichmentRequests.push({ path, key: resolved.value });
        }
    }

    if (fields["name"] === undefined && images["name"] === undefined) {
        warnings.push(`entity in pack ${group}/${rule.pack} has no name; using slug fallback`);
    }

    const packKey = `${group}/${rule.pack}`;
    const ordinal = ordinalByPack.get(packKey) ?? 0;
    ordinalByPack.set(packKey, ordinal + 1);

    return {
        blockId: rule.block,
        documentType: rule.document_type,
        pack: rule.pack,
        group,
        ordinal,
        fields,
        images,
        enrichmentRequests,
        enrichmentFields: {},
        provenance: { pageIndex: instance.firstRun.pageIndex, y: instance.firstRun.y },
    };
}
