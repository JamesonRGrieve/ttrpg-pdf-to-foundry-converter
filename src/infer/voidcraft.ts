// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject } from "../types/entity.ts";
import { type LabelPanel, labelPairs, labelPanel } from "./label-panel.ts";
import { parseHullType } from "./notation.ts";

/**
 * A ship profile — a panel of `Label: value` cells naming the schema's
 * voidcraft fields (speed, manoeuvrability, detection, hull integrity, …),
 * with the hull's descriptive header (dimensions, mass, crew, acceleration) —
 * → a voidcraft's `system` fields in the system's authoring shape. Labels are
 * the schema's own field names as printed; unreadable values are reported,
 * never defaulted.
 */

/** The profile's labels: the schema's voidcraft fields as printed. */
const SHIP_LABELS = [
    "speed",
    "manoeuvrability",
    "detection",
    "hull integrity",
    "armour",
    "turret rating",
    "void shields",
    "space",
    "sp",
    "ship points",
    "sp total cost",
    "power",
    "weapon capacity",
    "hull",
    "class",
    "dimensions",
    "mass",
    "crew",
    "crew population",
    "crew rating",
    "morale",
    "accel",
    "acceleration",
] as const;
const PANEL: LabelPanel = labelPanel(SHIP_LABELS);

/** Labels whose presence together marks a ship profile. */
const PROFILE_LABELS = ["speed", "manoeuvrability", "detection", "hull integrity", "turret rating"] as const;

/** The schema's weapon-capacity locations. */
const WEAPON_LOCATIONS = ["dorsal", "prow", "port", "starboard", "keel"] as const;

/**
 * `label → value` pairs of a ship's printed text: every value of its field
 * lines, and of its running text those a following label ends.
 */
export function shipPairs(fields: readonly (readonly [string, string])[], body: string): Map<string, string> {
    const pairs = labelPairs(fields.map(([label, value]) => `${label}: ${value}`).join("\n"), PANEL);
    for (const [label, value] of labelPairs(body, PANEL, true)) {
        if (!pairs.has(label)) {
            pairs.set(label, value);
        }
    }
    return pairs;
}

/** A ship's descriptive header labels, printed above its profile. */
const HEADER_LABELS = ["hull", "class", "dimensions", "mass", "crew", "accel", "acceleration"] as const;
/** Fewest header labels that mark a ship's header. */
const MIN_HEADER_LABELS = 3;

/**
 * Whether labelled text is a ship profile: every profile label carries a
 * number (a rules text explaining each characteristic in prose is none).
 */
export function isShipProfile(pairs: ReadonlyMap<string, string>): boolean {
    return PROFILE_LABELS.every((l) => leadingInt(pairs.get(l) ?? "") !== null);
}

/** Whether labelled text carries a ship's descriptive header. */
export function hasShipHeader(pairs: ReadonlyMap<string, string>): boolean {
    return HEADER_LABELS.filter((l) => pairs.has(l)).length >= MIN_HEADER_LABELS;
}

/** Whether a field label is one of the ship profile's. */
export function isShipLabel(label: string): boolean {
    const text = label.toLowerCase().replace(/\s+/gu, " ").trim();
    return SHIP_LABELS.some((l) => l === text);
}

/**
 * Leading signed integer of a value ("+20", "35 (Used: 35)", "26,000"); a
 * lone dash prints none of the quantity (a station's speed), which is 0.
 */
function leadingInt(text: string): number | null {
    if (/^[-–—]$/u.test(text.trim())) {
        return 0;
    }
    const m = /^([+-]?\d[\d,]*)/u.exec(text.trim());
    return m === null ? null : Number((m[1] ?? "").replace(/,/gu, ""));
}

/** The "Used: N" a capacity value notes in parentheses. */
function usedOf(text: string): number {
    const m = /\(\s*used\s*:?\s*(\d+)\s*\)/iu.exec(text);
    return m === null ? 0 : Number(m[1]);
}

/** One "Location N" / "N Location" part of a weapon capacity list, with its separator. */
const CAPACITY_PART = new RegExp(
    `^\\s*(?:(\\d+)\\s+(${WEAPON_LOCATIONS.join("|")})|(${WEAPON_LOCATIONS.join("|")})\\s+(\\d+))\\b\\s*(?:[,;]|\\band\\b)?`,
    "iu",
);

/**
 * A weapon capacity ("Dorsal 1, Prow 1", "1 Prow, 1 Port") → count per
 * schema location, read from the start of the value; text after the list (a
 * note in parentheses) is not part of it. A dash is no capacity. Null when the
 * value opens with no location and count.
 */
export function parseWeaponCapacity(raw: string): Record<(typeof WEAPON_LOCATIONS)[number], number> | null {
    const capacity = { dorsal: 0, prow: 0, port: 0, starboard: 0, keel: 0 };
    if (/^\s*[-–—]\s*$/u.test(raw)) {
        return capacity;
    }
    let rest = raw;
    let parts = 0;
    for (let m = CAPACITY_PART.exec(rest); m !== null; m = CAPACITY_PART.exec(rest)) {
        const location = (m[2] ?? m[3] ?? "").toLowerCase();
        const key = WEAPON_LOCATIONS.find((l) => l === location);
        if (key !== undefined) {
            capacity[key] += Number(m[1] ?? m[4]);
        }
        parts += 1;
        rest = rest.slice(m[0].length);
    }
    return parts > 0 ? capacity : null;
}

/** The hull type a heading names ("Frigates", "Cruiser Hulls"); null when it names none. */
export function headingHullType(text: string): string | null {
    return parseHullType(text.replace(/\s+hulls?\s*$/iu, ""));
}

/** Lower-case, hyphen-joined words ("Space Station" → "space-station"). */
const slug = (s: string): string =>
    s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/gu, "");

/** Most words a printed hull type runs to. */
const MAX_HULL_WORDS = 3;

/**
 * A printed hull ("Light Cruiser", "Heavy Cruiser", "Space Station") → the
 * schema's hull type: the longest leading run of words ending in one of the
 * component hull choices (a qualifier may lead it), else the whole value as
 * printed when it is short enough to be a hull name (a value running on into
 * prose is not). Null when neither.
 */
export function printedHull(text: string): string | null {
    const words = text.trim().split(/\s+/u);
    for (let n = Math.min(MAX_HULL_WORDS, words.length); n > 0; n--) {
        for (let from = 0; from < n; from++) {
            const type = parseHullType(words.slice(from, n).join(" "));
            if (type !== null) {
                return type;
            }
        }
    }
    return words.length <= MAX_HULL_WORDS ? slug(text) : null;
}

const titleWords = (s: string): string =>
    s
        .toLowerCase()
        .split(/(\s+|-)/u)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");

export interface ParsedShip {
    system: JsonObject;
    unparsed: string[];
}

/**
 * A ship profile → voidcraft `system` fields. `hullHint` is the hull type a
 * section heading above the ship names ("Frigates"), used when the profile
 * prints none of its own.
 */
export function parseShip(pairs: ReadonlyMap<string, string>, hullHint: string | null): ParsedShip {
    const system: JsonObject = {};
    const unparsed: string[] = [];
    const int = (label: string): number | null => {
        const text = pairs.get(label);
        if (text === undefined) {
            return null;
        }
        const value = leadingInt(text);
        if (value === null) {
            unparsed.push(`${label}: ${text}`);
        }
        return value;
    };
    for (const [label, key] of [
        ["speed", "speed"],
        ["manoeuvrability", "manoeuvrability"],
        ["detection", "detection"],
        ["armour", "armour"],
        ["turret rating", "turretRating"],
        ["void shields", "voidShields"],
    ] as const) {
        const value = int(label);
        if (value !== null) {
            system[key] = value;
        }
    }
    const integrity = int("hull integrity");
    if (integrity !== null) {
        system["hullIntegrity"] = { max: integrity, value: integrity };
    }
    const space = int("space");
    if (space !== null) {
        system["space"] = { total: space, used: usedOf(pairs.get("space") ?? "") };
    }
    const power = int("power");
    if (power !== null) {
        system["power"] = { total: power, used: usedOf(pairs.get("power") ?? "") };
    }
    const pointsLabel = ["sp", "ship points", "sp total cost"].find((l) => pairs.has(l));
    const points = pointsLabel === undefined ? null : int(pointsLabel);
    if (points !== null) {
        system["shipPoints"] = { spent: 0, budget: points };
    }
    const capacityText = pairs.get("weapon capacity");
    if (capacityText !== undefined) {
        const capacity = parseWeaponCapacity(capacityText);
        if (capacity === null) {
            unparsed.push(`weapon capacity: ${capacityText}`);
        } else {
            system["weaponCapacity"] = capacity;
        }
    }
    // A voidcraft's hull type is free text in the schema: a printed hull
    // outside the component hull choices ("Space Station") is kept as printed.
    const hullText = pairs.get("hull");
    const hullType = hullText === undefined ? hullHint : printedHull(hullText);
    if (hullText !== undefined && hullType === null) {
        unparsed.push(`hull: ${hullText}`);
    }
    if (hullType !== null && hullType.length > 0) {
        system["hullType"] = hullType;
        system["hullClass"] = titleWords(hullType.replace(/-/gu, " "));
    }
    for (const [label, key] of [
        ["dimensions", "dimensions"],
        ["mass", "mass"],
        ["crew", "complement"],
        ["accel", "acceleration"],
        ["acceleration", "acceleration"],
    ] as const) {
        const text = pairs.get(label);
        if (text !== undefined && system[key] === undefined) {
            system[key] = text;
        }
    }
    const population = int("crew population");
    const rating = pairs.get("crew rating");
    const ratingValue = rating === undefined ? null : /\((\d+)\)|^(\d+)/u.exec(rating.trim());
    if (rating !== undefined && ratingValue === null) {
        unparsed.push(`crew rating: ${rating}`);
    }
    const morale = int("morale");
    if (population !== null || ratingValue !== null || morale !== null) {
        system["crew"] = {
            ...(population === null ? {} : { population }),
            ...(ratingValue === null ? {} : { crewRating: Number(ratingValue[1] ?? ratingValue[2]) }),
            ...(morale === null ? {} : { morale: { max: morale, value: morale } }),
        };
    }
    return { system, unparsed };
}
