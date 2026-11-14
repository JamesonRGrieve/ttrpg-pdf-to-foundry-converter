// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity } from "../types/entity.ts";

/**
 * `system.identifier`: the stable key the wh40k-rpg system matches items by
 * (origin-path requirements, weapon-type ammunition lookups, de-duplication).
 * The system fills a blank one from the name only when an item is created in
 * a world, never for a compendium document, so a converted pack writes it.
 * The form is the system's own (`identifierFromName`, kebab-case of the name's
 * letters, digits, spaces and hyphens); a printed name is the only input.
 */

/** Item types whose schema carries an `identifier` field (wh40k-rpg item DataModels). */
export const IDENTIFIED_ITEM_TYPES: ReadonlySet<string> = new Set([
    "ammunition",
    "armour",
    "armourModification",
    "condition",
    "criticalInjury",
    "cybernetic",
    "darkPact",
    "forceField",
    "gear",
    "malignancy",
    "medal",
    "mentalDisorder",
    "mutation",
    "navigatorPower",
    "oath",
    "order",
    "originPath",
    "psychicPower",
    "ritual",
    "shipComponent",
    "shipRole",
    "specialAbility",
    "shipUpgrade",
    "shipWeapon",
    "skill",
    "talent",
    "trait",
    "vehicleTrait",
    "vehicleUpgrade",
    "weaponModification",
    "weaponQuality",
    "weapon",
]);

/** The system's identifier for a name: lower case, other than letters/digits/spaces/hyphens dropped, spaces to hyphens. */
export function identifierFromName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/gu, "")
        .replace(/\s+/gu, "-")
        .replace(/-+/gu, "-")
        .replace(/^-|-$/gu, "");
}

/**
 * Types whose names may close on a specialisation placeholder ("(X)",
 * "(+X)"): the placeholder stands for the specialisation an owner picks and is
 * no part of the talent or trait itself, so its identifier leaves it out.
 */
const SPECIALISED_TYPES: ReadonlySet<string> = new Set(["talent", "trait"]);

/** A trailing specialisation placeholder: "(X)", "(+X)", "(x)". */
const PLACEHOLDER = /\s*\(\s*\+?\s*x\s*\)\s*$/iu;

/** The identifier of an item of `type` named `name`. */
export function identifierFor(type: string, name: string): string {
    return identifierFromName(SPECIALISED_TYPES.has(type) ? name.replace(PLACEHOLDER, "") : name);
}

/** Give every identified item an identifier from its name where it has none. */
export function applyIdentifiers(entities: readonly Entity[]): void {
    for (const e of entities) {
        const type = e.fields["type"];
        const system = e.fields["system"];
        if (
            e.documentType !== "Item" ||
            typeof type !== "string" ||
            !IDENTIFIED_ITEM_TYPES.has(type) ||
            typeof system !== "object" ||
            system === null ||
            Array.isArray(system)
        ) {
            continue;
        }
        const current = system["identifier"];
        if (typeof current === "string" && current !== "") {
            continue;
        }
        const id = identifierFor(type, String(e.fields["name"] ?? ""));
        if (id !== "") {
            system["identifier"] = id;
        }
    }
}
