// SPDX-License-Identifier: AGPL-3.0-or-later
import { nameKey } from "../infer/pipeline.ts";
import { LINE_PUBLICATION_ORDER, LINES, type Line } from "../infer/schema.ts";
import type { JsonObject, JsonValue } from "../types/entity.ts";
import { byteCompare } from "../util/ordered.ts";
import type { EmittedPack } from "./emit.ts";

/**
 * Cross-line homologation (pack-authoring "Homologation Model"): an entity
 * printed in several game lines becomes ONE document — the newest line's
 * reading, carrying every line's per-line variant containers (source,
 * description, rules text) and, where a line prints a different value, a
 * per-line container for that field. Each publishing line's pack holds the
 * same document (what the system's build makes of a whole-file reference
 * stub).
 *
 * Documents are never merged by name alone: they must be the same document
 * type and kind, and agree on the kind's identity fields — values the schema
 * does not vary between lines. A kind with no identity fields listed here is
 * never merged. Two readings from one line (two books of the line printing
 * the same entity) leave the entity unmerged.
 */

/** One document's reading in one line. */
export interface LineDocuments {
    line: Line;
    packs: EmittedPack[];
}

/**
 * Per kind, the `system` fields that must agree before two lines' documents
 * are one entity. An empty list: the kind itself identifies it (a talent is a
 * talent in every line; a skill too, though lines may test it against
 * different characteristics, which then stay per line).
 */
const IDENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
    skill: [],
    weapon: ["class"],
    psychicPower: ["subtype"],
    talent: [],
    trait: [],
    npc: [],
    terracraft: [],
    aircraft: [],
    voidcraft: [],
};

const LINE_SET: ReadonlySet<string> = new Set(LINES);

const isObject = (v: JsonValue | undefined): v is JsonObject =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** A per-line variant container: an object keyed only by line ids. */
function isLineContainer(v: JsonValue | undefined): v is JsonObject {
    return isObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => LINE_SET.has(k));
}

function canonicalJson(v: JsonValue | undefined): string {
    if (Array.isArray(v)) {
        return `[${v.map(canonicalJson).join(",")}]`;
    }
    if (isObject(v)) {
        const keys = Object.keys(v).sort(byteCompare);
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
}

/** The document's kind: its type, less the line prefix of a line-registered actor type (`rt-npc` → `npc`). */
function kindOf(type: string, line: Line): string {
    return type.startsWith(`${line}-`) ? type.slice(line.length + 1) : type;
}

interface Reading {
    line: Line;
    pack: EmittedPack;
    doc: JsonObject;
}

/** The entity key of a document, or null when its kind is never merged. */
function entityKey(pack: EmittedPack, doc: JsonObject, line: Line): string | null {
    const kind = kindOf(String(doc["type"] ?? ""), line);
    const identity = IDENTITY_FIELDS[kind];
    const system = doc["system"];
    if (identity === undefined || !isObject(system)) {
        return null;
    }
    const values: JsonValue[] = [];
    for (const field of identity) {
        const value = system[field];
        if (value === undefined || value === null || value === "") {
            return null;
        }
        values.push(value);
    }
    const name = nameKey(String(doc["name"] ?? ""));
    return [pack.documentType, kind, name, canonicalJson(values)].join("\u0000");
}

const publication = (line: Line): number => LINE_PUBLICATION_ORDER.indexOf(line);

/** Merge the other lines' `system` fields into the newest line's document. */
export function mergeReadings(
    canonical: { line: Line; doc: JsonObject },
    others: readonly Reading[],
): JsonObject {
    const merged = structuredClone(canonical.doc);
    const system = isObject(merged["system"]) ? merged["system"] : {};
    merged["system"] = system;
    // Fields this merge turned into per-line containers.
    const split = new Set<string>();
    for (const other of others) {
        const theirs = other.doc["system"];
        if (!isObject(theirs)) {
            continue;
        }
        for (const [key, value] of Object.entries(theirs)) {
            const ours = system[key];
            if (key === "gameSystems" && Array.isArray(ours) && Array.isArray(value)) {
                const lines = new Set([...ours, ...value].map(String));
                system[key] = LINES.filter((l) => lines.has(l));
            } else if (ours === undefined) {
                system[key] = isLineContainer(value) ? structuredClone(value) : { [other.line]: value };
                split.add(key);
            } else if (isLineContainer(ours) && (isLineContainer(value) || split.has(key))) {
                const add = isLineContainer(value) && !split.has(key) ? value : { [other.line]: value };
                for (const [l, v] of Object.entries(add)) {
                    if (!(l in ours)) {
                        ours[l] = structuredClone(v);
                    }
                }
            } else if (canonicalJson(ours) !== canonicalJson(value)) {
                system[key] = { [canonical.line]: ours, [other.line]: structuredClone(value) };
                split.add(key);
            }
        }
    }
    return merged;
}

/**
 * Homologate the documents of several lines' readings: each entity printed
 * in more than one line becomes one document, placed in every publishing
 * line's pack. Order-independent: the result depends only on the readings.
 */
export function homologate(readings: readonly LineDocuments[]): LineDocuments[] {
    const groups = new Map<string, Reading[]>();
    for (const { line, packs } of readings) {
        for (const pack of packs) {
            for (const doc of pack.documents) {
                const key = entityKey(pack, doc, line);
                if (key !== null) {
                    groups.set(key, [...(groups.get(key) ?? []), { line, pack, doc }]);
                }
            }
        }
    }
    const replacement = new Map<JsonObject, JsonObject>();
    for (const members of groups.values()) {
        const lines = new Set(members.map((m) => m.line));
        if (lines.size < 2 || lines.size !== members.length) {
            continue;
        }
        const ordered = [...members].sort((a, b) => publication(b.line) - publication(a.line));
        const [newest, ...older] = ordered;
        if (newest === undefined) {
            continue;
        }
        const merged = mergeReadings(newest, older);
        for (const member of members) {
            replacement.set(member.doc, { ...merged, sort: member.doc["sort"] ?? 0 });
        }
    }
    return readings.map(({ line, packs }) => ({
        line,
        packs: packs.map((pack) => ({
            ...pack,
            documents: pack.documents.map((doc) => replacement.get(doc) ?? doc),
        })),
    }));
}
