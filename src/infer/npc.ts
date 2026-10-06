// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject } from "../types/entity.ts";
import { splitTier } from "./names.ts";
import { splitTopLevel } from "./origin-paths.ts";
import type { DetectedNumericGrid } from "./types.ts";
import { isVehicleLabel } from "./vehicle.ts";

/**
 * A statblock (characteristic grid + labelled lines) → NPC `system` fields in
 * the system's authoring shape. Labels are the schema's own statblock field
 * names; values are read with fixed notations. Unreadable fields are reported,
 * never defaulted to invented numbers.
 */

/** Statblock line labels → the field each introduces. */
const LABELS: readonly [RegExp, StatField][] = [
    [/\bwounds?\s*:/iu, "wounds"],
    [/\bmovement\s*:/iu, "movement"],
    [/\bthreat(?:\s+rating)?\s*:/iu, "threat"],
    [/\barmou?r\s*:/iu, "armour"],
    [/\bskills?\s*:/iu, "skills"],
    [/\btalents?\s*:/iu, "talents"],
    [/\btraits?\s*:/iu, "traits"],
    [/\bweapons?\s*:/iu, "weapons"],
    [/\bgear\s*:/iu, "gear"],
    [/\bcybernetics?\s*:/iu, "cybernetics"],
    [/\bpsychic\s+powers?\s*:/iu, "psychicPowers"],
    [/\bpsy(?:chic)?\s+rating\s*:/iu, "psyRating"],
    [/\bfate\s+points?\s*:/iu, "fate"],
];

type StatField =
    | "wounds"
    | "movement"
    | "threat"
    | "armour"
    | "skills"
    | "talents"
    | "traits"
    | "weapons"
    | "gear"
    | "cybernetics"
    | "psychicPowers"
    | "psyRating"
    | "fate";

/** An Item a statblock lists, before it is resolved against the document's own Items. */
export interface NpcItem {
    name: string;
    type: "talent" | "trait" | "weapon" | "gear";
    specialization?: string;
}

export interface ParsedNpc {
    name: string;
    system: JsonObject;
    /** The talents, traits, weapons and gear the statblock lists. */
    items: NpcItem[];
    /** Named rules printed in the statblock under their own bold label, with the page each is on. */
    abilities: { name: string; text: string; pageIndex: number }[];
    unparsed: string[];
}

/**
 * Labels of fields rather than named rules: a weapon profile's qualities line
 * and the fields of a psychic power printed in the statblock.
 */
const FIELD_LABELS =
    /^(?:special|action|focus power|range|sustained|subtype|effect|insanity points|corruption points)$/iu;

/** A field label may carry a qualifier in parentheses ("Armour (Primitive)"); the field is the label before it. */
const bareLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/u, "");

/** The entries of a statblock's psychic powers list, by name key. */
function listedPowers(blocks: DetectedNumericGrid["blocks"]): Set<string> {
    const list =
        blocks.find((b) => b.label !== null && /^psychic\s+powers?$/iu.test(bareLabel(b.label)))?.text ?? "";
    return new Set(
        list
            .split(",")
            .map(powerKey)
            .filter((k) => k.length > 0),
    );
}

// A listed power's parenthetical is a note ("Conceal (see below)"), not its name.
const powerKey = (name: string): string =>
    name
        .replace(/\([^)]*\)/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * A statblock's special abilities: its labelled blocks whose label is neither
 * one of the statblock's own fields, a weapon's qualities line, nor a power
 * its psychic powers list names (that block describes the power).
 */
export function specialAbilities(blocks: DetectedNumericGrid["blocks"]): ParsedNpc["abilities"] {
    const powers = listedPowers(blocks);
    return blocks.flatMap(({ label, text, pageIndex }) =>
        label === null ||
        FIELD_LABELS.test(bareLabel(label)) ||
        LABELS.some(([re]) => re.test(`${bareLabel(label)}:`)) ||
        isVehicleLabel(label) ||
        powers.has(powerKey(label)) ||
        text.length === 0
            ? []
            : [{ name: label, text, pageIndex }],
    );
}

/** Split statblock text at its field labels. */
export function splitFields(text: string): Partial<Record<StatField, string>> {
    const hits: { at: number; end: number; field: StatField }[] = [];
    for (const [re, field] of LABELS) {
        const global = new RegExp(re.source, "giu");
        for (const m of text.matchAll(global)) {
            hits.push({ at: m.index, end: m.index + m[0].length, field });
        }
    }
    hits.sort((a, b) => a.at - b.at);
    const fields: Partial<Record<StatField, string>> = {};
    hits.forEach((hit, i) => {
        const next = hits[i + 1]?.at ?? text.length;
        if (fields[hit.field] === undefined) {
            fields[hit.field] = text
                .slice(hit.end, next)
                .trim()
                .replace(/[.;,]+$/u, "");
        }
    });
    return fields;
}

/**
 * A numeric field's value opens with its number; a labelled line whose value
 * opens with words ("Threat: add 5 for each gift") is a rule note, not the field.
 */
const LEADING_INT = /^\s*\(?(\d+)/u;
const MOVEMENT = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/u;
/** Panel statblocks print each movement rate after its own schema label. */
const MOVEMENT_LABELLED = /\bHALF\s*(\d+)\s*FULL\s*(\d+)\s*CHARGE\s*(\d+)\s*RUN\s*(\d+)/iu;
/** Panel statblocks print labels without a colon. */
const THREAT_LABELLED = /\bTHREAT\s*:?\s*(\d+)/iu;
const WOUNDS_LABELLED = /\bWOUNDS?\s*:?\s*(\d+)/iu;

/**
 * Small-caps labels arrive letter-split — an enlarged initial as its own run
 * ("H ALF", "C HARGE") — so a lone capital followed by capitals is rejoined.
 */
export function rejoinSmallCaps(text: string): string {
    return text.replace(/\b(\p{Lu}) (?=\p{Lu}{2,}\b)/gu, "$1");
}

type HitLocation = "head" | "body" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

const HIT_LOCATIONS: readonly HitLocation[] = ["head", "body", "leftArm", "rightArm", "leftLeg", "rightLeg"];

/** A printed location word → the hit locations it covers ("Arms" both, "Chest" the body). */
const LOCATION_WORDS: readonly [RegExp, readonly HitLocation[]][] = [
    [/^all(?:\s+locations)?$/iu, HIT_LOCATIONS],
    [/^head$/iu, ["head"]],
    [/^(?:body|chest)$/iu, ["body"]],
    [/^arms?$/iu, ["leftArm", "rightArm"]],
    [/^legs?$/iu, ["leftLeg", "rightLeg"]],
    [/^left\s+arm$/iu, ["leftArm"]],
    [/^right\s+arm$/iu, ["rightArm"]],
    [/^left\s+leg$/iu, ["leftLeg"]],
    [/^right\s+leg$/iu, ["rightLeg"]],
];

/** The tokens an armour line is read from: points, location words, and an exclusion. */
const ARMOUR_TOKEN =
    /(?<points>\d+)|\b(?<except>except|but)\b|\b(?<where>all(?:\s+locations)?|head|body|chest|(?:left\s+|right\s+)?(?:arms?|legs?))\b/giu;

const locationsOf = (phrase: string): readonly HitLocation[] =>
    LOCATION_WORDS.find(([re]) => re.test(phrase.trim().replace(/\s+/gu, " ")))?.[1] ?? [];

/**
 * A statblock's armour line → the schema's per-location armour. Points are
 * printed before their locations ("4 All, 6 Head", "3 Body, Arms, Legs") or
 * after them ("Head 8, Body 10", "Flak (All 3)"); whichever comes first sets
 * the order for the line. A blanket value is applied before the locations
 * printed apart from it, "except Head" leaves a location bare, a lone number
 * covers every location, and "None" none. Whatever follows the line on the
 * panel ("Total TB: 4") is no part of it. Null when the line gives no points
 * at a hit location (a vehicle's facings).
 */
export function armourOf(text: string): JsonObject | null {
    const line = text.replace(/\btotal\s+tb\b.*$/isu, "").trim();
    const points: Record<HitLocation, number> = {
        head: 0,
        body: 0,
        leftArm: 0,
        rightArm: 0,
        leftLeg: 0,
        rightLeg: 0,
    };
    const tokens = [...line.matchAll(ARMOUR_TOKEN)].map((m) => m.groups ?? {});
    const firstPoints = tokens.findIndex((t) => t["points"] !== undefined);
    const firstWhere = tokens.findIndex((t) => t["where"] !== undefined);
    const lone = /^\d+\W*$/u.exec(line);
    if (lone !== null || (firstWhere < 0 && /^none\b/iu.test(line))) {
        const value = lone === null ? 0 : Number.parseInt(line, 10);
        const all = Object.fromEntries(HIT_LOCATIONS.map((loc) => [loc, value]));
        return { mode: "locations", total: value, authored: true, locations: all };
    }
    if (firstPoints < 0 || firstWhere < 0) {
        return null;
    }
    const pointsFirst = firstPoints < firstWhere;
    const assigned: { locations: readonly HitLocation[]; value: number }[] = [];
    const bare: HitLocation[] = [];
    tokens.forEach((t, i) => {
        const where = t["where"];
        if (where === undefined) {
            return;
        }
        if (tokens[i - 1]?.["except"] !== undefined) {
            bare.push(...locationsOf(where));
            return;
        }
        const near = pointsFirst
            ? tokens.slice(0, i).findLast((p) => p["points"] !== undefined)
            : tokens.slice(i + 1).find((p) => p["points"] !== undefined);
        if (near?.["points"] !== undefined) {
            assigned.push({ locations: locationsOf(where), value: Number(near["points"]) });
        }
    });
    for (const { locations, value } of [...assigned].sort(
        (a, b) => b.locations.length - a.locations.length,
    )) {
        for (const loc of locations) {
            points[loc] = value;
        }
    }
    for (const loc of bare) {
        points[loc] = 0;
    }
    return { mode: "locations", total: points.body, authored: true, locations: points };
}

export function parseNpc(grid: DetectedNumericGrid): ParsedNpc {
    const { name, tier } = splitTier(grid.name);
    const system: JsonObject = {};
    const unparsed: string[] = [];

    const characteristics: JsonObject = {};
    grid.labels.forEach((label, i) => {
        const value = grid.values[i];
        if (value !== undefined) {
            characteristics[label] = value;
        }
    });
    system["characteristics"] = characteristics;
    if (tier !== null) {
        system["tier"] = tier;
    }

    const panel = rejoinSmallCaps(grid.associatedText.join(" "));
    const fields = splitFields(panel);
    const int = (field: StatField): number | null => {
        const text = fields[field];
        if (text === undefined) {
            return null;
        }
        const m = LEADING_INT.exec(text);
        if (m === null) {
            unparsed.push(`${field}: ${text}`);
            return null;
        }
        return Number(m[1]);
    };

    const labelled = (re: RegExp): number | null => {
        const m = re.exec(panel);
        return m === null ? null : Number(m[1]);
    };
    // Without a printed wounds label, the lone number on the name banner is
    // taken as the statblock's wounds value. NOTE: this is a layout convention
    // (banner-number = wounds), not a labelled field — flagged for review.
    const wounds = int("wounds") ?? labelled(WOUNDS_LABELLED) ?? grid.bannerNumber;
    if (wounds !== null) {
        system["wounds"] = { max: wounds, value: wounds, critical: 0 };
    }
    const threat = int("threat") ?? labelled(THREAT_LABELLED);
    if (threat !== null) {
        system["threatLevel"] = threat;
    }
    const fate = int("fate");
    if (fate !== null) {
        system["fate"] = { value: fate, max: fate };
    }
    const psy = int("psyRating");
    if (psy !== null) {
        system["psy"] = { rating: psy };
    }
    const movement =
        fields.movement === undefined ? MOVEMENT_LABELLED.exec(panel) : MOVEMENT.exec(fields.movement);
    if (movement !== null) {
        system["movement"] = {
            half: Number(movement[1]),
            full: Number(movement[2]),
            charge: Number(movement[3]),
            run: Number(movement[4]),
        };
        system["movementManual"] = true;
    } else if (fields.movement !== undefined) {
        unparsed.push(`movement: ${fields.movement}`);
    }
    // The printed skills line is kept verbatim (the system keys it into its
    // trained skills); the armour line is read into the schema's locations.
    if (fields.armour !== undefined) {
        const armour = armourOf(fields.armour);
        if (armour === null) {
            unparsed.push(`armour: ${fields.armour}`);
        } else {
            system["armour"] = armour;
        }
    }
    if (fields.skills !== undefined) {
        system["skills"] = fields.skills;
    }

    const items = (["talents", "traits", "weapons", "gear"] as const).flatMap((key) =>
        listedItems(fields[key] ?? "", LIST_ITEM_TYPE[key]),
    );
    return { name, system, items, abilities: specialAbilities(grid.blocks), unparsed };
}

/** The Item type each statblock list names. */
const LIST_ITEM_TYPE = { talents: "talent", traits: "trait", weapons: "weapon", gear: "gear" } as const;

/** A parenthetical closing a listed name: a talent's specialisation, a weapon's profile. */
const CLOSING_PARENTHETICAL = /^(?<base>[^(]+?)\s*\((?<inner>.*)\)\s*$/su;

/** A list entry recording that the statblock has none of the kind. */
const NO_ENTRY = /^\s*(?:none|n\/a|[-–—]+)\s*$/iu;

/** A listed name without its closing parenthetical. */
export function listedBase(name: string): string {
    return CLOSING_PARENTHETICAL.exec(name)?.groups?.["base"]?.trim() ?? name.trim();
}

/**
 * A statblock list as bare embedded Items of `type`, one per top-level entry.
 * A talent keeps its parenthetical as its specialisation; a weapon's is its
 * printed profile, no part of its name.
 */
export function listedItems(text: string, type: NpcItem["type"]): NpcItem[] {
    return splitTopLevel(text.replace(/\.\s*$/u, ""), /^[,;]\s*/u)
        .filter((entry) => /\p{L}/u.test(entry) && !NO_ENTRY.test(entry))
        .map((entry) => {
            const inner = CLOSING_PARENTHETICAL.exec(entry)?.groups?.["inner"]?.trim() ?? "";
            if (type === "weapon") {
                // The name ends where its profile opens, however the line runs on.
                return { name: /^[^(:]+/u.exec(entry)?.[0].trim() ?? entry, type };
            }
            return type === "talent" && inner.length > 0
                ? { name: entry, type, specialization: inner }
                : { name: entry, type };
        });
}
