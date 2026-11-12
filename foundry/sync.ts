// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Planning a conversion's import into a world's compendiums, apart from
 * Foundry so it can be tested: which documents to create, replace or delete,
 * and which a user has edited since the last import (conflicts for the GM to
 * settle). The Foundry side computes the hashes and applies the plan.
 */

/** The package's id: its flags' scope, and the folder the world's assets go in. */
export const PACKAGE_ID = "ttrpg-pdf-converter";

/** A document as the converter writes it (NeDB JSON). */
export interface SourceDocument {
    _id: string;
    name?: string;
    type?: string;
    [field: string]: unknown;
}

/** What an imported document records about its import, in `flags[PACKAGE_ID]`. */
export interface ImportFlags {
    /** Stable identity within its pack: document type, kind and name (with an ordinal for repeats). */
    key: string;
    /** Hash of the converter's document as last imported (or acknowledged). */
    sourceHash: string;
    /** Hash of the document as Foundry stored it right after that import. */
    fingerprint: string;
    /** Converter release that wrote it. */
    release: string;
}

/** A document already in the world's pack, as the planner needs it. */
export interface ExistingDocument {
    _id: string;
    name: string;
    flags: ImportFlags | null;
    /** Hash of the document as it stands now (same reduction as `fingerprint`). */
    currentFingerprint: string;
}

/** An incoming document with its identity and source hash. */
export interface IncomingDocument {
    key: string;
    sourceHash: string;
    source: SourceDocument;
}

export type ConflictKind = "changed" | "removed";

export interface Conflict {
    kind: ConflictKind;
    key: string;
    name: string;
    /** The world document's id. */
    existingId: string;
    /** The converter's new version ("changed" only). */
    incoming?: IncomingDocument;
}

export interface PackPlan {
    /** New documents (no world document has their key). */
    create: IncomingDocument[];
    /** Unedited world documents whose converter output changed: replaced, keeping the world id. */
    replace: { existingId: string; incoming: IncomingDocument }[];
    /** Unedited world documents the converter no longer writes. */
    remove: string[];
    /** Edited world documents the converter changed or no longer writes. */
    conflicts: Conflict[];
    /** Converter output already imported: nothing to do. */
    unchanged: number;
    /** Converter document id → the world id it lives under (for rewriting references). */
    idMap: Map<string, string>;
}

/** Marks a world document whose removal the GM already declined, so it is not asked again. */
export const REMOVAL_KEPT = "removal-kept";

/** A document's kind within its pack: its type, its name (case and spacing folded). */
function baseKey(documentName: string, doc: SourceDocument): string {
    const name = String(doc.name ?? "")
        .trim()
        .replace(/\s+/gu, " ")
        .toLowerCase();
    return `${documentName}|${String(doc.type ?? "")}|${name}`;
}

/**
 * Each document's stable key within its pack, in order: its type and name,
 * with `#2`, `#3`… for later documents of the same type and name.
 */
export function documentKeys(documentName: string, docs: readonly SourceDocument[]): string[] {
    const seen = new Map<string, number>();
    return docs.map((doc) => {
        const base = baseKey(documentName, doc);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return n === 1 ? base : `${base}#${n}`;
    });
}

/** Whether a world document was edited since its import. */
function edited(doc: ExistingDocument): boolean {
    return doc.flags !== null && doc.currentFingerprint !== doc.flags.fingerprint;
}

/**
 * Plan one pack's import. World documents with no import flags are the
 * user's own and are never touched.
 */
export function planPack(
    incoming: readonly IncomingDocument[],
    existing: readonly ExistingDocument[],
): PackPlan {
    const byKey = new Map(
        existing.filter((d) => d.flags !== null).map((d) => [d.flags?.key ?? "", d] as const),
    );
    const plan: PackPlan = {
        create: [],
        replace: [],
        remove: [],
        conflicts: [],
        unchanged: 0,
        idMap: new Map(),
    };
    const usedIds = new Set(existing.map((d) => d._id));
    for (const doc of incoming) {
        const match = byKey.get(doc.key);
        if (match === undefined) {
            plan.create.push(doc);
            plan.idMap.set(doc.source._id, doc.source._id);
            continue;
        }
        byKey.delete(doc.key);
        plan.idMap.set(doc.source._id, match._id);
        if (match.flags?.sourceHash === doc.sourceHash) {
            plan.unchanged += 1;
        } else if (edited(match)) {
            plan.conflicts.push({
                kind: "changed",
                key: doc.key,
                name: match.name,
                existingId: match._id,
                incoming: doc,
            });
        } else {
            plan.replace.push({ existingId: match._id, incoming: doc });
        }
    }
    for (const doc of byKey.values()) {
        if (doc.flags?.sourceHash === REMOVAL_KEPT) {
            continue;
        }
        if (edited(doc)) {
            plan.conflicts.push({
                kind: "removed",
                key: doc.flags?.key ?? "",
                name: doc.name,
                existingId: doc._id,
            });
        } else {
            plan.remove.push(doc._id);
        }
    }
    // A new document whose converter id a user's own document already holds takes another.
    for (const doc of plan.create) {
        if (usedIds.has(doc.source._id)) {
            const id = freshId(doc.source._id, usedIds);
            plan.idMap.set(doc.source._id, id);
            usedIds.add(id);
        }
    }
    return plan;
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A 16-character id derived from `id` that is not in `used` (deterministic). */
function freshId(id: string, used: ReadonlySet<string>): string {
    for (let n = 1; ; n += 1) {
        const chars = [...id.padEnd(16, "A").slice(0, 16)];
        const last = ID_ALPHABET.indexOf(chars[15] ?? "A");
        chars[15] = ID_ALPHABET[(last + n) % ID_ALPHABET.length] ?? "A";
        const candidate = chars.join("");
        if (!used.has(candidate)) {
            return candidate;
        }
    }
}

/** How the GM settled one conflict. */
export type Resolution = "keep" | "replace";

/**
 * Fields that say nothing about a document's content: ids, timestamps,
 * placement and ownership, and this package's own flags. A fingerprint
 * leaves them out at every depth.
 */
const VOLATILE = new Set(["_id", "_stats", "folder", "sort", "ownership"]);

/** The document reduced to its content, keys sorted, as JSON. */
export function canonicalContent(value: unknown): string {
    return JSON.stringify(reduce(value));
}

function reduce(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(reduce);
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        if (VOLATILE.has(key)) {
            continue;
        }
        let field = (value as Record<string, unknown>)[key];
        if (key === "flags" && field !== null && typeof field === "object") {
            const { [PACKAGE_ID]: _own, ...rest } = field as Record<string, unknown>;
            field = rest;
        }
        out[key] = reduce(field);
    }
    return out;
}

/** SHA-256 of a string, as hex. */
export async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Point a converter document at the world: its compendium references at the
 * world's packs and the ids documents live under there, its asset paths at
 * where the assets were uploaded.
 */
export function pointAtWorld(
    value: unknown,
    moduleId: string,
    idMap: ReadonlyMap<string, string>,
    assetDir: string,
): unknown {
    if (typeof value === "string") {
        const asset = `modules/${moduleId}/assets/`;
        const pointed = value.startsWith(asset) ? `${assetDir}/${value.slice(asset.length)}` : value;
        return pointed.replace(
            new RegExp(
                `Compendium\\.${escapeRegExp(moduleId)}\\.([\\w-]+)\\.(\\w+)\\.([A-Za-z0-9]{16})`,
                "gu",
            ),
            (_m, pack: string, type: string, id: string) =>
                `Compendium.world.${pack}.${type}.${idMap.get(id) ?? id}`,
        );
    }
    if (Array.isArray(value)) {
        return value.map((v) => pointAtWorld(v, moduleId, idMap, assetDir));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, pointAtWorld(v, moduleId, idMap, assetDir)]),
        );
    }
    return value;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** One pack of a converted module, read from its module.json and its NeDB file. */
export interface ConvertedPack {
    name: string;
    label: string;
    type: string;
    flags: Record<string, unknown>;
    ownership: Record<string, string>;
    documents: SourceDocument[];
}

export interface ConvertedModule {
    id: string;
    title: string;
    release: string;
    packs: ConvertedPack[];
    /** Extracted images: file name → bytes. */
    assets: Map<string, Uint8Array>;
}

/** A module's manifest pack entry, as the converter writes it. */
interface ManifestPack {
    name: string;
    label: string;
    type: string;
    path: string;
    flags?: Record<string, unknown>;
    ownership?: Record<string, string>;
}

/** Read a converted module from its files (`<id>/module.json`, `<id>/packs/*.db`, `<id>/assets/*`). */
export function readConvertedModule(
    files: readonly { relPath: string; contents: string | Uint8Array }[],
): ConvertedModule {
    const text = (f: { contents: string | Uint8Array }): string =>
        typeof f.contents === "string" ? f.contents : new TextDecoder().decode(f.contents);
    const manifestFile = files.find((f) => /^[^/]+\/module\.json$/u.test(f.relPath));
    if (manifestFile === undefined) {
        throw new Error("the conversion wrote no module.json");
    }
    const manifest = JSON.parse(text(manifestFile)) as {
        id: string;
        title: string;
        version: string;
        packs: ManifestPack[];
    };
    const root = `${manifest.id}/`;
    const packs = manifest.packs.map((p): ConvertedPack => {
        const db = files.find((f) => f.relPath === `${root}${p.path}.db`);
        const documents =
            db === undefined
                ? []
                : text(db)
                      .split("\n")
                      .filter((l) => l.trim().length > 0)
                      .map((l) => JSON.parse(l) as SourceDocument);
        return {
            name: p.name,
            label: p.label,
            type: p.type,
            flags: p.flags ?? {},
            ownership: p.ownership ?? {},
            documents,
        };
    });
    const assets = new Map<string, Uint8Array>();
    for (const f of files) {
        if (f.relPath.startsWith(`${root}assets/`) && typeof f.contents !== "string") {
            assets.set(f.relPath.slice(`${root}assets/`.length), f.contents);
        }
    }
    return { id: manifest.id, title: manifest.title, release: manifest.version, packs, assets };
}
