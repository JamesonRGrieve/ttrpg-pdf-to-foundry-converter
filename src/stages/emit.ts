// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, EntityGraph, FoundryDocumentType, JsonObject, JsonValue } from "../types/entity.ts";
import { id16 } from "../util/hash.ts";
import { byteCompare, numAsc, sortKeysDeep } from "../util/ordered.ts";
import { COMPENDIUM_PLACEHOLDER } from "./module.ts";

/**
 * Stage 7 — Emit (spec §9). Turns the entity graph into Foundry documents,
 * grouped by pack; packaging (`module.ts`) writes them out.
 *
 * DETERMINISM CONTRACT:
 *  - `_id` = base62(sha256(pack + "\0" + canonical))[0..16] over content only,
 *    excluding `_id`, `_stats`, and `sort` (§9.1).
 *    Image references contribute their CONTENT ADDRESS (`asset:<id>`), not their
 *    deployment path, so a differently-configured asset prefix cannot fork ids
 *    (strengthens §9.1 toward its stated goal of interchangeable corpora).
 *  - `_stats.createdTime`/`modifiedTime` are the fixed constant 0 (§9.2).
 *  - `sort` derives from ordinal position × a fixed stride, never insertion order.
 *  - Optional fields are represented by omission — never `null` vs `undefined`
 *    drift.
 */

const SORT_STRIDE = 100000;

const REF = /\{\{ref:([^}]+)\}\}/gu;

/**
 * A reference to another entity of the same run, by block id. Emit replaces
 * it with that document's compendium UUID once ids are assigned; packaging
 * then names the module in it. The placeholder, not the UUID, feeds `_id`,
 * so ids stay content-only.
 */
export function entityRef(blockId: string): string {
    return `{{ref:${blockId}}}`;
}

function resolveRefs(value: JsonValue, uuids: ReadonlyMap<string, string>, warnings: string[]): JsonValue {
    if (typeof value === "string") {
        return value.replace(REF, (_, blockId: string) => {
            const uuid = uuids.get(blockId);
            if (uuid === undefined) {
                warnings.push(`unresolved reference to ${blockId}`);
                return "";
            }
            return uuid;
        });
    }
    if (Array.isArray(value)) {
        return value.map((v) => resolveRefs(v, uuids, warnings));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, resolveRefs(v, uuids, warnings)]),
        );
    }
    return value;
}

export interface EmitConfig {
    /** Deployment path prefix for image references, e.g. `systems/foo/packs/images`. */
    assetRefPrefix: string;
}

/** A pack's emitted documents, in emission order. */
export interface EmittedPack {
    group: string;
    pack: string;
    documentType: FoundryDocumentType;
    documents: JsonObject[];
}

export interface EmitResult {
    /** Per pack (`<group>/<pack>`), its documents. */
    packs: Map<string, EmittedPack>;
    warnings: string[];
}

function setPath(target: JsonObject, path: string, value: JsonValue): void {
    const parts = path.split(".");
    const leaf = parts.pop() ?? path;
    let node = target;
    for (const key of parts) {
        const next = node[key];
        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            const created: JsonObject = {};
            node[key] = created;
            node = created;
        } else {
            node = next;
        }
    }
    node[leaf] = value;
}

function assetPath(prefix: string, assetId: string, ext: string): string {
    return `${prefix}/${assetId}.${ext}`;
}

interface BuiltDoc {
    hashPreimageBody: string;
    /** Content object (no _id/_stats/sort). */
    content: JsonObject;
    name: string;
}

function buildTierAContent(entity: Entity, assetExt: Map<string, string>, cfg: EmitConfig): BuiltDoc {
    const content: JsonObject = {};
    const hashProjection: JsonObject = {};

    for (const [path, value] of Object.entries(entity.fields)) {
        if (value !== null) {
            setPath(content, path, value);
            setPath(hashProjection, path, value);
        }
    }
    for (const [path, assetId] of Object.entries(entity.images)) {
        const ext = assetExt.get(assetId) ?? "png";
        setPath(content, path, assetPath(cfg.assetRefPrefix, assetId, ext));
        // Content-address in the hash so the deployment prefix never forks ids.
        setPath(hashProjection, path, `asset:${assetId}`);
    }

    const rawName = entity.fields["name"];
    const name = typeof rawName === "string" ? rawName : "entry";
    const canonical = JSON.stringify(sortKeysDeep(hashProjection));
    return { hashPreimageBody: canonical, content, name };
}

export function emit(graph: EntityGraph, assetExt: Map<string, string>, cfg: EmitConfig): EmitResult {
    const warnings = [...graph.warnings];
    const packs = new Map<string, EmittedPack>();
    const usedIdsByPack = new Map<string, Set<string>>();
    const uuids = new Map<string, string>();

    // Stable total ordering: by pack, then ordinal (deterministic IR order), then blockId.
    const sorted = [...graph.entities].sort((a, b) => {
        const p = byteCompare(`${a.group}/${a.pack}`, `${b.group}/${b.pack}`);
        if (p !== 0) {
            return p;
        }
        if (a.ordinal !== b.ordinal) {
            return numAsc(a.ordinal, b.ordinal);
        }
        return byteCompare(a.blockId, b.blockId);
    });

    for (const entity of sorted) {
        const packKey = `${entity.group}/${entity.pack}`;
        const used = usedIdsByPack.get(packKey) ?? new Set<string>();
        usedIdsByPack.set(packKey, used);

        const built = buildTierAContent(entity, assetExt, cfg);
        let id = id16(`${entity.pack}\x00${built.hashPreimageBody}`);
        if (used.has(id)) {
            // Deterministic disambiguation from ordinal (§9.2).
            id = id16(`${entity.pack}\x00${built.hashPreimageBody}\x00${entity.ordinal}`);
            warnings.push(
                `id collision in pack ${packKey}; disambiguated ${built.name} by ordinal ${entity.ordinal}`,
            );
        }
        used.add(id);
        uuids.set(entity.blockId, `${COMPENDIUM_PLACEHOLDER}${entity.pack}.${entity.documentType}.${id}`);

        const doc: JsonObject = { ...built.content };
        doc["_id"] = id;
        doc["sort"] = entity.ordinal * SORT_STRIDE;
        doc["_stats"] = { createdTime: 0, modifiedTime: 0 };

        const pack = packs.get(packKey) ?? {
            group: entity.group,
            pack: entity.pack,
            documentType: entity.documentType,
            documents: [],
        };
        pack.documents.push(doc);
        packs.set(packKey, pack);
    }

    for (const pack of packs.values()) {
        pack.documents = pack.documents.map((doc) => resolveRefs(doc, uuids, warnings) as JsonObject);
    }
    return { packs, warnings };
}
