// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject } from "../types/entity.ts";
import { parseAvailability } from "./notation.ts";

/**
 * A vehicle profile — a panel of capitalised `LABEL: value` cells naming the
 * schema's conventional-craft fields (armour facings, speeds, integrity, …) —
 * → a land craft's `system` fields in the system's authoring shape. Labels and
 * enums are the schema's own vocabulary; unreadable values are reported,
 * never defaulted.
 */

/**
 * The conventional-craft profile labels — the schema's field names as printed
 * — each with its colon; a value runs to the next label. Capitalised values
 * ("ENORMOUS") must not read as part of the label after them.
 */
const PANEL_LABELS = [
    "front",
    "side",
    "rear",
    "cruising speed",
    "tactical speed",
    "manoeuvrability",
    "size",
    "avl",
    "availability",
    "carrying capacity",
    "integrity",
    "threat",
    "crew",
    "vehicle traits",
] as const;
// A label may drop its colon when a number follows it directly ("REAR 16").
const PANEL_LABEL = new RegExp(
    `(?<![\\p{L}])(${PANEL_LABELS.join("|").replace(/ /gu, "\\s+")})(?:\\s*:\\s*|\\s+(?=[+-]?\\d))`,
    "giu",
);

/** The size scale of the system's vehicle-size configuration, smallest first (1–10). */
const SIZE_SCALE = [
    "miniscule",
    "puny",
    "scrawny",
    "average",
    "hulking",
    "enormous",
    "massive",
    "immense",
    "monumental",
    "titanic",
] as const;

/** Alternative spellings of size-scale names. */
const SIZE_SPELLINGS: Readonly<Record<string, string>> = { minuscule: "miniscule" };

/** The schema's locomotion choices a vehicle trait can name. */
const LOCOMOTION_TRAITS = [
    "immobile",
    "wheeled",
    "tracked",
    "walker",
    "hover",
    "flyer",
    "skimmer",
    "vtol",
    "hull",
    "submersible",
    "hydrofoil",
] as const;

/** Whether a label is one of the vehicle profile's fields, however it is cased or spaced ("CruisingSPEED"). */
export function isVehicleLabel(label: string): boolean {
    const squashed = label.toLowerCase().replace(/[^a-z]/gu, "");
    return PANEL_LABELS.some((l) => l.replace(/ /gu, "") === squashed);
}

/** Labels whose presence together marks a vehicle profile. */
const PROFILE_LABELS = ["integrity", "front", "side", "rear"] as const;

/**
 * `LABEL: value` pairs of a vehicle panel, keyed by lower-cased label (first
 * occurrence wins). A value runs to the next label on its line.
 */
export function panelPairs(text: string): Map<string, string> {
    const pairs = new Map<string, string>();
    for (const line of text.split("\n")) {
        const hits = [...line.matchAll(PANEL_LABEL)];
        hits.forEach((m, i) => {
            const label = (m[1] ?? "").toLowerCase().replace(/\s+/gu, " ");
            const end = hits[i + 1]?.index ?? line.length;
            const value = line
                .slice(m.index + m[0].length, end)
                .replace(/\s+/gu, " ")
                .trim();
            if (!pairs.has(label)) {
                pairs.set(label, value);
            }
        });
    }
    return pairs;
}

/** Whether labelled text is a vehicle profile: armour facings and structural integrity. */
export function isVehicleProfile(pairs: ReadonlyMap<string, string>): boolean {
    return PROFILE_LABELS.every((l) => pairs.has(l));
}

/** Split a list at commas outside parentheses. */
function splitList(text: string): string[] {
    return text
        .split(/,(?![^(]*\))/u)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The schema's craft classes this parser emits: land craft, and aircraft (the Flyer vehicle trait). */
export type CraftKind = "terracraft" | "aircraft";

export interface ParsedVehicle {
    kind: CraftKind;
    system: JsonObject;
    unparsed: string[];
}

export function parseVehicle(pairs: ReadonlyMap<string, string>): ParsedVehicle {
    const system: JsonObject = {};
    const unparsed: string[] = [];
    const int = (label: string): number | null => {
        const text = pairs.get(label);
        if (text === undefined) {
            return null;
        }
        const m = /^([+-]?\d+)/u.exec(text.replace(/\s+/gu, ""));
        if (m === null) {
            unparsed.push(`${label}: ${text}`);
            return null;
        }
        return Number(m[1]);
    };

    const facing = (label: string): JsonObject | null => {
        const value = int(label);
        return value === null ? null : { value, descriptor: "" };
    };
    const [front, side, rear] = [facing("front"), facing("side"), facing("rear")];
    if (front !== null && side !== null && rear !== null) {
        system["armour"] = { front, side, rear };
    }
    const cruising = int("cruising speed");
    const tactical = int("tactical speed");
    if (cruising !== null && tactical !== null) {
        system["speed"] = { cruising, tactical, notes: "" };
    }
    const manoeuvrability = int("manoeuvrability");
    if (manoeuvrability !== null) {
        system["manoeuverability"] = manoeuvrability;
    }
    const integrity = int("integrity");
    if (integrity !== null) {
        system["integrity"] = { max: integrity, value: integrity, critical: 0 };
    }
    const threat = int("threat");
    if (threat !== null) {
        system["threatLevel"] = threat;
    }
    // The printed carrying capacity counts personnel carried beyond the crew.
    const carried = int("carrying capacity");
    if (carried !== null) {
        system["passengers"] = carried;
    }

    const sizeText = pairs.get("size");
    if (sizeText !== undefined) {
        const word = sizeText.toLowerCase().replace(/[^a-z]/gu, "");
        const index = SIZE_SCALE.indexOf((SIZE_SPELLINGS[word] ?? word) as (typeof SIZE_SCALE)[number]);
        if (index < 0) {
            unparsed.push(`size: ${sizeText}`);
        } else {
            system["size"] = index + 1;
            system["sizeDescriptor"] = capitalize(sizeText.toLowerCase());
        }
    }
    const avl = pairs.get("avl") ?? pairs.get("availability");
    if (avl !== undefined) {
        const availability = parseAvailability(avl);
        if (availability === null) {
            unparsed.push(`availability: ${avl}`);
        } else {
            system["availability"] = availability;
        }
    }
    const crew = pairs.get("crew");
    if (crew !== undefined) {
        const roles = splitList(crew);
        system["crew"] = { required: roles.length, notes: capitalize(crew.toLowerCase()) };
    }
    const traits = pairs.get("vehicle traits");
    if (traits !== undefined) {
        const names = splitList(traits).map((t) => t.toLowerCase());
        system["traitsText"] = names.map(capitalize).join(", ");
        const locomotion = LOCOMOTION_TRAITS.find((l) => names.includes(l));
        if (locomotion !== undefined) {
            system["locomotion"] = locomotion;
        }
    }
    const flies = traits !== undefined && splitList(traits).some((t) => t.toLowerCase() === "flyer");
    if (flies) {
        system["vehicleClass"] = "air";
    }
    return { kind: flies ? "aircraft" : "terracraft", system, unparsed };
}
