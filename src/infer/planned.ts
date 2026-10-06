// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Game systems the converter will write for, not yet readable: each one's
 * Foundry system id, the Foundry generations it runs on, and the Item types
 * its character options are written as — the first content each reader will
 * extract. A planned system is structure only, like any target; it becomes a
 * target (see `targets.ts`) when its reader lands, and until then the CLI
 * names it as planned and the page does not offer it.
 *
 * Every fact here is from the system's own published manifest and data
 * models.
 */

export interface PlannedSystem {
    /** The target id the user will choose (the system id). */
    target: string;
    /** The Foundry system id. */
    system: string;
    /** The system's own title. */
    title: string;
    /** Foundry generations its current release declares. */
    compatibility: { minimum: string; verified: string };
    /** The system's Item types its character options are written as. */
    characterOptionTypes: readonly string[];
}

export const PLANNED_SYSTEMS: readonly PlannedSystem[] = [
    {
        target: "pf2e",
        system: "pf2e",
        title: "Pathfinder Second Edition",
        compatibility: { minimum: "14", verified: "14" },
        characterOptionTypes: ["ancestry", "heritage", "background", "class", "feat"],
    },
    {
        target: "pf1",
        system: "pf1",
        title: "Pathfinder First Edition",
        compatibility: { minimum: "14", verified: "14" },
        characterOptionTypes: ["race", "class", "feat"],
    },
    {
        target: "starwarsffg",
        system: "starwarsffg",
        title: "Star Wars FFG",
        compatibility: { minimum: "13", verified: "13" },
        characterOptionTypes: [
            "species",
            "career",
            "specialization",
            "talent",
            "signatureability",
            "background",
            "motivation",
            "obligation",
        ],
    },
    {
        target: "od6s",
        system: "od6s",
        title: "OpenD6 Space",
        compatibility: { minimum: "13", verified: "14" },
        characterOptionTypes: [
            "species-template",
            "character-template",
            "skill",
            "specialization",
            "advantage",
            "disadvantage",
            "specialability",
        ],
    },
    {
        target: "cyberpunk-red-core",
        system: "cyberpunk-red-core",
        title: "Cyberpunk RED",
        compatibility: { minimum: "13", verified: "13" },
        characterOptionTypes: ["role", "skill"],
    },
];

/** The planned system a target id names, if any. */
export function plannedSystem(target: string): PlannedSystem | undefined {
    return PLANNED_SYSTEMS.find((p) => p.target === target);
}

/** Why a target id cannot be used: planned but not readable yet, or not a target at all. */
export function unavailableTarget(target: string, available: readonly string[]): string {
    const planned = plannedSystem(target);
    if (planned !== undefined) {
        return `--target ${target}: the ${planned.title} system (${planned.system}) is planned, not available yet; choose one of ${available.join(", ")}`;
    }
    return `--target must be one of ${available.join(", ")}, got ${JSON.stringify(target)}`;
}
