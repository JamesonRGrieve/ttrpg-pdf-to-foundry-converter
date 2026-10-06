// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SystemId } from "../infer/targets.ts";
import type { FoundryDocumentType, JsonObject, JsonValue } from "../types/entity.ts";
import { sha256Hex } from "../util/hash.ts";
import { byteCompare, sortKeysDeep } from "../util/ordered.ts";
import { FLAG_SCOPE, UPDATE_CHECK_PATH, UPDATE_CHECK_SCRIPT } from "./update-check.ts";

/**
 * Stage 8 — Package. Turns one run's documents (from one or more PDFs) into a
 * Foundry VTT module that exposes them as compendiums of one game system (the
 * system the run's targets write for):
 *
 *   <id>/module.json
 *   <id>/packs/<pack>.db       NeDB: one JSON document per line
 *   <id>/assets/<asset>.<ext>  extracted images the documents reference
 *   <id>/scripts/update-check.js  tells the GM when a newer converter release exists
 *
 * Foundry builds each pack's LevelDB from its `.db` file the first time the
 * pack is opened, so the module needs no native tooling to produce — the
 * browser and the CLI write identical bytes. The converter's release is the
 * module's version and is stamped on every pack.
 *
 * Several such modules install side by side: the id is a hash of the module's
 * own content (never of the input files), so distinct runs get distinct ids;
 * pack names are namespaced by the module; image paths point into the module
 * itself; and nothing touches the system or any other package. The update
 * check is the module's only script: it changes no document or setting, and
 * all active converted modules share one notice.
 */

/** Documents are emitted with image paths under this prefix; packaging points them at the module. */
export const MODULE_ASSET_PLACEHOLDER = "modules/{module}/assets";

/** Documents reference each other as `Compendium.{module}.<pack>…`; packaging names the module. */
export const COMPENDIUM_PLACEHOLDER = "Compendium.{module}.";

/** The default game system the packs belong to. */
export const SYSTEM_ID: SystemId = "wh40k-rpg";

/** Foundry core generations the module declares support for: each system's own range. */
const COMPATIBILITY: Readonly<Record<SystemId, { minimum: string; verified: string }>> = {
    "wh40k-rpg": { minimum: "13", verified: "14" },
    dnd5e: { minimum: "14", verified: "14" },
};

/** Leading characters of the content hash that form the module id. */
const MODULE_ID_HASH_LENGTH = 12;

export interface PackInput {
    /** Pack name (unique within the module). */
    name: string;
    /** Human-readable pack label. */
    label: string;
    documentType: FoundryDocumentType;
    /** The pack's documents, each with its `_id`. */
    documents: readonly JsonObject[];
}

export interface ModuleInput {
    /** The game system every pack belongs to. */
    system: SystemId;
    packs: readonly PackInput[];
    /** Image files, by file name under `assets/`. */
    assets: readonly { relPath: string; bytes: Uint8Array }[];
    /** Short names of the source documents, for the module's title. */
    sources: readonly string[];
    /**
     * The engine's identity (release, extractor, renderer, OCR, target),
     * recorded in the manifest's flags; the release is the module's version
     * and is stamped on every pack.
     */
    provenance: { release: string } & JsonObject;
}

export interface ModuleFile {
    /** Path relative to the modules directory: `<id>/…`. */
    relPath: string;
    contents: string | Uint8Array;
}

export interface BuiltModule {
    id: string;
    files: ModuleFile[];
}

/** Point every string of a document into the module: its asset prefix and its compendium references. */
function pointAssets(value: JsonValue, id: string): JsonValue {
    if (typeof value === "string") {
        const pointed = value.startsWith(`${MODULE_ASSET_PLACEHOLDER}/`)
            ? `modules/${id}/assets${value.slice(MODULE_ASSET_PLACEHOLDER.length)}`
            : value;
        return pointed.replaceAll(COMPENDIUM_PLACEHOLDER, `Compendium.${id}.`);
    }
    if (Array.isArray(value)) {
        return value.map((v) => pointAssets(v, id));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pointAssets(v, id)]));
    }
    return value;
}

/** Packs of the same name merged; documents sharing an `_id` share their content, so one is kept. */
function mergePacks(packs: readonly PackInput[]): PackInput[] {
    const byName = new Map<string, { pack: PackInput; ids: Set<string>; documents: JsonObject[] }>();
    for (const pack of packs) {
        const merged = byName.get(pack.name) ?? { pack, ids: new Set<string>(), documents: [] };
        byName.set(pack.name, merged);
        for (const doc of pack.documents) {
            const id = String(doc["_id"]);
            if (!merged.ids.has(id)) {
                merged.ids.add(id);
                merged.documents.push(doc);
            }
        }
    }
    return [...byName.values()]
        .map(({ pack, documents }) => ({
            ...pack,
            documents: [...documents].sort((a, b) => byteCompare(String(a["_id"]), String(b["_id"]))),
        }))
        .sort((a, b) => byteCompare(a.name, b.name));
}

/** The module id: a hash of what it contains (pack names, document ids, asset names). */
export function moduleId(packs: readonly PackInput[], assets: readonly { relPath: string }[]): string {
    const manifest = [
        ...packs.flatMap((p) => p.documents.map((d) => `${p.name}/${String(d["_id"])}`)),
        ...assets.map((a) => `asset/${a.relPath}`),
    ].sort(byteCompare);
    return `pdf-compendium-${sha256Hex(manifest.join("\n")).slice(0, MODULE_ID_HASH_LENGTH)}`;
}

export function buildModule(input: ModuleInput): BuiltModule {
    const packs = mergePacks(input.packs);
    const assets = [...new Map(input.assets.map((a) => [a.relPath, a] as const)).values()].sort((a, b) =>
        byteCompare(a.relPath, b.relPath),
    );
    const id = moduleId(packs, assets);
    const sources = [...new Set(input.sources)].sort(byteCompare);

    const manifest = {
        id,
        title: `PDF Compendium: ${sources.join(", ")} (${input.provenance.release})`,
        description: `Compendium packs converted by foundry-pdf-parser from PDFs its user supplied, for the ${input.system} system.`,
        version: input.provenance.release,
        compatibility: COMPATIBILITY[input.system],
        flags: { [FLAG_SCOPE]: input.provenance },
        relationships: { systems: [{ id: input.system, type: "system" }] },
        // Tells the GM when a newer converter release could build this module better.
        esmodules: [UPDATE_CHECK_PATH],
        packs: packs.map((p) => ({
            name: p.name,
            label: p.label,
            path: `packs/${p.name}`,
            type: p.documentType,
            system: input.system,
            ownership: { PLAYER: "OBSERVER", ASSISTANT: "OWNER" },
            flags: { [FLAG_SCOPE]: { release: input.provenance.release } },
        })),
        packFolders: [
            { name: `PDF Compendium ${id.slice(-MODULE_ID_HASH_LENGTH)}`, packs: packs.map((p) => p.name) },
        ],
    };

    const files: ModuleFile[] = [
        { relPath: `${id}/module.json`, contents: `${JSON.stringify(sortKeysDeep(manifest), null, 4)}\n` },
        ...packs.map((p) => ({
            relPath: `${id}/packs/${p.name}.db`,
            contents: p.documents
                .map((d) => `${JSON.stringify(sortKeysDeep(pointAssets(d, id)))}\n`)
                .join(""),
        })),
        ...assets.map((a) => ({ relPath: `${id}/assets/${a.relPath}`, contents: a.bytes })),
        { relPath: `${id}/${UPDATE_CHECK_PATH}`, contents: UPDATE_CHECK_SCRIPT },
    ];
    files.sort((a, b) => byteCompare(a.relPath, b.relPath));
    return { id, files };
}
