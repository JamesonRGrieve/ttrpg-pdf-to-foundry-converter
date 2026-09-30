// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import { escapeHtml } from "../util/text.ts";

/**
 * The wh40k-rpg Foundry system's compendium authoring schema, as an OUTPUT
 * FORMAT spec: game-line ids, the standard cost shape, per-line variant
 * containers, provenance records, transient state, and the pack-naming
 * taxonomy (`<line>-<book>-<category>`). Every term here is the system's own
 * field/enum vocabulary — none of it identifies any particular document.
 *
 * Source of truth for these rules: the system's `docs/pack-authoring.md` and
 * `src/packs/validate-schema.cjs`; `scripts/validate-output.mjs` runs those
 * validators against engine output.
 */

export const LINES = ["dh1", "dh2", "rt", "dw", "bc", "ow", "im"] as const;
export type Line = (typeof LINES)[number];
/** The system's canonical default line. */
export const DEFAULT_LINE: Line = "dh2";

/**
 * The game lines oldest first, by first publication. A document printed in
 * several lines lives canonically in the newest one's pack (pack-authoring
 * "Canonical location = newest official line").
 */
export const LINE_PUBLICATION_ORDER: readonly Line[] = ["dh1", "rt", "dw", "bc", "ow", "dh2", "im"];

/** Item types the system models (the Foundry `type` field). */
export type ItemType =
    | "weapon"
    | "armour"
    | "gear"
    | "ammunition"
    | "forceField"
    | "cybernetic"
    | "weaponModification"
    | "armourModification"
    | "talent"
    | "trait"
    | "skill"
    | "psychicPower"
    | "criticalInjury"
    | "condition"
    | "mutation"
    | "malignancy"
    | "mentalDisorder"
    | "shipComponent"
    | "shipWeapon";

/** Pack category segment per document type (pack-authoring "Pack Naming Taxonomy"). */
const ITEM_SEGMENT: Record<ItemType, string> = {
    weapon: "items-weapons",
    armour: "items-armour",
    gear: "items-gear",
    ammunition: "items-ammo",
    forceField: "items-force-fields",
    cybernetic: "items-cybernetics",
    weaponModification: "items-weapon-mods",
    armourModification: "items-armor-mods",
    talent: "items-talents",
    trait: "items-traits",
    skill: "items-skills",
    psychicPower: "items-psychic-powers",
    criticalInjury: "items-critical-injuries",
    condition: "items-conditions",
    mutation: "items-mutations",
    malignancy: "items-malignancies",
    mentalDisorder: "items-mental-disorders",
    shipComponent: "items-ship-components",
    shipWeapon: "items-ship-weapons",
};

/** The system's ship weapon types (the ship weapon `weaponType` choices). */
export const SHIP_WEAPON_TYPES = [
    "macrobattery",
    "lance",
    "nova-cannon",
    "torpedo",
    "bombardment-cannon",
    "landing-bay",
    "attack-craft",
] as const;

export const ACTOR_SEGMENT = "actors-bestiary";

/** The system's ship hull types (the ship component `hullType` choices). */
export const HULL_TYPES = [
    "transport",
    "raider",
    "frigate",
    "light-cruiser",
    "cruiser",
    "battlecruiser",
    "grand-cruiser",
] as const;
/** The `hullType` choice for a component fitting every hull. */
export const ALL_HULLS = "all";

/** A character-creation step of the target line (see `targets.ts`). */
export interface OriginStep {
    /** The system's step key. */
    key: string;
    /** Position in the line's creation sequence. */
    index: number;
}

export interface OriginPathInput {
    name: string;
    step: OriginStep;
    line: Line;
    book: string;
    page: string;
    /** Description as HTML. */
    description: string;
    grants: JsonObject;
    /** Characteristic key → points. */
    characteristics: Record<string, number>;
    /** Rules text of an origin that is a single effect (a divination), as HTML. */
    effectText?: string;
    /** Experience cost of taking the step. */
    xpCost?: number;
    /** Prerequisites to take the step, as printed. */
    requirements?: string;
}

/** Build an origin-path Item document body in the system's canonical authoring shape. */
export function buildOriginPath(input: OriginPathInput): JsonObject {
    return {
        name: input.name,
        type: "originPath",
        system: {
            step: input.step.key,
            stepIndex: input.step.index,
            xpCost: input.xpCost ?? 0,
            requirements: { text: input.requirements ?? "", previousSteps: [], excludedSteps: [] },
            gameSystem: input.line,
            gameSystems: [input.line],
            grants: input.grants,
            modifiers: { characteristics: input.characteristics },
            effectText: input.effectText ?? "",
            description: descriptionContainer(input.line, input.description),
            source: sourceRecord(input.line, input.book, input.page),
        },
        effects: [],
        flags: {},
    };
}

export function itemSegment(type: ItemType): string {
    return ITEM_SEGMENT[type];
}

export function packName(line: Line, book: string, segment: string): string {
    return `${line}-${book}-${segment}`;
}

/** Item types carrying a physical acquisition cost (the standard cost shape). */
const PHYSICAL: ReadonlySet<ItemType> = new Set([
    "weapon",
    "armour",
    "gear",
    "ammunition",
    "forceField",
    "cybernetic",
    "weaponModification",
    "armourModification",
]);

/**
 * The standard cost shape: a native acquisition field per line plus the
 * line-asymmetric `homebrew` block. Unauthored values are `null`.
 */
export function costShape(): JsonObject {
    return {
        dh1: { throneGelt: null },
        dh2: { influence: null, homebrew: { requisition: null, throneGelt: null } },
        rt: { profitFactor: null, homebrew: { throneGelt: null } },
        dw: { requisition: null, homebrew: { throneGelt: null } },
        bc: { infamy: null, homebrew: { throneGelt: null } },
        ow: { logistics: null, homebrew: { throneGelt: null } },
    };
}

/** Wrap a line-dependent value in its per-line variant container. */
export function variant(line: Line, value: JsonValue): JsonObject {
    return { [line]: value };
}

export function descriptionContainer(line: Line, html: string): JsonObject {
    return variant(line, { value: html, chat: "", summary: "" });
}

/** A `raw` provenance record: rules-as-written from `book`, printed `page`. */
export function sourceRecord(line: Line, book: string, page: string): JsonObject {
    return variant(line, { provenance: "raw", book, page });
}

/** Transient owned-item state; shared, never variantized or provenanced. */
function stateBlock(): JsonObject {
    return { equipped: false, stowed: false, container: "" };
}

export interface ItemInput {
    type: ItemType;
    name: string;
    line: Line;
    book: string;
    page: string;
    /** Description as HTML (paragraph-wrapped plain text). */
    description: string;
    /** Type-specific, already-parsed `system` fields (stat blocks, enums). */
    system: JsonObject;
    /** Per-line rules-content fields (`effect`, `uses`, `notes`, …): wrapped in variant containers. */
    variantized?: Record<string, JsonValue>;
}

/** Build a full Item document body in the system's canonical authoring shape. */
export function buildItem(input: ItemInput): JsonObject {
    const system: JsonObject = {
        ...input.system,
        description: descriptionContainer(input.line, input.description),
        source: sourceRecord(input.line, input.book, input.page),
        gameSystems: [input.line],
    };
    for (const [field, value] of Object.entries(input.variantized ?? {})) {
        system[field] = variant(input.line, value);
    }
    // Talent/trait/power cost is XP and afflictions have none: only physical
    // items carry the acquisition-currency shape and owned-item state.
    if (PHYSICAL.has(input.type)) {
        system["cost"] = costShape();
        system["state"] = stateBlock();
    }
    return { name: input.name, type: input.type, system, effects: [], flags: {} };
}

export interface ActorInput {
    name: string;
    /** The system's Actor type (the target line's own, e.g. `<line>-npc`). */
    actorType: string;
    line: Line;
    book: string;
    page: string;
    description: string;
    system: JsonObject;
}

/** Build an Actor document body (an NPC, a voidcraft, …; line also carried in `gameSystem`). */
export function buildActor(input: ActorInput): JsonObject {
    return {
        name: input.name,
        type: input.actorType,
        system: {
            ...input.system,
            gameSystem: input.line,
            gameSystems: [input.line],
            description: descriptionContainer(input.line, input.description),
            source: sourceRecord(input.line, input.book, input.page),
        },
        items: [],
        effects: [],
        flags: {},
    };
}

/** Pack segment of each craft class the parser emits. */
export const CRAFT_SEGMENT: Readonly<Record<"terracraft" | "aircraft" | "voidcraft", string>> = {
    terracraft: "vehicles-terracraft",
    aircraft: "vehicles-aircraft",
    voidcraft: "vehicles-voidcraft",
};

export interface VehicleInput extends ActorInput {
    /** Named rules printed beneath the profile, as HTML. */
    specialRules: string;
    /** The profile's weapons text, as HTML. */
    weapons: string;
}

/** Build a craft Actor document body (the target line's craft type; line also carried in `gameSystem`). */
export function buildVehicle(input: VehicleInput): JsonObject {
    return {
        name: input.name,
        type: input.actorType,
        system: {
            vehicleClass: "ground",
            ...input.system,
            weapons: input.weapons,
            specialRules: input.specialRules,
            gameSystem: input.line,
            gameSystems: [input.line],
            description: descriptionContainer(input.line, input.description),
            source: sourceRecord(input.line, input.book, input.page),
        },
        items: [],
        effects: [],
        flags: {},
    };
}

/** Plain text → minimal HTML: one `<p>` per blank-line-separated paragraph, entities escaped. */
export function toHtml(text: string): string {
    return text
        .split(/\n{2,}/u)
        .map((p) => p.replace(/\s+/gu, " ").trim())
        .filter((p) => p.length > 0)
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("");
}
