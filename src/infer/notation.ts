// SPDX-License-Identifier: AGPL-3.0-or-later
import { CONTROL_RANGES, NOTE_MARKERS, numberPoint } from "../util/text.ts";
import { ALL_HULLS, HULL_TYPES, SHIP_WEAPON_TYPES } from "./schema.ts";

/**
 * Parsers for the generic d100 stat notation printed in stat tables — dice
 * expressions, damage-type letters, rate-of-fire triples, reload actions,
 * weights, armour points by location — mapped onto the Foundry system's enums.
 * Pure functions: text in, typed value (or null when the cell is not that
 * notation) out.
 */

const DASHES = /[–—−]/gu;
/** Cell text meaning "no value". */
const EMPTY = /^(?:[-–—]|n\/?a|none)?$/iu;

/** Control characters a text layer can leave between a cell's glyphs. */
const CONTROLS = new RegExp(`[${CONTROL_RANGES}]`, "gu");
/** A glyph the text layer could not encode, set just before a digit. */
const UNREADABLE_BEFORE_DIGIT = /�(?=\d)/gu;

/**
 * A cell's notation as plain text: note markers dropped, dashes unified,
 * control characters read as spaces, and an unreadable glyph just before a
 * digit read as the number's point (see `numberPoint`).
 */
function clean(raw: string): string {
    return raw
        .replace(NOTE_MARKERS, "")
        .replace(DASHES, "-")
        .replace(CONTROLS, " ")
        .replace(
            UNREADABLE_BEFORE_DIGIT,
            (_glyph, offset: number, whole: string) =>
                numberPoint(whole.slice(0, offset), whole.slice(offset + 1)) ?? "",
        )
        .replace(/\s+/gu, " ")
        .trim();
}

export function isEmptyCell(raw: string): boolean {
    return EMPTY.test(clean(raw));
}

/** Damage-type letter → the system's `damageTypes` key. */
const DAMAGE_TYPES: Readonly<Record<string, string>> = {
    e: "energy",
    x: "explosive",
    i: "impact",
    r: "rending",
};

export interface Damage {
    formula: string;
    bonus: number;
    type: string;
}

/**
 * `2d10+3 I`, `1d10 (E)`, `1d5+SB R` → dice formula, flat bonus, damage type.
 * A bonus may follow the type letter (`1d10 I+1`), and a flat number with a
 * type letter (`0 I`) is a damage of that number with no dice.
 */
export function parseDamage(raw: string): Damage | null {
    // A misread "1" in the die size ("1dl0") is a recognition artifact, not
    // notation; so is a type letter I read as "1", "l" or "|" when it stands
    // apart at the end ("1d10+2 1"), where a bonus digit would not.
    const text = clean(raw)
        .replace(/(\d*)d[lI](\d)/gu, "$1d1$2")
        .replace(/\s+[1l|]\s*$/u, " I");
    const m =
        /^(?<formula>\d*d\d+)\s*(?:(?<sign>[+-])\s*(?<bonus>\d+))?\s*(?:\+?\s*SB)?\s*\(?(?<type>[EXIR])?\)?(?:\s*(?<lateSign>[+-])\s*(?<lateBonus>\d+))?$/iu.exec(
            text,
        ) ?? /^(?<formula>\d+)\s*\(?(?<type>[EXIR])\)?$/iu.exec(text);
    const formula = m?.groups?.["formula"];
    if (formula === undefined) {
        return null;
    }
    const { sign, bonus, type, lateSign, lateBonus } = m?.groups ?? {};
    const signed = (s: string | undefined, n: string | undefined): number =>
        n === undefined ? 0 : (s === "-" ? -1 : 1) * Number(n);
    return {
        formula: formula.toLowerCase(),
        bonus: signed(sign, bonus) + signed(lateSign, lateBonus),
        type: DAMAGE_TYPES[(type ?? "").toLowerCase()] ?? "",
    };
}

export interface Range {
    value: number;
    units: "m" | "km";
    /** Strength-bonus multiple for thrown ranges (`SBx3`), else "". */
    special: string;
}

export function parseRange(raw: string): Range | null {
    const text = clean(raw);
    const sb = /^(?:SB\s*[x×]\s*(?<after>\d+)|(?<before>\d+)\s*[x×]\s*SB)\s*m?$/iu.exec(text)?.groups;
    const multiple = sb?.["after"] ?? sb?.["before"];
    if (multiple !== undefined) {
        return { value: 0, units: "m", special: `SBx${multiple}` };
    }
    // Thousands may be grouped with commas ("3,500m").
    const m = /^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(m|km|metres?|meters?|kilometres?)?$/iu.exec(text);
    if (m === null) {
        return null;
    }
    const units = (m[2] ?? "m").toLowerCase().startsWith("k") ? "km" : "m";
    return { value: Number((m[1] ?? "").replace(/,/gu, "")), units, special: "" };
}

export interface RateOfFire {
    single: boolean;
    semi: number;
    full: number;
}

/** `S/3/-`, `-/-/10`, `S/-/-` → modes. */
export function parseRateOfFire(raw: string): RateOfFire | null {
    const parts = clean(raw)
        .split("/")
        .map((p) => p.trim());
    const [singleMode, semiMode, fullMode] = parts;
    if (
        parts.length !== 3 ||
        singleMode === undefined ||
        semiMode === undefined ||
        fullMode === undefined ||
        !/^[sS-]$/u.test(singleMode)
    ) {
        return null;
    }
    // An empty mode field, like a dash, means the weapon has no such mode.
    const count = (p: string): number | null =>
        p === "-" || p === "" ? 0 : /^\d+$/u.test(p) ? Number(p) : null;
    const semi = count(semiMode);
    const full = count(fullMode);
    if (semi === null || full === null) {
        return null;
    }
    return { single: singleMode.toLowerCase() === "s", semi, full };
}

/**
 * `Full`, `2 Full`, `Half`, `3Full` → the system's reload keys (`full`,
 * `2-full`, `half`, `-`). The column's own label set before the value
 * (`Rld 5 Full`) is not part of it.
 */
export function parseReload(raw: string): string | null {
    const text = clean(raw).replace(/^(?:rld|reload)\b:?\s*/iu, "");
    if (isEmptyCell(text)) {
        return "-";
    }
    const groups = /^(?<count>\d*)\s*-?\s*(?<unit>full|half|free)\b/iu.exec(text)?.groups;
    const unit = groups?.["unit"]?.toLowerCase();
    if (unit === undefined) {
        return null;
    }
    const count = groups?.["count"] ?? "";
    return count === "" || count === "1" ? unit : `${count}-${unit}`;
}

/** `15kg`, `1.5 kg`, `.5kg`, `-` → kilograms (0 for none). */
export function parseWeight(raw: string): number | null {
    const text = clean(raw);
    if (isEmptyCell(text)) {
        return 0;
    }
    const m = /^\+?(\d+(?:\.\d+)?|\.\d+)\s*(?:kg)?$/iu.exec(text);
    return m === null ? null : Number(m[1]);
}

export function parseInteger(raw: string): number | null {
    const text = clean(raw);
    if (isEmptyCell(text)) {
        return 0;
    }
    return /^[+-]?\d+$/u.test(text) ? Number(text) : null;
}

/**
 * A ship component's power cell: a plain number is power it draws, a signed
 * one ("+40") power it makes.
 */
export function parseShipPower(raw: string): { used: number; generated: number } | null {
    const text = clean(raw);
    if (isEmptyCell(text)) {
        return { used: 0, generated: 0 };
    }
    const m = /^(\+)?(\d+)$/u.exec(text);
    if (m === null) {
        return null;
    }
    const value = Number(m[2]);
    return m[1] === "+" ? { used: 0, generated: value } : { used: value, generated: 0 };
}

const HULL_TYPE_SET: ReadonlySet<string> = new Set(HULL_TYPES);

/**
 * Hull types as printed ("Raiders, Frigates", "Light Cruisers, Cruisers",
 * "All Ships") → the schema's hull type choices; null when a named type is not one.
 */
export function parseHullTypes(raw: string): string[] | null {
    const text = clean(raw).toLowerCase();
    if (/^all\b/u.test(text)) {
        return [ALL_HULLS];
    }
    const types = text
        .split(/,|\band\b/u)
        .map((t) => t.trim().replace(/s$/u, "").replace(/\s+/gu, "-"))
        .filter((t) => t.length > 0);
    return types.length > 0 && types.every((t) => HULL_TYPE_SET.has(t)) ? types : null;
}

const SHIP_WEAPON_TYPE_SET: ReadonlySet<string> = new Set(SHIP_WEAPON_TYPES);

/**
 * A ship weapon type as printed, singular or plural, perhaps followed by the
 * mounting ("Macrobatteries", "Nova Cannons", "Torpedo Tubes") → the schema's
 * weapon type named by its longest leading run of words; null when none is one.
 */
export function parseShipWeaponType(raw: string): string | null {
    const words = clean(raw).toLowerCase().split(/\s+/u);
    for (let n = words.length; n > 0; n--) {
        const lead = words.slice(0, n);
        const last = (lead.pop() ?? "").replace(/ies$/u, "y").replace(/oes$/u, "o").replace(/s$/u, "");
        const type = [...lead, last].join("-");
        if (SHIP_WEAPON_TYPE_SET.has(type)) {
            return type;
        }
    }
    return null;
}

/** One hull type as printed ("Light Cruisers", "Frigate") → the schema's choice; null when it is not one. */
export function parseHullType(raw: string): string | null {
    const [type, ...rest] = parseHullTypes(raw) ?? [];
    return type !== undefined && type !== ALL_HULLS && rest.length === 0 ? type : null;
}

/** A qualities-list entry pointing to the weapon's text, not naming a quality. */
const SEE_TEXT = "special";

/**
 * A weapon's special-qualities cell → quality identifiers: lowercased,
 * hyphenated, with a rating folded in (`Spread (3)`, `Toxic [4]` →
 * `spread-3`, `toxic-4`), sorted. A word broken at its hyphen across lines
 * ("Twin- Linked") keeps one hyphen. "Special" in the list is a pointer to the
 * weapon's text, not a quality, and is dropped. A further list joined on with
 * a plus ("Balanced + Accursed, Rampage") is not qualities and is left out.
 */
export function parseQualities(raw: string): string[] {
    const text = clean(raw).split(/\s\+\s(?![^([]*[)\]])/u)[0] ?? "";
    if (isEmptyCell(text)) {
        return [];
    }
    // A rating's closing bracket ends its quality even where the comma after
    // it was left out ("Felling [4] Razor-Sharp").
    return text
        .split(/,(?![^([]*[)\]])|(?<=[)\]])\s+(?=\p{L})/u)
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && !isEmptyCell(q))
        .map((q) =>
            q
                .toLowerCase()
                .replace(/\s*[([]([^)\]]*)[)\]]/gu, (_m, rating: string) => `-${rating.replace(/\s+/gu, "")}`)
                .replace(/\s+/gu, "-")
                .replace(/-{2,}/gu, "-"),
        )
        .filter((q) => q !== SEE_TEXT)
        .sort();
}

/** The system's `availabilities` keys, rarest last. */
export const AVAILABILITY = [
    "ubiquitous",
    "abundant",
    "plentiful",
    "common",
    "average",
    "scarce",
    "rare",
    "very-rare",
    "extremely-rare",
    "near-unique",
    "unique",
    // Printed but unrated: no book gives it a modifier or a place in the scale.
    "uncommon",
] as const;

function initials(key: string): string {
    return key
        .split("-")
        .map((w) => w.charAt(0))
        .join("");
}

/** Does `short` appear in `long` as an in-order subsequence starting at the first letter? */
function isSkeleton(short: string, long: string): boolean {
    if (short.length === 0 || short[0] !== long[0]) {
        return false;
    }
    let k = 0;
    for (const ch of long) {
        if (ch === short[k]) {
            k += 1;
        }
    }
    return k === short.length;
}

/**
 * An availability cell → an `availabilities` key. Printed tables use the full
 * word or an abbreviation; the abbreviation is resolved against the enum by
 * structure alone — exact match, then hyphen-part initials (`VR`), then prefix
 * (`Sc`), then a first-letter-anchored letter skeleton (`Cm`) — taking the
 * first key in enum order that fits. Null when nothing fits.
 */
export function parseAvailability(raw: string): string | null {
    const token = clean(raw)
        .toLowerCase()
        .replace(/\(.*?\)|\/.*$/gu, "")
        .trim()
        .replace(/[\s.]+/gu, "-")
        .replace(/-+$/u, "");
    if (token.length === 0) {
        return null;
    }
    const squashed = token.replace(/-/gu, "");
    const tests: ((key: string) => boolean)[] = [
        (key) => key === token,
        (key) => key.includes("-") && initials(key) === squashed,
        (key) => squashed.length >= 2 && key.replace(/-/gu, "").startsWith(squashed),
        (key) => squashed.length >= 2 && isSkeleton(squashed, key.replace(/-/gu, "")),
    ];
    for (const test of tests) {
        const hit = AVAILABILITY.find(test);
        if (hit !== undefined) {
            return hit;
        }
    }
    return null;
}

/** Hit locations in the system's armour schema. */
export const BODY_LOCATIONS = ["head", "body", "leftArm", "rightArm", "leftLeg", "rightLeg"] as const;
export type BodyLocation = (typeof BODY_LOCATIONS)[number];

const LOCATION_WORDS: Readonly<Record<string, readonly BodyLocation[]>> = {
    all: BODY_LOCATIONS,
    head: ["head"],
    body: ["body"],
    arms: ["leftArm", "rightArm"],
    arm: ["leftArm", "rightArm"],
    legs: ["leftLeg", "rightLeg"],
    leg: ["leftLeg", "rightLeg"],
    "left arm": ["leftArm"],
    "right arm": ["rightArm"],
    "left leg": ["leftLeg"],
    "right leg": ["rightLeg"],
};

/**
 * `Body, Arms`, `All`, `Head` → covered locations, in schema order. A list
 * whose separator was lost ("Body Arms, Legs") reads word by word, a side
 * word ("left") joining the location after it.
 */
export function parseCoverage(raw: string): BodyLocation[] | null {
    const parts = clean(raw)
        .toLowerCase()
        .split(/,|&|\band\b/u)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    if (parts.length === 0) {
        return null;
    }
    const covered = new Set<BodyLocation>();
    for (const part of parts) {
        const hit = LOCATION_WORDS[part] ?? locationsByWord(part);
        if (hit === null) {
            return null;
        }
        for (const loc of hit) {
            covered.add(loc);
        }
    }
    return BODY_LOCATIONS.filter((l) => covered.has(l));
}

/**
 * Locations named word by word in one list item, or null when a word names
 * none. A word may run on into the next: a letter set apart by spacing
 * ("A rms") or a side word ("left arm").
 */
function locationsByWord(part: string): BodyLocation[] | null {
    const words = part.split(/\s+/u);
    const found: BodyLocation[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i] ?? "";
        const next = words[i + 1] ?? "";
        const joined = LOCATION_WORDS[`${word} ${next}`] ?? LOCATION_WORDS[`${word}${next}`];
        const hit = joined ?? LOCATION_WORDS[word];
        if (hit === undefined) {
            return null;
        }
        if (joined !== undefined) {
            i += 1;
        }
        found.push(...hit);
    }
    return found;
}

export interface ArmourPoints {
    /** Points on every covered location. */
    base: number;
    /** Locations printed with their own points ("8 (Body 10)"). */
    exceptions: Partial<Record<BodyLocation, number>>;
}

/**
 * An armour-points cell → its points, with any location printed apart in
 * parentheses: `8`, `8 (Body 10)`, `5 (4 on Head)`. A bare parenthesized
 * number (`3 (6)`) is a points value under some condition the text gives and
 * is left to it. Null when the cell is not that notation.
 */
export function parseArmourPoints(raw: string): ArmourPoints | null {
    const m = /^(\d+)\s*(?:\((.*)\))?$/u.exec(clean(raw));
    if (m === null) {
        return null;
    }
    const exceptions: Partial<Record<BodyLocation, number>> = {};
    const inner = (m[2] ?? "").trim();
    if (inner !== "" && !/^\d+$/u.test(inner)) {
        for (const part of inner.split(/[,;]/u)) {
            const point =
                /^(?:(?<before>\d+)\s+(?:on\s+)?(?<after>[a-z ]+?)|(?<loc>[a-z ]+?)\s+(?<n>\d+))$/iu.exec(
                    part.trim(),
                )?.groups;
            const where = LOCATION_WORDS[(point?.["after"] ?? point?.["loc"] ?? "").toLowerCase()];
            const value = point?.["before"] ?? point?.["n"];
            if (where === undefined || value === undefined) {
                return null;
            }
            for (const loc of where) {
                exceptions[loc] = Number(value);
            }
        }
    }
    return { base: Number(m[1]), exceptions };
}

/** The system's weapon class keys (`placed` is a placed explosive). */
export const WEAPON_CLASSES = [
    "melee",
    "pistol",
    "basic",
    "heavy",
    "thrown",
    "exotic",
    "vehicle",
    "placed",
] as const;
export type WeaponClass = (typeof WEAPON_CLASSES)[number];

/** The system's renown ranks, lowest first. */
export const RENOWN_RANKS = ["initiated", "respected", "distinguished", "famed", "hero"] as const;

/** A renown cell ("Famed") → the system's renown rank; null when it names none. */
export function parseRenown(raw: string): (typeof RENOWN_RANKS)[number] | null {
    const word = clean(raw).toLowerCase();
    return RENOWN_RANKS.find((r) => r === word) ?? null;
}

/** The class words a cell names, in order, each once. */
function classWords(text: string): WeaponClass[] {
    const found: WeaponClass[] = [];
    for (const word of text.split(/[^a-z]+/u)) {
        const hit = WEAPON_CLASSES.find((c) => c === word);
        if (hit !== undefined && !found.includes(hit)) {
            found.push(hit);
        }
    }
    return found;
}

/**
 * The second class of a weapon printed with two, set apart by a slash
 * ("Melee/ Thrown" → `thrown`); null for a weapon of one class.
 */
export function parseSecondaryClass(raw: string): WeaponClass | null {
    const text = clean(raw).toLowerCase();
    if (!text.includes("/")) {
        return null;
    }
    return classWords(text)[1] ?? null;
}

/** Letters a misread class word may be missing. */
const CLASS_LETTERS_LOST = 1;

/**
 * `Basic`, `Pistol/Melee`, `Melee (Two-handed)` → the leading weapon-class
 * key. A cell naming none outright may hold one with a letter lost and the
 * rest split apart ("M lee"): its letters, first anchored, read in order
 * through the class word.
 */
export function parseWeaponClass(raw: string): WeaponClass | null {
    const text = clean(raw).toLowerCase();
    const [first] = classWords(text);
    if (first !== undefined) {
        return first;
    }
    const letters = text.replace(/[^a-z]/gu, "");
    return (
        WEAPON_CLASSES.find(
            (c) =>
                letters.length >= c.length - CLASS_LETTERS_LOST &&
                letters.length < c.length &&
                isSkeleton(letters, c),
        ) ?? null
    );
}
