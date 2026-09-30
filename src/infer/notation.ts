// SPDX-License-Identifier: AGPL-3.0-or-later
import { NOTE_MARKERS } from "../util/text.ts";
import { ALL_HULLS, HULL_TYPES } from "./schema.ts";

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

function clean(raw: string): string {
    return raw.replace(NOTE_MARKERS, "").replace(DASHES, "-").replace(/\s+/gu, " ").trim();
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

/** `2d10+3 I`, `1d10 (E)`, `1d5+SB R` → dice formula, flat bonus, damage type. */
export function parseDamage(raw: string): Damage | null {
    // A misread "1" in the die size ("1dl0") is a recognition artifact, not notation.
    const text = clean(raw).replace(/(\d*)d[lI](\d)/gu, "$1d1$2");
    const m =
        /^(?<formula>\d*d\d+)\s*(?:(?<sign>[+-])\s*(?<bonus>\d+))?\s*(?:\+?\s*SB)?\s*\(?(?<type>[EXIR])?\)?$/iu.exec(
            text,
        );
    const formula = m?.groups?.["formula"];
    if (formula === undefined) {
        return null;
    }
    const { sign, bonus, type } = m?.groups ?? {};
    return {
        formula: formula.toLowerCase(),
        bonus: bonus === undefined ? 0 : (sign === "-" ? -1 : 1) * Number(bonus),
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
    const m = /^(\d+(?:\.\d+)?)\s*(m|km|metres?|meters?|kilometres?)?$/iu.exec(text);
    if (m === null) {
        return null;
    }
    const units = (m[2] ?? "m").toLowerCase().startsWith("k") ? "km" : "m";
    return { value: Number(m[1]), units, special: "" };
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

/** `Full`, `2 Full`, `Half`, `3Full` → the system's reload keys (`full`, `2-full`, `half`, `-`). */
export function parseReload(raw: string): string | null {
    const text = clean(raw);
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

/** `15kg`, `1.5 kg`, `-` → kilograms (0 for none). */
export function parseWeight(raw: string): number | null {
    const text = clean(raw);
    if (isEmptyCell(text)) {
        return 0;
    }
    const m = /^\+?(\d+(?:\.\d+)?)\s*(?:kg)?$/iu.exec(text);
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

/**
 * A weapon's special-qualities cell → quality identifiers: lowercased,
 * hyphenated, with a rating folded in (`Spread (3)` → `spread-3`), sorted.
 */
export function parseQualities(raw: string): string[] {
    const text = clean(raw);
    if (isEmptyCell(text)) {
        return [];
    }
    return text
        .split(/,(?![^(]*\))/u)
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && !isEmptyCell(q))
        .map((q) =>
            q
                .toLowerCase()
                .replace(/\s*\(([^)]*)\)/gu, (_m, rating: string) => `-${rating.replace(/\s+/gu, "")}`)
                .replace(/\s+/gu, "-"),
        )
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

/** `Body, Arms`, `All`, `Head` → covered locations, in schema order. */
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
        const hit = LOCATION_WORDS[part];
        if (hit === undefined) {
            return null;
        }
        for (const loc of hit) {
            covered.add(loc);
        }
    }
    return BODY_LOCATIONS.filter((l) => covered.has(l));
}

/** The system's `weaponClasses` keys. */
export const WEAPON_CLASSES = [
    "melee",
    "pistol",
    "basic",
    "heavy",
    "thrown",
    "exotic",
    "vehicle",
    "mounted",
] as const;

/** `Basic`, `Pistol/Melee`, `Melee (Two-handed)` → the leading weapon-class key. */
export function parseWeaponClass(raw: string): (typeof WEAPON_CLASSES)[number] | null {
    const words = clean(raw)
        .toLowerCase()
        .split(/[^a-z]+/u);
    for (const word of words) {
        const hit = WEAPON_CLASSES.find((c) => c === word);
        if (hit !== undefined) {
            return hit;
        }
    }
    return null;
}
