// SPDX-License-Identifier: AGPL-3.0-or-later
import { headerRole, normalizeHeader } from "./columns.ts";
import type { Classification, ContentType, DetectedTable } from "./types.ts";

/**
 * Classify a detected table by what its column headers name. The signals are
 * the Foundry system's own field vocabulary (damage, penetration, armour
 * points, aptitudes, …) — no document-specific knowledge. Critical-effect and
 * ammunition tables are recognized by caption only: their columns ("effect",
 * "special") are shared with too many other tables to identify them.
 */

const WEAPON_DISCRIMINATORS = ["rof", "rate of fire", "class", "rld", "reload", "clip"];
const WEAPON_HEADERS = [
    "dam",
    "damage",
    "dmg",
    "pen",
    "penetration",
    "rof",
    "rate of fire",
    "clip",
    "rld",
    "reload",
    "range",
    "rng",
];
const ARMOUR_HEADERS = ["ap", "armour points", "armor points", "locations covered", "locations"];
const TALENT_HEADERS = ["aptitude", "prerequisite", "benefit"];
const PSYCHIC_HEADERS = ["focus time", "focus power", "sustained", "threshold", "overbleed"];
const SKILL_HEADERS = ["skill use", "skill group", "aptitude"];
const GEAR_SIGNALS = ["availability", "avail", "avl", "wt", "weight", "kg", "cost", "req", "requisition"];

/** Share of `pattern` terms that appear within some header. */
function headerOverlap(headers: readonly string[], pattern: readonly string[]): number {
    const hits = pattern.filter((p) => headers.some((h) => h.includes(p))).length;
    return hits / pattern.length;
}

const WEAPON_THRESHOLD = 0.1;
const MATCH_THRESHOLD = 0.3;

export function classifyTable(table: DetectedTable): Classification {
    const headers = table.headers.map(normalizeHeader);
    if (headers.length === 0) {
        return { contentType: "unknown", confidence: 0 };
    }

    // A ship component's space, ship points and hull types appear together in
    // no other table kind (a table of modifiers to them lists no hulls); one
    // that also prints damage is a ship weapon.
    if (
        headers.includes("space") &&
        headers.some((h) => h === "sp" || h === "ship points") &&
        headers.some((h) => headerRole(h) === "hullTypes")
    ) {
        // Damage may share a merged header ("Strength Damage").
        const armed = headers.some((h) => h.split(" ").some((w) => headerRole(w) === "damage"));
        return { contentType: armed ? "ship-weapon" : "ship-component", confidence: 0.9 };
    }

    const weaponScore = headerOverlap(headers, WEAPON_HEADERS);
    // Rate of fire, weapon class, reload and clip appear in no other table kind.
    if (
        headers.some((h) => WEAPON_DISCRIMINATORS.some((d) => h.includes(d))) &&
        weaponScore > WEAPON_THRESHOLD
    ) {
        return { contentType: "weapon", confidence: 0.9 };
    }

    const scores: [ContentType, number][] = [
        ["weapon", weaponScore],
        ["armour", headerOverlap(headers, ARMOUR_HEADERS)],
        ["talent", headerOverlap(headers, TALENT_HEADERS)],
        ["psychic-power", headerOverlap(headers, PSYCHIC_HEADERS)],
        ["skill", headerOverlap(headers, SKILL_HEADERS)],
    ];
    const [bestType, bestScore] = scores.reduce((best, s) => (s[1] > best[1] ? s : best));
    if (bestScore >= MATCH_THRESHOLD) {
        return { contentType: bestType, confidence: bestScore };
    }

    // A force-field catalogue lists each field's protection rating; a table of
    // overload chances alone (keyed by craftsmanship, say) is a rule lookup.
    if (headers.some((h) => h.includes("protection rating"))) {
        return { contentType: "force-field", confidence: 0.6 };
    }
    if (headers.some((h) => h === "ap" || h.includes("armour point"))) {
        return { contentType: "armour", confidence: 0.6 };
    }
    if (headers.some((h) => h.includes("modification") || h.includes("upgrade"))) {
        return { contentType: "weapon-mod", confidence: 0.6 };
    }
    // Signals are whole header words: "req" must not match inside "required".
    const gearSignals = GEAR_SIGNALS.filter((s) =>
        headers.some((h) => h.split(/[^a-z]+/u).includes(s)),
    ).length;
    if (gearSignals > 0) {
        return { contentType: "gear", confidence: gearSignals >= 2 ? 0.6 : 0.4 };
    }
    if (headers.some((h) => /^d\d+$/u.test(h) || h.includes("roll"))) {
        return { contentType: "rolltable", confidence: 0.6 };
    }
    return { contentType: "unknown", confidence: 0 };
}
