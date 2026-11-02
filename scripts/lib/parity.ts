// SPDX-License-Identifier: AGPL-3.0-or-later
import { f1, markdownToText, scoreBag, tokens } from "./bag-score.ts";

/**
 * Parity scoring: how closely the engine's documents for one book agree with a
 * reference set of hand-curated documents of the same book (a compendium tree
 * the user owns). Pure functions over plain JSON; the runner
 * (`scripts/parity.ts`) supplies the documents.
 *
 * Definitions (also recorded in PROGRESS.md):
 * - Documents are matched by type + name key (case, punctuation and accents
 *   ignored; a printed plural, "The" or "Typical" form also matches).
 * - A reference document's leaves are every primitive or array under
 *   `system`, with per-line (`{dh2: …}`) and per-book (`__books`) containers
 *   collapsed to the target line. Leaves under `EXCLUDED` (authored editorial
 *   data a converter cannot read off a page) are not compared.
 * - A leaf scores 1 when the values agree (strings ignore case, dash glyphs and
 *   runs of whitespace; a numeric string equals its number), 0 when not; an
 *   array scores the Jaccard index of its members. A leaf the output omits
 *   agrees when the reference holds an empty value (the schema's initial value
 *   fills it on import).
 * - An actor's embedded items add one pseudo-leaf per item type
 *   (`items.<type>`), the Jaccard index of their name keys.
 * - Doc score = mean leaf score of a matched document, 0 for a missing one.
 *   Type score = mean doc score over the type's reference documents, so it
 *   folds recall and field agreement into one number. Overall = mean doc score
 *   over every reference document.
 * - Mechanics score: the same, over each type's `MECHANICS` leaves only.
 * - Descriptions are scored apart, as bag-of-words F1 of the plain text.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Doc = { [k: string]: Json };

export function isObject(v: Json | undefined): v is { [k: string]: Json } {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The schema's game-line keys: an object keyed only by these is a per-line container. */
const LINE_KEYS: ReadonlySet<string> = new Set(["dh1", "dh2", "rt", "dw", "bc", "ow", "im"]);

/** Collapse a per-line or per-book container to the target line's value. */
export function resolveLine(v: Json | undefined, line: string): Json | undefined {
    if (!isObject(v)) {
        return v;
    }
    const keys = Object.keys(v);
    if (keys.length > 0 && keys.every((k) => LINE_KEYS.has(k))) {
        return resolveLine(v[line], line);
    }
    if (isObject(v["__books"])) {
        const books = v["__books"];
        const canonical = typeof v["__canonical"] === "string" ? v["__canonical"] : Object.keys(books)[0];
        return canonical === undefined ? undefined : resolveLine(books[canonical], line);
    }
    return v;
}

/** The value at a dotted path, line containers collapsed at every step. */
export function at(doc: Json, path: string, line: string): Json | undefined {
    let node: Json | undefined = doc;
    for (const part of path.split(".")) {
        node = resolveLine(node, line);
        if (!isObject(node)) {
            return undefined;
        }
        node = node[part];
    }
    return resolveLine(node, line);
}

/** Name identity: case, punctuation and accents ignored; a trailing `(X)` placeholder is notation. */
export const nameKey = (s: string): string =>
    s
        .replace(/\s*\(\p{Lu}\)\s*$/u, "")
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");

/** Legacy type spellings → the system's declared type. */
const TYPE_ALIASES: Readonly<Record<string, string>> = { "weapon.modification": "weaponModification" };
/** Actor types are keyed per line (`dh2-npc`); the bare kind is the comparison key. */
const LINE_KEYED_ACTOR =
    /^(?:[a-z0-9]+-)?(npc|character|vehicle|terracraft|aircraft|watercraft|voidcraft|starship)$/u;
export const typeKey = (t: string): string => LINE_KEYED_ACTOR.exec(t)?.[1] ?? TYPE_ALIASES[t] ?? t;

/**
 * Leaves not compared: editorial data no page prints as a field (notes, art,
 * variant links, the sheet's own state, house-rule cost columns) and the
 * description, which is scored as text.
 */
export const EXCLUDED: readonly RegExp[] = [
    /^description(\.|$)/u,
    /^notes(\.|$)/u,
    /^img$/u,
    /^variantOf$/u,
    /^state\./u,
    /^cost\.homebrew(\.|$)/u,
    /^modifiers\.testSubstitutions(\.|$)/u,
    /^hire(\.|$)/u,
    /^flags(\.|$)/u,
    /^source\.(book|errata)$/u,
];

/** The mechanically significant leaves per type key; every other compared leaf still counts in the full score. */
export const MECHANICS: Readonly<Record<string, readonly string[]>> = {
    weapon: [
        "class",
        "type",
        "damage.formula",
        "damage.bonus",
        "damage.type",
        "damage.penetration",
        "attack.range.value",
        "attack.rateOfFire.single",
        "attack.rateOfFire.semi",
        "attack.rateOfFire.full",
        "clip.max",
        "reload",
        "special",
        "weight",
        "availability",
        "twoHanded",
        "melee",
    ],
    armour: ["armourPoints", "maxAgility", "weight", "availability", "type", "coverage"],
    gear: ["weight", "availability"],
    ammunition: ["availability", "modifiers", "qualities", "addedQualities", "removedQualities"],
    talent: ["tier", "aptitudes", "prerequisites.text", "prerequisites.characteristics", "cost"],
    trait: ["requirements", "hasLevel", "level"],
    psychicPower: [
        "prCost",
        "cost",
        "focusPower.characteristic",
        "focusPower.modifier",
        "focusPower.opposed",
        "range",
        "sustained",
        "subtype",
        "action",
        "discipline",
        "prerequisites.text",
    ],
    skill: ["characteristic", "skillType", "aptitudes", "isBasic"],
    npc: [
        "characteristics.ws",
        "characteristics.bs",
        "characteristics.s",
        "characteristics.t",
        "characteristics.ag",
        "characteristics.int",
        "characteristics.per",
        "characteristics.wp",
        "characteristics.fel",
        "wounds.max",
        "threatLevel",
        "tier",
        "armourPoints",
        "size",
        "items.weapon",
        "items.trait",
        "items.talent",
        "items.armour",
    ],
    originPath: [
        "step",
        "modifiers.characteristics",
        "grants.aptitudes",
        "grants.woundsFormula",
        "grants.fateThreshold",
    ],
    cybernetic: ["availability", "weight", "type"],
    weaponModification: ["availability", "weight", "restrictions"],
    terracraft: [
        "armour.front.value",
        "armour.side.value",
        "armour.rear.value",
        "speed.cruising",
        "speed.tactical",
        "manoeuverability",
        "size",
        "integrity.max",
        "crew.required",
    ],
};

/** Strings agree ignoring case, dash glyphs and whitespace runs; numeric strings equal numbers. */
function normScalar(v: Json): string {
    if (typeof v === "number") {
        return String(v);
    }
    if (typeof v === "string") {
        const s = v
            .replace(/[‐-―−]/gu, "-")
            .replace(/\s+/gu, " ")
            .trim()
            .toLowerCase();
        return /^-?\d+(?:\.\d+)?$/u.test(s) ? String(Number(s)) : s;
    }
    return JSON.stringify(sortKeys(v));
}

function sortKeys(v: Json): Json {
    if (Array.isArray(v)) {
        return v.map(sortKeys);
    }
    if (isObject(v)) {
        return Object.fromEntries(
            Object.keys(v)
                .sort()
                .map((k) => [k, sortKeys(v[k] ?? null)]),
        );
    }
    return v;
}

/** A value the schema's initial value stands in for when a document leaves it out. */
export function isEmptyValue(v: Json | undefined): boolean {
    return (
        v === undefined ||
        v === null ||
        v === "" ||
        v === 0 ||
        v === false ||
        (Array.isArray(v) && v.length === 0) ||
        (isObject(v) && Object.keys(v).length === 0)
    );
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size === 0 && sb.size === 0) {
        return 1;
    }
    let inter = 0;
    for (const x of sa) {
        if (sb.has(x)) {
            inter += 1;
        }
    }
    return inter / (sa.size + sb.size - inter);
}

/** Agreement of one leaf, 0..1. */
export function leafScore(want: Json | undefined, got: Json | undefined): number {
    if (isEmptyValue(want) && isEmptyValue(got)) {
        return 1;
    }
    if (Array.isArray(want) || Array.isArray(got)) {
        const a = Array.isArray(want) ? want : want === undefined || want === null ? [] : [want];
        const b = Array.isArray(got) ? got : got === undefined || got === null ? [] : [got];
        return jaccard(a.map(normScalar), b.map(normScalar));
    }
    if (want === undefined || got === undefined) {
        return 0;
    }
    return normScalar(want) === normScalar(got) ? 1 : 0;
}

/** Every compared leaf under a document's `system`, keyed by dotted path (line containers collapsed). */
export function leaves(system: Json | undefined, line: string): Map<string, Json> {
    const out = new Map<string, Json>();
    const walk = (node: Json | undefined, path: string): void => {
        const v = resolveLine(node, line);
        if (v === undefined) {
            return;
        }
        if (path !== "" && EXCLUDED.some((re) => re.test(path))) {
            return;
        }
        if (isObject(v) && Object.keys(v).length > 0) {
            for (const k of Object.keys(v).sort()) {
                walk(v[k], path === "" ? k : `${path}.${k}`);
            }
            return;
        }
        if (path !== "") {
            out.set(path, v);
        }
    };
    walk(system, "");
    return out;
}

/** Embedded item name keys by item type; a trailing plural "s" is dropped so "Rags" names "Rag". */
export function embeddedByType(doc: Doc): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const items = doc["items"];
    if (!Array.isArray(items)) {
        return out;
    }
    for (const item of items) {
        if (!isObject(item)) {
            continue;
        }
        const type = typeKey(String(item["type"] ?? ""));
        const key = nameKey(String(item["name"] ?? "")).replace(/s$/u, "");
        const list = out.get(type) ?? [];
        list.push(key);
        out.set(type, list);
    }
    return out;
}

/** Plain text of a document's description for the line. */
export function descriptionText(doc: Doc, line: string): string {
    const v = at(doc, "system.description.value", line);
    return typeof v === "string" ? markdownToText(v) : "";
}

export interface FieldStat {
    checks: number;
    score: number;
}

export interface TypeReport {
    reference: number;
    output: number;
    matched: number;
    /** Reference documents found only under another type. */
    misTyped: string[];
    missing: string[];
    extra: string[];
    docScore: number;
    mechanicsScore: number;
    descriptionF1: { sum: number; n: number };
    fields: Record<string, FieldStat>;
    /** Per-document mismatch notes for matched documents (field, want, got). */
    mismatches: { name: string; field: string; want: string; got: string }[];
}

export interface BookReport {
    reference: number;
    output: number;
    matched: number;
    score: number;
    mechanicsScore: number;
    types: Record<string, TypeReport>;
}

const PRINTED_PREFIXES = ["", "the", "typical"] as const;
const PRINTED_SUFFIXES = ["", "s", "es"] as const;

/** Candidate output keys a reference key may be printed as, in preference order. */
function printedForms(type: string, name: string): string[] {
    const forms: string[] = [`${type}:${name}`];
    const singulars = PRINTED_SUFFIXES.filter((s) => s !== "" && name.endsWith(s)).map((s) =>
        name.slice(0, -s.length),
    );
    for (const base of [name, ...singulars]) {
        for (const prefix of PRINTED_PREFIXES) {
            for (const suffix of base === name ? PRINTED_SUFFIXES : [""]) {
                forms.push(`${type}:${prefix}${base}${suffix}`);
            }
        }
    }
    return [...new Set(forms)];
}

function keyed(docs: readonly Doc[]): Map<string, Doc> {
    const m = new Map<string, Doc>();
    for (const doc of docs) {
        const key = `${typeKey(String(doc["type"] ?? ""))}:${nameKey(String(doc["name"] ?? ""))}`;
        if (!m.has(key)) {
            m.set(key, doc);
        }
    }
    return m;
}

const emptyType = (): TypeReport => ({
    reference: 0,
    output: 0,
    matched: 0,
    misTyped: [],
    missing: [],
    extra: [],
    docScore: 0,
    mechanicsScore: 0,
    descriptionF1: { sum: 0, n: 0 },
    fields: {},
    mismatches: [],
});

const show = (v: Json | undefined): string => (v === undefined ? "∅" : JSON.stringify(v));

/** Score one book's output documents against its reference documents for `line`. */
export function scoreBook(reference: readonly Doc[], output: readonly Doc[], line: string): BookReport {
    const ref = keyed(reference);
    const out = keyed(output);
    const byName = new Map<string, string>();
    for (const key of out.keys()) {
        const name = key.slice(key.indexOf(":") + 1);
        if (!byName.has(name)) {
            byName.set(name, key);
        }
    }
    const types: Record<string, TypeReport> = {};
    const bucket = (t: string): TypeReport => {
        const existing = types[t];
        if (existing !== undefined) {
            return existing;
        }
        const fresh = emptyType();
        types[t] = fresh;
        return fresh;
    };
    const used = new Set<string>();
    let total = 0;
    let mechTotal = 0;
    for (const [key, want] of ref) {
        const type = key.slice(0, key.indexOf(":"));
        const name = key.slice(key.indexOf(":") + 1);
        const r = bucket(type);
        r.reference += 1;
        const outKey = printedForms(type, name).find(
            (k) => out.has(k) && (k === key || !ref.has(k)) && !used.has(k),
        );
        const got = outKey === undefined ? undefined : out.get(outKey);
        if (outKey === undefined || got === undefined) {
            const other = byName.get(name);
            (other !== undefined ? r.misTyped : r.missing).push(
                other !== undefined
                    ? `${String(want["name"])} → ${other.slice(0, other.indexOf(":"))}`
                    : String(want["name"]),
            );
            continue;
        }
        used.add(outKey);
        r.matched += 1;
        const wantLeaves = leaves(want["system"], line);
        const gotLeaves = leaves(got["system"], line);
        const scores = new Map<string, number>();
        for (const [path, value] of wantLeaves) {
            const s = leafScore(value, gotLeaves.get(path));
            scores.set(path, s);
            if (s < 1) {
                r.mismatches.push({
                    name: String(want["name"]),
                    field: path,
                    want: show(value),
                    got: show(gotLeaves.get(path)),
                });
            }
        }
        const wantItems = embeddedByType(want);
        const gotItems = embeddedByType(got);
        for (const [itemType, names] of wantItems) {
            const s = jaccard(names, gotItems.get(itemType) ?? []);
            scores.set(`items.${itemType}`, s);
            if (s < 1) {
                r.mismatches.push({
                    name: String(want["name"]),
                    field: `items.${itemType}`,
                    want: names.join(","),
                    got: (gotItems.get(itemType) ?? []).join(","),
                });
            }
        }
        for (const [path, s] of scores) {
            const f = r.fields[path] ?? { checks: 0, score: 0 };
            f.checks += 1;
            f.score += s;
            r.fields[path] = f;
        }
        const all = [...scores.values()];
        const docScore = all.length === 0 ? 1 : all.reduce((a, b) => a + b, 0) / all.length;
        const mech = (MECHANICS[type] ?? []).filter((p) => scores.has(p));
        const mechScore =
            mech.length === 0 ? docScore : mech.reduce((a, p) => a + (scores.get(p) ?? 0), 0) / mech.length;
        r.docScore += docScore;
        r.mechanicsScore += mechScore;
        const wantText = descriptionText(want, line);
        if (wantText.trim() !== "") {
            r.descriptionF1.sum += f1(
                scoreBag(tokens(descriptionText(got, line), false), tokens(wantText, false)),
            ).f1;
            r.descriptionF1.n += 1;
        }
    }
    for (const [key, doc] of out) {
        const r = bucket(key.slice(0, key.indexOf(":")));
        r.output += 1;
        if (!used.has(key)) {
            r.extra.push(String(doc["name"]));
        }
    }
    let matched = 0;
    for (const r of Object.values(types)) {
        total += r.docScore;
        mechTotal += r.mechanicsScore;
        matched += r.matched;
        r.docScore = r.reference === 0 ? 0 : r.docScore / r.reference;
        r.mechanicsScore = r.reference === 0 ? 0 : r.mechanicsScore / r.reference;
    }
    return {
        reference: ref.size,
        output: out.size,
        matched,
        score: ref.size === 0 ? 0 : total / ref.size,
        mechanicsScore: ref.size === 0 ? 0 : mechTotal / ref.size,
        types,
    };
}

/** Whether a reference document is a RAW citation of `book` for `line`. */
export function citesBook(doc: Doc, line: string, book: string): boolean {
    const s = at(doc, "system.source", line);
    return isObject(s) && s["provenance"] === "raw" && s["book"] === book;
}
