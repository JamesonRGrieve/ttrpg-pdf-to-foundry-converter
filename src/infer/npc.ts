// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject } from "../types/entity.ts";
import { diagramArmour, HIT_LOCATIONS, type HitLocation, type LocationArmour } from "./armour-diagram.ts";
import { inlineWeapons } from "./inline-weapons.ts";
import { splitTier } from "./names.ts";
import { listedSkills, readsWhole, skillKey, trainedSkillsOf } from "./npc-skills.ts";
import { splitTopLevel } from "./origin-paths.ts";
import { panelWeapons } from "./panel-weapons.ts";
import { mapRow } from "./rows.ts";
import { SIZES } from "./schema.ts";
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
    [/\bmagnitude\s*:/iu, "magnitude"],
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
    | "fate"
    | "magnitude";

/** An Item a statblock lists, before it is resolved against the document's own Items. */
export interface NpcItem {
    name: string;
    type: "talent" | "trait" | "weapon" | "gear";
    specialization?: string;
    /** Fields the statblock prints for the item itself (a boxed weapon profile). */
    system?: JsonObject;
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

/** A location word of the creature's own armour. */
const OWN_LOCATION = /\b(?:all|head|body|chest|arms?|legs?)\b/iu;

const locationsOf = (phrase: string): readonly HitLocation[] =>
    LOCATION_WORDS.find(([re]) => re.test(phrase.trim().replace(/\s+/gu, " ")))?.[1] ?? [];

/**
 * A statblock's armour line → the schema's per-location armour. Points are
 * printed before their locations ("4 All, 6 Head", "3 Body, Arms, Legs") or
 * after them ("Head 8, Body 10", "Flak (All 3)"); whichever comes first sets
 * the order for the line. A blanket value is applied before the locations
 * printed apart from it, "except Head" leaves a location bare, a lone number
 * covers every location, and "None" none. Whatever follows the line on the
 * panel ("Total TB: 4") is no part of it. A value printed for the creature
 * fought as a horde ("All 4, Horde 5") covers every location of a `horde`,
 * and of a creature the line gives no other value; otherwise it is left out.
 * Null when the line gives no points at a hit location (a vehicle's facings).
 */
export function armourOf(text: string, horde = false): JsonObject | null {
    const printed = text.replace(/\btotal\s+tb\b.*$/isu, "").trim();
    const line =
        horde || !OWN_LOCATION.test(printed)
            ? printed.replace(/\bhorde\b/giu, "All")
            : printed.replace(/,?\s*\bhorde\s+\d+|,?\s*\d+\s+horde\b/giu, "");
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
        for (const loc of HIT_LOCATIONS) {
            points[loc] = value;
        }
        return authoredArmour(points);
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
    return authoredArmour(points);
}

/** Printed per-location armour in the schema's shape: authored, its total the body's. */
function authoredArmour(points: LocationArmour): JsonObject {
    return { mode: "locations", total: points.body, authored: true, locations: { ...points } };
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
    // A field the panel sets apart under its own bold label is that block's
    // text, whatever follows it (a named rule's label the field labels do
    // not know); fields read only from the running text otherwise.
    const fields = { ...splitFields(panel), ...blockFields(grid.blocks) };
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
    // A printed Magnitude is a horde's: it is tracked in place of wounds.
    const magnitude = int("magnitude");
    if (magnitude !== null) {
        system["horde"] = { enabled: true, magnitude: { max: magnitude, current: magnitude } };
        if (tier === null) {
            system["tier"] = "horde";
        }
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
    // The armour line is read into the schema's locations; the skills line
    // into its trained skills, the printed line kept beside them as printed.
    if (fields.armour !== undefined) {
        const armour = armourOf(fields.armour, magnitude !== null);
        if (armour === null) {
            unparsed.push(`armour: ${fields.armour}`);
        } else {
            system["armour"] = armour;
        }
    } else if (grid.armourDiagram !== undefined) {
        const toughness = characteristics["t"];
        const bonus = typeof toughness === "number" ? Math.floor(toughness / 10) : 0;
        system["armour"] = authoredArmour(diagramArmour(grid.armourDiagram, bonus));
    }
    if (fields.skills !== undefined) {
        system["skills"] = tidyList(fields.skills);
        // A line with an entry that did not read whole (another field's text
        // run into it, a callout number beside it) is kept as printed only.
        const skills = listedSkills(tidyList(fields.skills));
        if (skills.length > 0 && skills.every(readsWhole)) {
            system["trainedSkills"] = trainedSkillsOf(skills);
        }
    }

    const listed = (["talents", "traits", "weapons", "gear"] as const).flatMap((key) =>
        listedItems(fields[key] ?? "", LIST_ITEM_TYPE[key]),
    );
    const size = sizeOf(listed);
    if (size !== null) {
        system["size"] = size;
    }
    // Weapons boxed in the panel with their own profile, unless a weapons list names them.
    const named = new Set(listed.filter((i) => i.type === "weapon").map((i) => itemKey(i.name)));
    const boxed = panelWeapons(grid.associatedText.map(rejoinSmallCaps))
        .filter((w) => !named.has(itemKey(w.name)))
        .map((w): NpcItem => {
            const profile = mapRow("weapon", w.cells).system;
            return {
                name: w.name,
                type: "weapon",
                system: w.count === null ? profile : { ...profile, quantity: w.count },
            };
        });
    const items = [...listed, ...boxed];
    return { name, system, items, abilities: specialAbilities(grid.blocks), unparsed };
}

const itemKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * A statblock list as the book sets it, the spacing a text layer garbled
 * around brackets restored: none inside them ("(S )" → "(S)"), one before an
 * opening bracket after a word ("Acrobatics(Ag)") and before a bonus closing
 * on one ("(Per)+10" → "(Per) +10").
 */
export function tidyList(text: string): string {
    return text
        .replace(/\(\s+/gu, "(")
        .replace(/\s+\)/gu, ")")
        .replace(/(\p{L})\(/gu, "$1 (")
        .replace(/\)\s*([+-]\s*\d)/gu, ") $1")
        .replace(/\s+/gu, " ")
        .trim();
}

/**
 * The creature's size category from its listed `Size` trait: the category it
 * names ("Size (Hulking)", by the system's size labels) or its number
 * ("Size (5)"). Null when it lists none or names none.
 */
export function sizeOf(items: readonly NpcItem[]): number | null {
    const trait = items.find((i) => i.type === "trait" && /^\s*size\s*$/iu.test(i.name));
    if (trait === undefined) {
        return null;
    }
    const level = trait.system?.["level"];
    if (typeof level === "number" && Number.isInteger(level) && Object.values(SIZES).includes(level)) {
        return level;
    }
    return SIZES[(trait.specialization ?? "").trim().toLowerCase()] ?? null;
}

/** The statblock fields the panel prints as blocks under their own label. */
export function blockFields(blocks: DetectedNumericGrid["blocks"]): Partial<Record<StatField, string>> {
    const out: Partial<Record<StatField, string>> = {};
    for (const { label, text } of blocks) {
        if (label === null) {
            continue;
        }
        const field = LABELS.find(([re]) =>
            new RegExp(`^${re.source}$`, re.flags).test(`${bareLabel(label).trim()}:`),
        )?.[1];
        if (field !== undefined && out[field] === undefined && text.trim() !== "") {
            out[field] = text.trim().replace(/[.;,]+$/u, "");
        }
    }
    return out;
}

/** The Item type each statblock list names. */
const LIST_ITEM_TYPE = { talents: "talent", traits: "trait", weapons: "weapon", gear: "gear" } as const;

/** A parenthetical closing a listed name: a talent's specialisation, a weapon's profile. */
const CLOSING_PARENTHETICAL = /^(?<base>[^(]+?)\s*\((?<inner>.*)\)\s*$/su;

/** A trait's rating in its closing parenthetical: "(2)", "(+3)", or with the short label of what it rates ("(PR 3)"). */
const TRAIT_RATING = /^(?:\p{L}{1,3}\s*)?\+?\s*(?<n>\d{1,3})$/u;
/** A trait's rating set after its name: "Fear 3". */
const TRAILING_RATING = /^(?<base>.*\p{L})\s+\+?(?<n>\d{1,3})$/u;

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
/** A count set before a listed item's name ("3 frag grenades", "2× flasks"). */
const LEADING_COUNT = /^(?<n>\d+)\s*[x×]?\s+(?<name>\p{L}.*)$/u;

/** A listed item's name without a count set before it, and that count as its quantity (null when none). */
export function countedName(entry: string): { name: string; quantity: number | null } {
    const m = LEADING_COUNT.exec(entry.trim())?.groups;
    return m?.["name"] === undefined
        ? { name: entry, quantity: null }
        : { name: m["name"], quantity: Number(m["n"]) };
}

export function listedItems(text: string, type: NpcItem["type"]): NpcItem[] {
    return splitTopLevel(text.replace(/\.\s*$/u, ""), /^[,;]\s*/u)
        .filter((entry) => /\p{L}/u.test(entry) && !NO_ENTRY.test(entry))
        .map((entry) => {
            const inner = CLOSING_PARENTHETICAL.exec(entry)?.groups?.["inner"]?.trim() ?? "";
            if (type === "weapon") {
                // The name ends where its profile opens, however the line runs on;
                // a profile printed in the brackets is the weapon's own.
                const counted = countedName(/^[^(:]+/u.exec(entry)?.[0].trim() ?? entry);
                const [profile] = inlineWeapons(entry);
                const system = {
                    ...(profile === undefined ? {} : mapRow("weapon", profile.cells).system),
                    ...(counted.quantity === null ? {} : { quantity: counted.quantity }),
                };
                return Object.keys(system).length === 0
                    ? { name: counted.name, type }
                    : { name: counted.name, type, system };
            }
            if (type === "gear") {
                const counted = countedName(entry);
                return counted.quantity === null
                    ? { name: entry, type }
                    : { name: counted.name, type, system: { quantity: counted.quantity } };
            }
            // A talent's specialisation and a trait's rating are the schema's
            // own fields of the item, no part of its name.
            if (type === "talent" && inner.length > 0) {
                return { name: listedBase(entry), type, specialization: inner };
            }
            if (type !== "trait") {
                return { name: entry, type };
            }
            // A trait's rating is bracketed ("(2)", "(PR 3)") or set after its
            // name ("Fear 3"); any other bracketed word is its specialisation.
            const rating = TRAIT_RATING.exec(inner)?.groups?.["n"];
            if (rating !== undefined) {
                return { name: listedBase(entry), type, system: { level: Number(rating) } };
            }
            if (inner.length > 0) {
                return { name: listedBase(entry), type, specialization: inner };
            }
            const trailing = TRAILING_RATING.exec(entry.trim())?.groups;
            return trailing?.["base"] === undefined
                ? { name: entry, type }
                : { name: trailing["base"], type, system: { level: Number(trailing["n"]) } };
        });
}

/** The schema's call terms, by their printed labels ("Influence Minimum: 50"). */
const INFLUENCE_TERM = /\binfluence\s+(?<term>minimum|cost)\s*:\s*(?<n>\d+)/giu;
/** "Peer (Group) talent lowers Influence Cost by 2": the discount and the peer group it needs. */
const PEER_DISCOUNT =
    /\bpeer\s*\((?<peer>[^()]+)\)\s*talent\s+(?:lowers|reduces)\s+(?:the\s+)?influence\s+cost\s+by\s+(?<amount>\d+(?:d\d+)?)\b/iu;
/** A caller's required skill and rank: "must possess the X (Spec) skill at the Trained level". */
const CALLER_SKILL =
    /\bmust\s+possess\s+the\s+(?<skill>\p{L}[\p{L}\s-]*?)\s*(?:\((?<spec>[^()]+)\)\s*)?skill\s+at\s+the\s+(?<rank>known|trained|experienced|veteran)\s+level/iu;
/** Corruption the caller gains: "gains 1d5 Corruption points". */
const CALLER_CORRUPTION = /\bgains?\s+(?<amount>\d+(?:d\d+)?)\s+corruption\b/iu;
/** The schema's skill ranks, first to last. */
const SKILL_RANKS = ["known", "trained", "experienced", "veteran"] as const;

/**
 * The terms a Reinforcement Character is called in on, from its introduction:
 * its `Influence Minimum` and `Influence Cost` (both printed, or it is none),
 * a Peer talent's discount, and what the caller needs and suffers. Words a
 * text layer ran together in the peer group are set apart.
 */
export function reinforcementTerms(text: string): JsonObject | null {
    const terms = new Map<string, number>();
    for (const m of text.matchAll(INFLUENCE_TERM)) {
        const term = m.groups?.["term"]?.toLowerCase();
        if (term !== undefined && !terms.has(term)) {
            terms.set(term, Number(m.groups?.["n"]));
        }
    }
    const minimum = terms.get("minimum");
    const cost = terms.get("cost");
    if (minimum === undefined || cost === undefined) {
        return null;
    }
    const reinforcement: JsonObject = { influenceMinimum: minimum, influenceCost: cost };
    const peer = PEER_DISCOUNT.exec(text)?.groups;
    if (peer !== undefined) {
        reinforcement["peerDiscount"] = {
            peer: (peer["peer"] ?? "").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").trim(),
            amount: peer["amount"] ?? "",
        };
    }
    const skill = CALLER_SKILL.exec(text)?.groups;
    const corruption = CALLER_CORRUPTION.exec(text)?.groups?.["amount"];
    if (skill !== undefined || corruption !== undefined) {
        const printedRank = (skill?.["rank"] ?? "").toLowerCase();
        const rank = SKILL_RANKS.findIndex((r) => r === printedRank);
        reinforcement["caller"] = {
            skill: skill?.["skill"] === undefined ? "" : skillKey(skill["skill"]),
            specialization: skill?.["spec"]?.trim() ?? "",
            rank: rank < 0 ? null : rank + 1,
            corruption: corruption ?? "",
        };
    }
    return reinforcement;
}
