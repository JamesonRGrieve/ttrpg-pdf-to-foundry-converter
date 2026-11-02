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
 *   data a converter cannot read off a page) are not compared. `gameSystems`
 *   is compared as one PDF can know it (`knowableLines`).
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

/**
 * Legacy keys the system's schema no longer has and drops on load, with no
 * migration (`<type key>:<leaf path>`): a document holding them carries them nowhere.
 */
export const NOT_IN_SCHEMA: ReadonlySet<string> = new Set([
    "psychicPower:action",
    "psychicPower:focusTime",
    "psychicPower:opposed",
    "psychicPower:threshold",
    // A legacy statblock text the NPC schema has no field for (its talents are embedded items).
    "npc:talents_traits",
    // Legacy order flags the order schema never declared (Foundry strips them on load).
    "order:shipAction",
    "order:manoeuvreAction",
    "order:skill",
    // Legacy flat navigator-power keys; the schema holds `levels.<level>.effect`, `test`, `sustain`.
    "navigatorPower:novice",
    "navigatorPower:adept",
    "navigatorPower:master",
    "navigatorPower:useTime",
    "navigatorPower:range",
    "navigatorPower:duration",
    "navigatorPower:rollConfig",
]);

/** Armour-point tokens of a legacy stat-block line → the schema's hit locations. */
const AP_TOKENS: Readonly<Record<string, string>> = {
    h: "head",
    b: "body",
    al: "leftArm",
    ar: "rightArm",
    ll: "leftLeg",
    lr: "rightLeg",
};

/**
 * A document's `system` as the system loads it: the legacy NPC `move` and
 * `armourPoints` strings become the structured `movement` and `armour` the
 * system's own migrations make of them (npc-import-migration `migrateMove`,
 * `migrateArmourPoints`). Other legacy shapes are left as they are.
 */
export function asLoaded(type: string, system: Json | undefined): Json | undefined {
    if (type !== "npc" || !isObject(system)) {
        return system;
    }
    const { move, armourPoints: ap, ...rest } = system;
    const out: { [k: string]: Json } = rest;
    // A legacy string the migrations read is consumed; any other value stays.
    if (move !== undefined && !(typeof move === "string" && move.trim() !== "")) {
        out["move"] = move;
    }
    if (ap !== undefined && !(typeof ap === "string" && ap.trim() !== "")) {
        out["armourPoints"] = ap;
    }
    if (typeof move === "string" && move.trim() !== "") {
        const parts = move.split("/").map((p) => Number.parseInt(p.trim(), 10));
        if (parts.length >= 4 && parts.every((n) => !Number.isNaN(n))) {
            out["movement"] = {
                half: parts[0] ?? 0,
                full: parts[1] ?? 0,
                charge: parts[2] ?? 0,
                run: parts[3] ?? 0,
            };
            out["movementManual"] = true;
        }
    }
    if (typeof ap === "string" && ap.trim() !== "") {
        const locations: { [k: string]: Json } = {
            head: 0,
            body: 0,
            leftArm: 0,
            rightArm: 0,
            leftLeg: 0,
            rightLeg: 0,
        };
        let found = false;
        for (const m of ap.matchAll(/\b(AR|AL|LR|LL|H|B)\s*(\d+)/giu)) {
            const location = AP_TOKENS[(m[1] ?? "").toLowerCase()];
            if (location !== undefined) {
                locations[location] = Number(m[2]);
                found = true;
            }
        }
        out["armour"] = found
            ? { mode: "locations", total: locations["body"] ?? 0, authored: true, locations }
            : { authored: true };
    }
    return out;
}

/**
 * Non-empty initial values the system's schema gives a leaf an output document
 * leaves out (`<type key>:<path>`): on import the leaf holds this value.
 */
export const SCHEMA_INITIAL: Readonly<Record<string, Json>> = {
    "weapon:type": "primitive",
    "trait:category": "general",
    "gear:category": "general",
    "talent:rank": 1,
    "talent:isPassive": true,
    "psychicPower:activation.type": "action",
    "psychicPower:activation.cost": 1,
    "psychicPower:target.type": "self",
    "psychicPower:discipline": "telepathy",
    "psychicPower:prCost": 1,
    "npc:size": 4,
    "npc:weapons.mode": "simple",
    "npc:armour.mode": "simple",
    "skill:skillType": "basic",
    "mutation:category": "minor",
    "mutation:visible": true,
    "order:category": "combat",
    "navigatorPower:mastery": "novice",
    "shipComponent:componentType": "essential",
    "shipComponent:availability": "common",
    "shipComponent:condition": "functional",
    "shipComponent:hullType": ["all"],
    // The damage template's type, on every item type carrying it.
    "weapon:damage.type": "impact",
    "ammunition:damage.type": "impact",
    "psychicPower:damage.type": "impact",
    "weapon:class": "melee",
    "armour:type": "flak",
    "cybernetic:type": "replacement",
    "weaponModification:category": "accessory",
    "condition:nature": "harmful",
    "condition:appliesTo": "self",
    "condition:duration.units": "permanent",
    "condition:stacks": 1,
    "mentalDisorder:severity": "minor",
    "ritual:type": "prayer",
    "ritual:test.characteristic": "willpower",
    "order:actionType": "extended-action",
    "order:test.skill": "command",
    "skill:characteristic": "intelligence",
    "medal:honourType": "regimental",
    "criticalInjury:damageType": "impact",
    "criticalInjury:bodyPart": "body",
    "criticalInjury:severity": 1,
    "navigatorPower:test.characteristic": "perception",
    "shipWeapon:weaponType": "macrobattery",
    "shipWeapon:location": "dorsal",
    "shipWeapon:availability": "common",
    // The physical-item template's rarity, on every item type carrying it.
    "weapon:availability": "common",
    "armour:availability": "common",
    "gear:availability": "common",
    "ammunition:availability": "common",
    "cybernetic:availability": "common",
    "forceField:availability": "common",
    "weaponModification:availability": "common",
    "armourModification:availability": "common",
    "backpack:availability": "common",
    "armour:modificationSlots": 2,
    "terracraft:type": "vehicle",
};

/**
 * The mechanically significant leaves per type key (a path names its leaf or
 * every leaf beneath it); every other compared leaf still counts in the full score.
 */
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
        "activation.type",
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
        "armour.locations",
        "movement",
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
    return JSON.stringify(sortKeys(withoutLinks(v)));
}

/**
 * A structured member without its `uuid` link keys: a link names a document
 * of the reference's own packs, which a conversion of one PDF never knows; the
 * member's printed fields (name, specialisation, rank) are what agree or not.
 */
export function withoutLinks(v: Json): Json {
    if (Array.isArray(v)) {
        return v.map(withoutLinks);
    }
    if (isObject(v)) {
        return Object.fromEntries(
            Object.entries(v)
                .filter(([k]) => k !== "uuid")
                .map(([k, x]) => [k, withoutLinks(x ?? null)]),
        );
    }
    return v;
}

/** A document link into the reference's own packs ("Compendium.<system>.<pack>.<type>.<id>"). */
const COMPENDIUM_LINK = /^Compendium\./u;

/**
 * A leaf holding nothing but links into the reference's own packs (a `requires`
 * list, a `talentsUuid` list): which documents of those packs it names is
 * what a conversion of one PDF never knows, so the leaf is not compared.
 */
export function isLinksOnly(v: Json | undefined): boolean {
    return (
        (typeof v === "string" && COMPENDIUM_LINK.test(v)) ||
        (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && COMPENDIUM_LINK.test(x)))
    );
}

/**
 * The reference's `gameSystems` as far as a conversion of one PDF can know it:
 * the book's own line (printed there, so RAW), and any other line only where
 * the output names it too. The reference also lists the other lines that print
 * the document RAW (and, for actors, lines it was ported to by hand); which
 * other books print it is what one PDF never shows.
 */
export function knowableLines(want: Json, got: Json | undefined, line: string): Json {
    if (!Array.isArray(want)) {
        return want;
    }
    const named = new Set((Array.isArray(got) ? got : []).map(String));
    return want.filter((l) => String(l) === line || named.has(String(l)));
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
    if (isProse(want) && typeof got === "string") {
        return f1(scoreBag(tokens(markdownToText(got), false), tokens(markdownToText(want), false))).f1;
    }
    return normScalar(want) === normScalar(got) ? 1 : 0;
}

/** Fewest words a plain string needs to be scored as prose. */
const PROSE_WORDS = 8;

/** Rules text (HTML, or a string of several words) is scored by word overlap, not exact identity. */
function isProse(v: Json): v is string {
    return typeof v === "string" && (/<p>/u.test(v) || v.trim().split(/\s+/u).length >= PROSE_WORDS);
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
    /** Matched documents per match tier. */
    tiers: Partial<Record<MatchTier, number>>;
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
    tiers: {},
});

/**
 * How a reference document found its output document, strictest first:
 * - `exact`: the same name key, or a printed plural / article form of it;
 * - `qualifier`: equal once bracketed and parenthesised qualifiers are dropped
 *   from both names (an editor's disambiguator such as a mount or a
 *   craftsmanship tag, or a printed profile label);
 * - `words`: the same words of two or more in another order (an editor's
 *   "Kind: Subject" form of a caption printed "Subject Kind");
 * - `suffix`: the reference name ends with the whole output name (an editor's
 *   prefix such as a faction); the output name must be one candidate only;
 * - `fuzzy`: name keys within a small edit distance (a misread name).
 */
export type MatchTier = "exact" | "qualifier" | "words" | "suffix" | "fuzzy";

/** Levenshtein distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) {
        return max + 1;
    }
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j += 1) {
            const v = Math.min(
                (prev[j] ?? 0) + 1,
                (cur[j - 1] ?? 0) + 1,
                (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            cur.push(v);
            rowMin = Math.min(rowMin, v);
        }
        if (rowMin > max) {
            return max + 1;
        }
        prev = cur;
    }
    return prev[b.length] ?? max + 1;
}

/** A name's words, sorted: the same words in another order name one thing. */
const wordBag = (name: string): string =>
    name
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w !== "")
        .sort()
        .join(" ");

const unqualified = (name: string): string =>
    nameKey(name.replace(/\([^)]*\)?|\[[^\]]*\]?/gu, " ").replace(/\s+/gu, " "));

/** One-to-one matching of reference keys to output keys, tier by tier. */
export function matchDocuments(
    ref: ReadonlyMap<string, Doc>,
    out: ReadonlyMap<string, Doc>,
    used: Set<string>,
): Map<string, { key: string; tier: MatchTier }> {
    const result = new Map<string, { key: string; tier: MatchTier }>();
    const typeOf = (k: string): string => k.slice(0, k.indexOf(":"));
    const nameOf = (k: string): string => k.slice(k.indexOf(":") + 1);
    const take = (refKey: string, outKey: string, tier: MatchTier): void => {
        result.set(refKey, { key: outKey, tier });
        used.add(outKey);
    };
    for (const key of ref.keys()) {
        const hit = printedForms(typeOf(key), nameOf(key)).find(
            (k) => out.has(k) && (k === key || !ref.has(k)) && !used.has(k),
        );
        if (hit !== undefined) {
            take(key, hit, "exact");
        }
    }
    const pending = (): string[] => [...ref.keys()].filter((k) => !result.has(k));
    const free = (type: string): string[] =>
        [...out.keys()].filter((k) => typeOf(k) === type && !used.has(k));
    for (const key of pending()) {
        const want = unqualified(String(ref.get(key)?.["name"] ?? ""));
        if (want === "") {
            continue;
        }
        const hit = free(typeOf(key)).find((k) => unqualified(String(out.get(k)?.["name"] ?? "")) === want);
        if (hit !== undefined) {
            take(key, hit, "qualifier");
        }
    }
    for (const key of pending()) {
        const want = wordBag(String(ref.get(key)?.["name"] ?? ""));
        const hit = free(typeOf(key)).find((k) => wordBag(String(out.get(k)?.["name"] ?? "")) === want);
        if (want.includes(" ") && hit !== undefined) {
            take(key, hit, "words");
        }
    }
    for (const key of pending()) {
        const want = nameKey(String(ref.get(key)?.["name"] ?? ""));
        const hits = free(typeOf(key)).filter((k) => {
            const got = nameOf(k);
            return got.length >= 4 && got !== want && want.endsWith(got);
        });
        const only = hits[0];
        if (hits.length === 1 && only !== undefined) {
            take(key, only, "suffix");
        }
    }
    for (const key of pending()) {
        const want = nameOf(key);
        if (want.length < 6) {
            continue;
        }
        const max = want.length >= 12 ? 3 : 2;
        let best: string | undefined;
        let bestD = max + 1;
        let tie = false;
        for (const k of free(typeOf(key))) {
            const d = editDistance(want, nameOf(k), max);
            if (d < bestD) {
                best = k;
                bestD = d;
                tie = false;
            } else if (d === bestD) {
                tie = true;
            }
        }
        if (best !== undefined && !tie) {
            take(key, best, "fuzzy");
        }
    }
    return result;
}

const show = (v: Json | undefined): string => (v === undefined ? "∅" : JSON.stringify(v));

/** A document's `system` as the system loads it, for a type key. */
export type Loader = (type: string, system: Json | undefined) => Json | undefined;

/**
 * Score one book's output documents against its reference documents for
 * `line`. `load` reads each side's `system` as the system loads it (default:
 * the built-in `asLoaded`; the runner passes the system's own migrations when
 * it can import them).
 */
export function scoreBook(
    reference: readonly Doc[],
    output: readonly Doc[],
    line: string,
    load: Loader = asLoaded,
): BookReport {
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
    const matchOf = matchDocuments(ref, out, used);
    let total = 0;
    let mechTotal = 0;
    for (const [key, want] of ref) {
        const type = key.slice(0, key.indexOf(":"));
        const name = key.slice(key.indexOf(":") + 1);
        const r = bucket(type);
        r.reference += 1;
        const match = matchOf.get(key);
        const outKey = match?.key;
        const got = outKey === undefined ? undefined : out.get(outKey);
        if (match === undefined || outKey === undefined || got === undefined) {
            const other = byName.get(name);
            (other !== undefined ? r.misTyped : r.missing).push(
                other !== undefined
                    ? `${String(want["name"])} → ${other.slice(0, other.indexOf(":"))}`
                    : String(want["name"]),
            );
            continue;
        }
        r.matched += 1;
        r.tiers[match.tier] = (r.tiers[match.tier] ?? 0) + 1;
        const wantLeaves = leaves(load(type, want["system"]), line);
        const gotLeaves = leaves(load(type, got["system"]), line);
        for (const path of [...wantLeaves.keys()]) {
            const segments = path.split(".");
            if (
                segments.some((_, i) => NOT_IN_SCHEMA.has(`${type}:${segments.slice(0, i + 1).join(".")}`)) ||
                isLinksOnly(wantLeaves.get(path))
            ) {
                wantLeaves.delete(path);
            }
        }
        const scores = new Map<string, number>();
        // A name matched only by spelling distance is a misread name: it costs one leaf.
        scores.set("name", match.tier === "fuzzy" ? 0 : 1);
        if (match.tier === "fuzzy") {
            r.mismatches.push({
                name: String(want["name"]),
                field: "name",
                want: show(want["name"]),
                got: show(got["name"]),
            });
        }
        for (const [path, authored] of wantLeaves) {
            const gotValue = gotLeaves.get(path) ?? SCHEMA_INITIAL[`${type}:${path}`];
            const value = path === "gameSystems" ? knowableLines(authored, gotValue, line) : authored;
            const s = leafScore(value, gotValue);
            scores.set(path, s);
            if (s < 1) {
                r.mismatches.push({
                    name: String(want["name"]),
                    field: path,
                    want: show(value),
                    got: show(gotValue),
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
        // A listed path names its leaf, or every leaf beneath it.
        const listed = MECHANICS[type] ?? [];
        const mech = [...scores.keys()].filter((leaf) =>
            listed.some((p) => leaf === p || leaf.startsWith(`${p}.`)),
        );
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
