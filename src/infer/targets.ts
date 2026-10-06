// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_LINE, LINES, type Line, type OriginStep } from "./schema.ts";

/**
 * Target schemas: the mechanical structure the user can choose to write. Each
 * belongs to one Foundry game system: a wh40k-rpg game line (the line's id and
 * its character-creation steps — the system's step keys, sequence, labels and
 * pack segments) or a dnd5e ruleset. A target is empty structure. It holds no
 * entries and no values; the PDF supplies every one. The engine never picks a
 * target from the document.
 */

/** The Foundry game systems a target can write for, by system id. */
export type SystemId = "wh40k-rpg" | "dnd5e";

/** One character-creation step of a line's origin path. */
export interface OriginStepDef extends OriginStep {
    /** The step's name as the system labels it, in lower case; matched in headings, captions and grant labels. */
    labels: readonly string[];
    /** Pack category segment its origins are filed under. */
    segment: string;
    /** Bought with experience rather than chosen at creation. */
    boughtWithXp?: boolean;
}

/** The system's Actor type per kind of actor the engine writes, in one line. */
export interface ActorTypes {
    npc: string;
    terracraft: string;
    aircraft: string;
    voidcraft: string;
}

/** A wh40k-rpg game line's schema. */
export interface TargetSchema {
    system: "wh40k-rpg";
    line: Line;
    actorTypes: ActorTypes;
    originSteps: readonly OriginStepDef[];
}

/** The dnd5e system's rulesets (its `system.source.rules` values). */
export const DND5E_RULES = ["2014", "2024"] as const;
export type Dnd5eRules = (typeof DND5E_RULES)[number];

/** A dnd5e ruleset's schema: which rules version its documents are marked as. */
export interface Dnd5eTarget {
    system: "dnd5e";
    /** Target id: `dnd5e-<rules>`. */
    id: `dnd5e-${Dnd5eRules}`;
    rules: Dnd5eRules;
    /**
     * How a background's listed ability scores advance, where the ruleset's
     * backgrounds carry them (the system's AbilityScoreImprovement shape):
     * points to spend, and the most any one score takes.
     */
    backgroundAbilityScores: { points: number; cap: number } | null;
}

export type Target = TargetSchema | Dnd5eTarget;

/** Lines the system registers a line-specific aircraft type for; the rest use the shared one. */
const LINE_AIRCRAFT: ReadonlySet<Line> = new Set(["dh2", "dw", "ow", "rt"]);

/** Lines the system registers a line-specific voidcraft type for; the rest use the shared one. */
const LINE_VOIDCRAFT: ReadonlySet<Line> = new Set(["rt"]);

/** A line's own actor types, as the system registers them (`<line>-npc`, …). */
function actorTypes(line: Line): ActorTypes {
    return {
        npc: `${line}-npc`,
        terracraft: `${line}-terracraft`,
        aircraft: LINE_AIRCRAFT.has(line) ? `${line}-aircraft` : "aircraft",
        voidcraft: LINE_VOIDCRAFT.has(line) ? `${line}-voidcraft` : "voidcraft",
    };
}

const step = (
    key: string,
    index: number,
    labels: readonly string[],
    segment: string,
    boughtWithXp = false,
): OriginStepDef => ({ key, index, labels, segment, ...(boughtWithXp ? { boughtWithXp } : {}) });

const HOME_WORLD = (index: number, segment = "origins-homeworlds"): OriginStepDef =>
    step("homeWorld", index, ["home world", "homeworld"], segment);

export const TARGETS: Readonly<Record<Line, TargetSchema>> = {
    dh2: {
        system: "wh40k-rpg",
        line: "dh2",
        actorTypes: actorTypes("dh2"),
        originSteps: [
            HOME_WORLD(1),
            step("background", 2, ["background"], "origins-backgrounds"),
            step("role", 3, ["role"], "origins-roles"),
            step("elite", 4, ["elite advance"], "origins-elite-advances", true),
            step("divination", 5, ["divination"], "origins-divinations"),
        ],
    },
    dh1: {
        system: "wh40k-rpg",
        line: "dh1",
        actorTypes: actorTypes("dh1"),
        originSteps: [
            HOME_WORLD(1),
            step("career", 2, ["career"], "origins-careers"),
            step("background", 3, ["background"], "origins-backgrounds"),
            step("elite", 4, ["elite advance"], "origins-elite-advances", true),
            step("divination", 5, ["divination"], "origins-divinations"),
        ],
    },
    rt: {
        system: "wh40k-rpg",
        line: "rt",
        actorTypes: actorTypes("rt"),
        originSteps: [
            HOME_WORLD(1),
            step("birthright", 2, ["birthright"], "origins-birthrights"),
            step("lureOfTheVoid", 3, ["lure of the void"], "origins-lure-of-the-void"),
            step("trialsAndTravails", 4, ["trials and travails"], "origins-trials-and-travails"),
            step("motivation", 5, ["motivation"], "origins-motivations"),
            step("career", 6, ["career"], "origins-careers"),
            step("lineage", 7, ["lineage"], "origins-lineages"),
            step("eliteAdvance", 8, ["elite advance"], "origins-elite-advances", true),
        ],
    },
    dw: {
        system: "wh40k-rpg",
        line: "dw",
        actorTypes: actorTypes("dw"),
        originSteps: [
            step("chapter", 1, ["chapter"], "origins-chapters"),
            step("speciality", 2, ["speciality", "specialty"], "origins-specialities"),
        ],
    },
    ow: {
        system: "wh40k-rpg",
        line: "ow",
        actorTypes: actorTypes("ow"),
        originSteps: [
            HOME_WORLD(1),
            step("regimentType", 2, ["regiment type"], "origins-regiment-types"),
            step("commandingOfficer", 3, ["commanding officer"], "origins-commanding-officers"),
            step("trainingDoctrine", 4, ["training doctrine"], "origins-training-doctrines"),
            step(
                "specialEquipmentDoctrine",
                5,
                ["special equipment doctrine"],
                "origins-special-equipment-doctrines",
            ),
            step(
                "regimentalDrawback",
                6,
                ["regimental drawback", "drawback"],
                "origins-regimental-drawbacks",
            ),
            step("speciality", 7, ["speciality", "specialty"], "origins-specialities"),
        ],
    },
    bc: {
        system: "wh40k-rpg",
        line: "bc",
        actorTypes: actorTypes("bc"),
        originSteps: [
            step("race", 1, ["race"], "origins-races"),
            step("archetype", 2, ["archetype"], "origins-archetypes"),
            step("pride", 3, ["pride"], "origins-prides"),
            step("disgrace", 4, ["disgrace"], "origins-disgraces"),
            step("motivation", 5, ["motivation"], "origins-motivations"),
        ],
    },
    im: {
        system: "wh40k-rpg",
        line: "im",
        actorTypes: actorTypes("im"),
        originSteps: [
            HOME_WORLD(1, "origins-worlds"),
            step("background", 2, ["faction", "background"], "origins-factions"),
            step("role", 3, ["role"], "origins-roles"),
        ],
    },
};

export const DEFAULT_TARGET: TargetSchema = TARGETS[DEFAULT_LINE];

export const DND5E_TARGETS: Readonly<Record<Dnd5eRules, Dnd5eTarget>> = {
    "2014": { system: "dnd5e", id: "dnd5e-2014", rules: "2014", backgroundAbilityScores: null },
    "2024": {
        system: "dnd5e",
        id: "dnd5e-2024",
        rules: "2024",
        backgroundAbilityScores: { points: 3, cap: 2 },
    },
};

/** A target's id: the line id for a wh40k-rpg line, `dnd5e-<rules>` for a dnd5e ruleset. */
export function targetId(target: Target): string {
    return target.system === "dnd5e" ? target.id : target.line;
}

/** Every target id the user can choose, the wh40k-rpg lines first. */
export const TARGET_IDS: readonly string[] = [
    ...LINES,
    ...DND5E_RULES.map((rules) => DND5E_TARGETS[rules].id),
];

/** The target schema an id names, or null for an unknown id. */
export function targetFor(id: string): Target | null {
    const line = LINES.find((l) => l === id);
    if (line !== undefined) {
        return TARGETS[line];
    }
    const rules = DND5E_RULES.find((r) => DND5E_TARGETS[r].id === id);
    return rules === undefined ? null : DND5E_TARGETS[rules];
}
