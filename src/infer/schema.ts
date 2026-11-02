// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import { byteCompare } from "../util/ordered.ts";
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
    | "shipWeapon"
    | "order"
    | "weaponQuality"
    | "navigatorPower"
    | "vehicleTrait"
    | "medal"
    | "darkPact"
    | "ritual"
    | "oath";

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
    order: "items-orders",
    weaponQuality: "items-weapon-qualities",
    navigatorPower: "items-navigator-powers",
    vehicleTrait: "items-vehicle-traits",
    medal: "items-medals",
    darkPact: "items-dark-pacts",
    ritual: "items-rituals",
    oath: "items-oaths",
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

/** The system's armour types (the armour `type` choices). */
export const ARMOUR_TYPES = [
    "flak",
    "mesh",
    "carapace",
    "power",
    "light-power",
    "storm-trooper",
    "feudal-world",
    "primitive",
    "xenos",
    "void",
    "enforcer",
    "hostile-environment",
    "force-field",
] as const;

/** The system's weapon technology types (the weapon `type` choices). */
export const WEAPON_TYPES = [
    "primitive",
    "las",
    "solid-projectile",
    "bolt",
    "melta",
    "plasma",
    "flame",
    "launcher",
    "explosive",
    "grenade",
    "power",
    "chain",
    "shock",
    "force",
    "exotic",
    "xenos",
] as const;

/** The system's gear categories (the gear `category` choices; `general` is the initial value). */
export const GEAR_CATEGORIES = [
    "general",
    "tools",
    "drugs",
    "consumable",
    "clothing",
    "survival",
    "communications",
    "detection",
    "medical",
    "tech",
    "religious",
    "luxury",
    "contraband",
] as const;

export const ACTOR_SEGMENT = "actors-bestiary";

/**
 * The system's ship component types (the ship component `componentType`
 * choices) with the labels the system shows for them.
 */
export const SHIP_COMPONENT_TYPES: readonly (readonly [string, string])[] = [
    ["essential", "Essential"],
    ["supplemental", "Supplemental"],
    ["weapons", "Weapons"],
    ["auger", "Auger Array"],
    ["gellarField", "Gellar Field"],
    ["voidShields", "Void Shields"],
    ["warpDrive", "Warp Drive"],
    ["lifeSupport", "Life Support"],
    ["quarters", "Crew Quarters"],
    ["bridge", "Bridge"],
    ["generatorum", "Generatorum"],
    ["plasmaDrive", "Plasma Drive"],
    ["augment", "Augmentation"],
    ["archeotech", "Archeotech"],
    ["xenotech", "Xenotech"],
];

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
    /**
     * Resource key (`wounds`, `fate`) → signed change. The system reads an
     * origin's wound and Fate bonuses only here (`modifiers.resources`), never
     * from its grants.
     */
    resources?: Record<string, number>;
    /**
     * The origin makes the character a psyker (#681): the system unlocks
     * psychic-power purchases by this flag, never by an origin's name.
     */
    grantsPsychicPowers?: boolean;
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
            modifiers: {
                characteristics: input.characteristics,
                ...(input.resources === undefined || Object.keys(input.resources).length === 0
                    ? {}
                    : { resources: input.resources }),
            },
            effectText: input.effectText ?? "",
            ...(input.grantsPsychicPowers === true ? { grantsPsychicPowers: true } : {}),
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

/**
 * The segment of a pack named `packName(line, book, segment)` for one of
 * `books`, or null when none of them names it. The longest matching book wins,
 * so a book whose slug extends another's is not cut short.
 */
export function packSegment(pack: string, line: Line, books: readonly string[]): string | null {
    const prefix = books
        .map((book) => `${line}-${book}-`)
        .filter((p) => pack.startsWith(p) && pack.length > p.length)
        .sort((a, b) => b.length - a.length)[0];
    return prefix === undefined ? null : pack.slice(prefix.length);
}

/** A pack's category as the system reads it: its segment, any `items-` prefix dropped. */
export function packCategory(segment: string): string {
    return segment.replace(/^items-/u, "");
}

/**
 * The flags a pack declares for the system (`flags["wh40k-rpg"]`). The system
 * finds a line's packs only by these — never by a pack's name — so a pack
 * without them is invisible to every lookup. Engine output is the book's
 * printed rules, never homebrew.
 */
export function packFlags(line: Line, segment: string): JsonObject {
    return { line, category: packCategory(segment), homebrew: false };
}

/**
 * The character builder reads a line's packs by a rank each pack declares:
 * `originBuilder` for the origins it offers (a divination is written in, not
 * picked, so its packs are not offered), `startingEquipment` for the kit it
 * offers. The builder sorts every installed pack of the line by rank and
 * keeps the first copy of a document it meets twice, so a converted module's
 * packs rank after the system's own: their ranks run BUILDER_RANK_OFFSET + 1..N
 * per line and role, in pack-name order (book, then category).
 */
export const BUILDER_RANK_OFFSET = 1000;
const BUILDER_ROLES: readonly { role: string; reads: (category: string) => boolean }[] = [
    {
        role: "originBuilder",
        reads: (category) => category.startsWith("origins-") && category !== "origins-divinations",
    },
    {
        role: "startingEquipment",
        reads: (category) =>
            ["weapons", "armour", "ammo", "gear", "cybernetics", "weapon-mods", "armor-mods"].includes(
                category,
            ),
    },
];

/** Each pack's flags with the builder ranks the system reads added, by pack name. */
export function withBuilderRanks(
    packs: readonly { name: string; flags: JsonObject }[],
): Map<string, JsonObject> {
    const out = new Map<string, JsonObject>();
    for (const { name, flags } of packs) {
        out.set(name, { ...(out.get(name) ?? {}), ...flags });
    }
    const names = [...out.keys()].sort(byteCompare);
    for (const { role, reads } of BUILDER_ROLES) {
        const next = new Map<string, number>();
        for (const name of names) {
            const flags = out.get(name);
            const line = flags?.["line"];
            const category = flags?.["category"];
            if (
                flags !== undefined &&
                typeof line === "string" &&
                typeof category === "string" &&
                reads(category)
            ) {
                const position = (next.get(line) ?? 0) + 1;
                next.set(line, position);
                out.set(name, { ...flags, [role]: BUILDER_RANK_OFFSET + position });
            }
        }
    }
    return out;
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
export function costShape(line?: Line, printed?: number): JsonObject {
    const shape: JsonObject = {
        dh1: { throneGelt: null },
        dh2: { influence: null, homebrew: { requisition: null, throneGelt: null } },
        rt: { profitFactor: null, homebrew: { throneGelt: null } },
        dw: { requisition: null, homebrew: { throneGelt: null } },
        bc: { infamy: null, homebrew: { throneGelt: null } },
        ow: { logistics: null, homebrew: { throneGelt: null } },
    };
    // A printed price is the line's own acquisition currency (its first field).
    const own = line === undefined ? undefined : shape[line];
    if (printed !== undefined && typeof own === "object" && own !== null && !Array.isArray(own)) {
        const [field] = Object.keys(own);
        if (field !== undefined) {
            own[field] = printed;
        }
    }
    return shape;
}

/** Wrap a line-dependent value in its per-line variant container. */
export function variant(line: Line, value: JsonValue): JsonObject {
    return { [line]: value };
}

export function descriptionContainer(line: Line, html: string): JsonObject {
    return variant(line, { value: html, chat: "", summary: "" });
}

/**
 * Each line's short label, as the system's source records lead a book's
 * title with it ("DH2: <title>"; the first line's records read "DH").
 * Labels of the line ids, not product names.
 */
const LINE_LABELS: Readonly<Record<Line, string>> = {
    dh1: "DH",
    dh2: "DH2",
    rt: "RT",
    dw: "DW",
    bc: "BC",
    ow: "OW",
    im: "IM",
};

/**
 * The `book` of a source record: the line's label and the book's own title
 * ("DH2: <title>"), the standardized string the system's source records
 * carry, so a sheet cites "DH2: <title>, p.12" rather than a pack slug.
 */
export function sourceBookLabel(line: Line, title: string): string {
    return `${LINE_LABELS[line]}: ${title}`;
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
        const printed = input.system["cost"];
        system["cost"] = typeof printed === "number" ? costShape(input.line, printed) : costShape();
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
