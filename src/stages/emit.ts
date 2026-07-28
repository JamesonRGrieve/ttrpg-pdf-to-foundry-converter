// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, EntityGraph, FieldValue } from "../types/entity.ts";
import { id16 } from "../util/hash.ts";
import { byteCompare, numAsc, sortKeysDeep } from "../util/ordered.ts";
import { slugify } from "../util/slug.ts";

/**
 * Stage 7 — Emit (spec §9). Produces the output corpus as per-document files in
 * the format the existing pack tooling round-trips cleanly: JSON under
 * `<group>/<pack>/_source/<slug>_<id>.json`, 4-space indent, keys byte-sorted
 * at every level, LF endings, terminal newline.
 *
 * DETERMINISM CONTRACT:
 *  - `_id` = base62(sha256(pack + "\0" + canonical))[0..16] over content only,
 *    excluding `_id`, `_stats`, `sort`, and all Tier C enrichment fields (§9.1).
 *    Image references contribute their CONTENT ADDRESS (`asset:<id>`), not their
 *    deployment path, so a differently-configured asset prefix cannot fork ids
 *    (strengthens §9.1 toward its stated goal of interchangeable corpora).
 *  - `_stats.createdTime`/`modifiedTime` are the fixed constant 0 (§9.2).
 *  - `sort` derives from ordinal position × a fixed stride, never insertion order.
 *  - Optional fields are represented by omission — never `null` vs `undefined`
 *    drift.
 */

const SORT_STRIDE = 100000;

export interface EmitConfig {
    /** Deployment path prefix for image references, e.g. `systems/foo/packs/images`. */
    assetRefPrefix: string;
}

export interface EmittedFile {
    /** Path relative to the packs root: `<group>/<pack>/_source/<file>.json`. */
    relPath: string;
    contents: string;
}

export interface EmitResult {
    files: EmittedFile[];
    provenanceByPack: Map<string, { group: string; pack: string; count: number }>;
    warnings: string[];
}

type JsonObject = Record<string, unknown>;

function setPath(target: JsonObject, path: string, value: unknown): void {
    const parts = path.split(".");
    let node = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i]!;
        const next = node[key];
        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            const created: JsonObject = {};
            node[key] = created;
            node = created;
        } else {
            node = next as JsonObject;
        }
    }
    node[parts[parts.length - 1]!] = value;
}

function assetPath(prefix: string, assetId: string, ext: string): string {
    return `${prefix}/${assetId}.${ext}`;
}

/** Stable JSON: byte-sorted keys, 4-space indent, terminal newline, LF, no BOM. */
export function serializeDocument(doc: unknown): string {
    return `${JSON.stringify(sortKeysDeep(doc), null, 4)}\n`;
}

interface BuiltDoc {
    hashPreimageBody: string;
    /** Tier A content object (no _id/_stats/sort/enrichment). */
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

    const name = typeof entity.fields["name"] === "string" ? (entity.fields["name"] as string) : "entry";
    const canonical = JSON.stringify(sortKeysDeep(hashProjection));
    return { hashPreimageBody: canonical, content, name };
}

export function emit(graph: EntityGraph, assetExt: Map<string, string>, cfg: EmitConfig): EmitResult {
    const files: EmittedFile[] = [];
    const warnings = [...graph.warnings];
    const provenanceByPack = new Map<string, { group: string; pack: string; count: number }>();
    const usedIdsByPack = new Map<string, Set<string>>();

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

        const doc: JsonObject = { ...built.content };
        doc["_id"] = id;
        doc["sort"] = entity.ordinal * SORT_STRIDE;
        doc["_stats"] = { createdTime: 0, modifiedTime: 0 };
        // Tier C enrichment written last, after the id is fixed (§10.6).
        for (const [path, value] of Object.entries(entity.enrichmentFields)) {
            if (value !== null) {
                setPath(doc, path, value as FieldValue);
            }
        }

        const fileName = `${slugify(built.name)}_${id}.json`;
        files.push({
            relPath: `${entity.group}/${entity.pack}/_source/${fileName}`,
            contents: serializeDocument(doc),
        });

        const prov = provenanceByPack.get(packKey) ?? { group: entity.group, pack: entity.pack, count: 0 };
        prov.count += 1;
        provenanceByPack.set(packKey, prov);
    }

    files.sort((a, b) => byteCompare(a.relPath, b.relPath));
    return { files, provenanceByPack, warnings };
}
