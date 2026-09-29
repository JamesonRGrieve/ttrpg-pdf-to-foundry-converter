// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_LINE, LINES, type Line, type OriginStep } from "./schema.ts";

/**
 * Target schemas: the mechanical structure of each of the system's game lines
 * that the user can choose to write. A target is empty structure — the line's
 * id and its character-creation steps (the system's step keys, sequence,
 * labels and pack segments). It holds no entries and no values; the PDF
 * supplies every one. The engine never picks a target from the document.
 */

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
}

export interface TargetSchema {
    line: Line;
    actorTypes: ActorTypes;
    originSteps: readonly OriginStepDef[];
}

/** Lines the system registers a line-specific aircraft type for; the rest use the shared one. */
const LINE_AIRCRAFT: ReadonlySet<Line> = new Set(["dh2", "dw", "ow", "rt"]);

/** A line's own actor types, as the system registers them (`<line>-npc`, …). */
function actorTypes(line: Line): ActorTypes {
    return {
        npc: `${line}-npc`,
        terracraft: `${line}-terracraft`,
        aircraft: LINE_AIRCRAFT.has(line) ? `${line}-aircraft` : "aircraft",
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
        line: "dw",
        actorTypes: actorTypes("dw"),
        originSteps: [
            step("chapter", 1, ["chapter"], "origins-chapters"),
            step("speciality", 2, ["speciality", "specialty"], "origins-specialities"),
        ],
    },
    ow: {
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

/** The target schema a line id names, or null for an unknown id. */
export function targetFor(id: string): TargetSchema | null {
    const line = LINES.find((l) => l === id);
    return line === undefined ? null : TARGETS[line];
}
