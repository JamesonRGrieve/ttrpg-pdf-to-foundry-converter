// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import type { Role } from "./columns.ts";
import {
    isEmptyCell,
    parseArmourPoints,
    parseAvailability,
    parseCoverage,
    parseDamage,
    parseHullTypes,
    parseInteger,
    parseQualities,
    parseRange,
    parseRateOfFire,
    parseReload,
    parseRenown,
    parseSecondaryClass,
    parseShipPower,
    parseShipWeaponType,
    parseWeaponClass,
    parseWeight,
    BODY_LOCATIONS,
} from "./notation.ts";
import type { ItemType } from "./schema.ts";

/**
 * One table row, keyed by field role, → the type-specific `system` fields and
 * per-line rules content of an item. A cell that does not parse as its role's
 * notation is reported, never guessed.
 */

export type RowCells = Partial<Record<Role, string>>;

export interface RowMapping {
    system: JsonObject;
    variantized: Record<string, JsonValue>;
    /** Cells that could not be read as their role's notation: `role: text`. */
    unparsed: string[];
}

const RANGED_CHARACTERISTIC = "ballisticSkill";
const MELEE_CHARACTERISTIC = "weaponSkill";
/** The damage formula for a weapon whose damage cell prints a dash. */
const NO_DAMAGE = "-";
/** The schema's initial damage type, for a profile that prints none. */
const INITIAL_DAMAGE_TYPE = "impact";

function mapping(): RowMapping {
    return { system: {}, variantized: {}, unparsed: [] };
}

/** A cell that prints a value (not absent, empty or a dash). */
const filled = (cell: string | undefined): cell is string => cell !== undefined && !isEmptyCell(cell);

/** Parse `cells[role]` with `parse`; record it as unparsed when present but unreadable. */
function read<T>(out: RowMapping, cells: RowCells, role: Role, parse: (s: string) => T | null): T | null {
    const text = cells[role];
    // A dash or empty cell means the value does not apply: absent, not unreadable.
    if (text === undefined || isEmptyCell(text)) {
        return null;
    }
    const value = parse(text);
    if (value === null) {
        out.unparsed.push(`${role}: ${text}`);
    }
    return value;
}

function commonPhysical(out: RowMapping, cells: RowCells): void {
    // A dash in a printed weight column is a negligible weight.
    const weight =
        cells.weight !== undefined && !filled(cells.weight) ? 0 : read(out, cells, "weight", parseWeight);
    if (weight !== null) {
        out.system["weight"] = weight;
    }
    const availability = read(out, cells, "availability", parseAvailability);
    if (availability !== null) {
        out.system["availability"] = availability;
    }
    const renown = read(out, cells, "renown", parseRenown);
    if (renown !== null) {
        out.system["renown"] = renown;
    }
    out.system["craftsmanship"] = "common";
    out.system["quantity"] = 1;
}

function weapon(cells: RowCells): RowMapping {
    const out = mapping();
    const cls = read(out, cells, "class", parseWeaponClass);
    const range = read(out, cells, "range", parseRange);
    const rof = read(out, cells, "rof", parseRateOfFire);
    const damage = read(out, cells, "damage", parseDamage);
    const pen = read(out, cells, "penetration", parseInteger);
    const clip = read(out, cells, "clip", parseInteger);
    const reload = read(out, cells, "reload", parseReload);
    const melee = cls === "melee";
    const thrown = cls === "thrown" || (range !== null && range.special !== "");
    if (cls !== null) {
        out.system["class"] = cls;
        const secondary = cells.class === undefined ? null : parseSecondaryClass(cells.class);
        if (secondary !== null) {
            out.system["secondaryClass"] = secondary;
        }
    }
    out.system["melee"] = melee;
    out.system["attack"] = {
        type: melee ? "melee" : thrown ? "thrown" : "ranged",
        characteristic: melee ? MELEE_CHARACTERISTIC : RANGED_CHARACTERISTIC,
        modifier: 0,
        range: range === null ? { value: 0, units: "m", special: "" } : { ...range },
        rateOfFire: rof === null ? { single: false, semi: 0, full: 0 } : { ...rof },
    };
    if (cells.damage !== undefined || cells.penetration !== undefined) {
        out.system["damage"] = {
            // A printed dash stays the notation's "no damage"; an unprinted
            // type takes the schema's initial value.
            formula: damage?.formula ?? (filled(cells.damage) ? "" : NO_DAMAGE),
            type: damage === null || damage.type === "" ? INITIAL_DAMAGE_TYPE : damage.type,
            bonus: damage?.bonus ?? 0,
            penetration: pen ?? 0,
        };
    }
    out.system["special"] = cells.special === undefined ? [] : parseQualities(cells.special);
    out.system["clip"] = { max: clip ?? 0, value: clip ?? 0, type: "" };
    out.system["reload"] = reload ?? "-";
    out.system["modifications"] = [];
    commonPhysical(out, cells);
    return out;
}

function armour(cells: RowCells): RowMapping {
    const out = mapping();
    const ap = read(out, cells, "armourPoints", parseArmourPoints);
    const covered =
        read(out, cells, "locations", parseCoverage) ?? (ap === null ? null : [...BODY_LOCATIONS]);
    if (ap !== null && covered !== null) {
        const points: JsonObject = {};
        for (const loc of BODY_LOCATIONS) {
            points[loc] = covered.includes(loc) ? (ap.exceptions[loc] ?? ap.base) : 0;
        }
        out.variantized["armourPoints"] = points;
        out.variantized["coverage"] = covered;
    } else if (cells.armourPoints !== undefined && !filled(cells.armourPoints)) {
        // A dash for armour points: the item protects no location.
        out.variantized["armourPoints"] = Object.fromEntries(BODY_LOCATIONS.map((loc) => [loc, 0]));
    }
    const maxAg = read(out, cells, "maxAgility", parseInteger);
    out.variantized["maxAgility"] = maxAg;
    out.system["modifications"] = [];
    commonPhysical(out, cells);
    return out;
}

/** `01-10` / `1–5` → the inclusive d100 band. */
function parseBand(raw: string): { min: number; max: number } | null {
    const m = /^(\d+)\s*[-–]\s*(\d+)$/u.exec(raw.trim());
    return m === null ? null : { min: Number(m[1]), max: Number(m[2]) };
}

function forceField(cells: RowCells): RowMapping {
    const out = mapping();
    const protection = read(out, cells, "protection", parseInteger);
    if (protection !== null) {
        out.variantized["protectionRating"] = protection;
    }
    const band = read(out, cells, "overload", parseBand);
    if (band !== null) {
        out.variantized["overloadMin"] = band.min;
        out.variantized["overloadMax"] = band.max;
    }
    commonPhysical(out, cells);
    return out;
}

/** A ship component: the hulls it fits, the power it draws or makes, its space and ship points. */
function shipComponent(cells: RowCells): RowMapping {
    const out = shipFit(cells);
    const power = read(out, cells, "power", parseShipPower);
    if (power !== null) {
        out.system["power"] = power;
    }
    return out;
}

/** What any ship component takes to fit: the hulls it fits, its space and ship points. */
function shipFit(cells: RowCells): RowMapping {
    const out = mapping();
    const hulls = read(out, cells, "hullTypes", parseHullTypes);
    if (hulls !== null) {
        out.system["hullType"] = hulls;
    }
    const space = read(out, cells, "space", parseInteger);
    if (space !== null) {
        out.system["space"] = space;
    }
    const points = read(out, cells, "shipPoints", parseInteger);
    if (points !== null) {
        out.system["shipPoints"] = points;
    }
    return out;
}

/**
 * A ship weapon: a ship component that also strikes — its strength, damage
 * (one dice expression), critical rating and range; its weapon type is the
 * table's group row naming it ("Lances").
 */
function shipWeapon(cells: RowCells): RowMapping {
    const out = shipFit(cells);
    // A weapon draws power; its schema field is the amount drawn.
    const power = read(out, cells, "power", parseShipPower);
    if (power !== null) {
        out.system["power"] = power.used;
    }
    const weaponType = read(out, cells, "type", parseShipWeaponType);
    if (weaponType !== null) {
        out.system["weaponType"] = weaponType;
    }
    for (const [role, key] of [
        ["strength", "strength"],
        ["crit", "crit"],
        ["range", "range"],
    ] as const) {
        const value = read(out, cells, role, parseInteger);
        if (value !== null) {
            out.system[key] = value;
        }
    }
    const damage = read(out, cells, "damage", parseDamage);
    if (damage !== null) {
        const bonus = damage.bonus === 0 ? "" : `${damage.bonus > 0 ? "+" : ""}${damage.bonus}`;
        out.system["damage"] = `${damage.formula}${bonus}`;
    }
    return out;
}

/** Items whose rules text is a single prose column, stored in the per-line `field`. */
function effectItem(cells: RowCells, field: "effect" | "uses", physical: boolean): RowMapping {
    const out = mapping();
    const effect = cells.effect ?? cells.benefit;
    if (effect !== undefined && !isEmptyCell(effect)) {
        out.variantized[field] = effect.trim();
    }
    if (physical) {
        commonPhysical(out, cells);
    }
    return out;
}

/** `Agility, Offence` / `Agility` + second column → aptitude names. */
function parseAptitudes(raw: string): string[] {
    return raw
        .split(/,|\//u)
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && !isEmptyCell(a));
}

function talent(cells: RowCells): RowMapping {
    const out = mapping();
    const tier = read(out, cells, "tier", (s) => {
        const n = /(\d)/u.exec(s);
        return n === null ? null : Number(n[1]);
    });
    if (tier !== null) {
        out.system["tier"] = tier;
    }
    out.system["aptitudes"] = cells.aptitudes === undefined ? [] : parseAptitudes(cells.aptitudes);
    const prereq = cells.prerequisites;
    out.system["prerequisites"] = { text: prereq === undefined || isEmptyCell(prereq) ? "" : prereq.trim() };
    if (cells.benefit !== undefined) {
        out.system["benefit"] = cells.benefit.trim();
    }
    return out;
}

function psychicPower(cells: RowCells): RowMapping {
    const out = mapping();
    const text = (role: Role, field: string): void => {
        const value = cells[role];
        if (value !== undefined && !isEmptyCell(value)) {
            out.system[field] = value.trim();
        }
    };
    text("focusPower", "focusPower");
    text("action", "action");
    text("range", "range");
    text("sustained", "sustained");
    text("subtype", "subtype");
    text("prerequisites", "prerequisites");
    if (cells.effect !== undefined) {
        out.variantized["effect"] = cells.effect.trim();
    }
    return out;
}

function trait(cells: RowCells): RowMapping {
    const out = mapping();
    if (cells.benefit !== undefined) {
        out.system["benefit"] = cells.benefit.trim();
    }
    return out;
}

/**
 * A weapon-table row that prints damage but no class, range, rate of fire or
 * clip is not wielded: it is a load fired from another weapon (a shell or
 * warhead). A row with a clip holds its own charge.
 */
export function isLoadRow(cells: RowCells): boolean {
    return filled(cells.damage) && ![cells.class, cells.range, cells.rof, cells.clip].some(filled);
}

/** A weapon's profile columns, each with the notation its values are printed in. */
const WEAPON_PROFILE: readonly [Role, (s: string) => unknown][] = [
    ["class", parseWeaponClass],
    ["range", parseRange],
    ["rof", parseRateOfFire],
    ["damage", parseDamage],
    ["penetration", parseInteger],
    ["clip", parseInteger],
];

/** A protective item's profile columns, each with the notation its values are printed in. */
const ARMOUR_PROFILE: readonly [Role, (s: string) => unknown][] = [
    ["armourPoints", parseArmourPoints],
    ["locations", parseCoverage],
    ["maxAgility", parseInteger],
    ["protection", parseInteger],
    ["weight", parseWeight],
];

/** Item types whose table rows must print a readable profile to be items. */
const PROFILES: Partial<Record<ItemType, readonly [Role, (s: string) => unknown][]>> = {
    weapon: WEAPON_PROFILE,
    armour: ARMOUR_PROFILE,
};

/**
 * The item type a row of a `type` table is: a weapon table's load rows are
 * ammunition, and a row with no readable profile is no item (a wrapped section
 * label, page decoration, or a table that only mentions such items).
 */
export function rowType(type: ItemType, cells: RowCells): ItemType | null {
    const profile = PROFILES[type];
    if (profile === undefined) {
        return type;
    }
    const readable = profile.some(([role, parse]) => {
        const cell = cells[role];
        return filled(cell) && parse(cell) !== null;
    });
    if (!readable) {
        return null;
    }
    if (type !== "weapon") {
        return type;
    }
    return isLoadRow(cells) ? "ammunition" : "weapon";
}

/** A load's profile, as printed: its damage, penetration and qualities become its effect. */
function load(cells: RowCells): RowMapping {
    const out = mapping();
    const { damage, penetration, special } = cells;
    out.variantized["effect"] = [
        damage,
        filled(penetration) ? `Pen ${penetration.trim()}` : undefined,
        special,
    ]
        .filter(filled)
        .map((c) => c.trim())
        .join(", ");
    out.variantized["addedQualities"] = filled(special) ? parseQualities(special) : [];
    commonPhysical(out, cells);
    return out;
}

const PHYSICAL_EFFECT: ReadonlySet<ItemType> = new Set([
    "gear",
    "cybernetic",
    "weaponModification",
    "armourModification",
]);

export function mapRow(type: ItemType, cells: RowCells): RowMapping {
    switch (type) {
        case "weapon":
            return weapon(cells);
        case "armour":
            return armour(cells);
        case "forceField":
            return forceField(cells);
        case "talent":
            return talent(cells);
        case "trait":
            return trait(cells);
        case "psychicPower":
            return psychicPower(cells);
        case "skill":
            return effectItem(cells, "uses", false);
        case "ammunition":
            return isLoadRow(cells) ? load(cells) : effectItem(cells, "effect", true);
        case "gear":
        case "cybernetic":
        case "weaponModification":
        case "armourModification":
        case "criticalInjury":
        case "condition":
        case "mutation":
        case "malignancy":
        case "mentalDisorder":
        case "order":
            return effectItem(cells, "effect", PHYSICAL_EFFECT.has(type));
        case "shipComponent":
            return shipComponent(cells);
        case "shipWeapon":
            return shipWeapon(cells);
    }
}
