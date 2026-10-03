// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Table header → field role. A role is a slot in the Foundry system's schema
 * (damage, penetration, rate of fire, armour points, …); the header spellings
 * recognized here are the schema's own field names and their standard short
 * forms. Nothing here names any document's content.
 */

export type Role =
    | "name"
    | "class"
    | "range"
    | "rof"
    | "damage"
    | "penetration"
    | "clip"
    | "reload"
    | "special"
    | "weight"
    | "availability"
    | "renown"
    | "cost"
    | "armourPoints"
    | "locations"
    | "maxAgility"
    | "aptitudes"
    | "prerequisites"
    | "benefit"
    | "tier"
    | "effect"
    | "type"
    | "protection"
    | "overload"
    | "focusPower"
    | "action"
    | "sustained"
    | "subtype"
    | "roll"
    | "advance"
    | "space"
    | "shipPoints"
    | "hullTypes"
    | "power"
    | "strength"
    | "crit";

/** Normalized header text (or a word within it) → role. Order matters: first match wins. */
const HEADER_ROLES: readonly [RegExp, Role][] = [
    [/^(names?|(?:weapon|item|armou?r|talent|trait|skill|power)s?(?: (?:name|type))?)$/u, "name"],
    [/^(class|cls)$/u, "class"],
    [/^(range|rng)$/u, "range"],
    [/^(rof|rate of fire)$/u, "rof"],
    [/^(dam|dmg|damage)$/u, "damage"],
    [/^(pen|penetration)$/u, "penetration"],
    [/^(clip|mag|magazine)$/u, "clip"],
    [/^(rld|reload)$/u, "reload"],
    // A special column may name a further list it holds ("Special + Attributes").
    [/^(special( .+)?|qualities)$/u, "special"],
    [/^(wt|weight|kg)$/u, "weight"],
    // By its stem, so a misread letter later in the word ("Availabiity") still names it.
    [/^(avl|avail[a-z]*)$/u, "availability"],
    [/^renown$/u, "renown"],
    [/^(cost|price)$/u, "cost"],
    [/^(ap|armou?r points?)$/u, "armourPoints"],
    // A two-line header may reach us as its second line alone ("Covered").
    [/^(locations?( ?covered)?|covered|coverage)$/u, "locations"],
    [/^(max ag|max agility|maxag)$/u, "maxAgility"],
    [/^(aptitudes?|aptitude \d)$/u, "aptitudes"],
    [/^(prerequisites?|requirements?)$/u, "prerequisites"],
    [/^(benefit|benefits|description)$/u, "benefit"],
    [/^tier$/u, "tier"],
    [/^(effect|effects)$/u, "effect"],
    [/^(type)$/u, "type"],
    [/^(protection|protection rating)$/u, "protection"],
    [/^(overload|overload chance)$/u, "overload"],
    [/^(focus power|focus power test|focus test)$/u, "focusPower"],
    [/^(action|focus time)$/u, "action"],
    [/^(sustained|sustain)$/u, "sustained"],
    [/^(subtype|sub type|keywords?)$/u, "subtype"],
    [/^(d\d+|roll|result)$/u, "roll"],
    [/^advances?$/u, "advance"],
    [/^space$/u, "space"],
    [/^(sp|ship points)$/u, "shipPoints"],
    [/^(appropriate )?hull types?$/u, "hullTypes"],
];

/**
 * Headers that name a ship component's own fields only in a ship table: its
 * power drawn or made, and a ship weapon's strength and critical rating.
 */
const SHIP_TABLE_ROLES: readonly [RegExp, Role][] = [
    [/^power$/u, "power"],
    [/^(str|strength)$/u, "strength"],
    [/^crit( rating)?$/u, "crit"],
];

const shipRole = (header: string): Role | undefined => SHIP_TABLE_ROLES.find(([re]) => re.test(header))?.[1];

/**
 * In a table of ship components — one with space and ship-point columns — a
 * "Power" column is the power a component draws or makes, not a name, and a
 * ship weapon's "Strength" and "Crit Rating" are its own fields, alone or in
 * a merged header ("Strength Damage").
 */
export function shipTableRoles(
    roles: readonly (readonly Role[] | null)[],
    headers: readonly string[],
): (Role[] | null)[] {
    const flat = roles.flatMap((r) => r ?? []);
    const shipTable = flat.includes("space") && flat.includes("shipPoints");
    return roles.map((r, i) => {
        const header = normalizeHeader(headers[i] ?? "");
        const whole = shipTable ? shipRole(header) : undefined;
        if (whole !== undefined) {
            return [whole];
        }
        // A merged header naming a ship field reads word by word, when every word is a field.
        const words = header.split(" ");
        if (shipTable && words.length > 1 && words.some((w) => shipRole(w) !== undefined)) {
            const merged = words.map((w) => shipRole(w) ?? headerRole(w));
            if (merged.every((m): m is Role => m !== null && m !== undefined)) {
                return merged;
            }
        }
        return r === null ? null : [...r];
    });
}

export function normalizeHeader(header: string): string {
    return (
        header
            // Letter-spaced display text ("D AM") collapses to the word it spells.
            .replace(/\b(\p{Lu}) (?=\p{Lu}\b|\p{Lu}{2,})/gu, "$1")
            // An optional plural ("Location(s)") is the plural.
            .replace(/\(s\)/giu, "s")
            .toLowerCase()
            .replace(/[^a-z0-9 ]+/gu, " ")
            .replace(/\s+/gu, " ")
            .trim()
    );
}

/** A header's role, or null when it names no schema slot. */
export function headerRole(header: string): Role | null {
    const norm = normalizeHeader(header);
    for (const [re, role] of HEADER_ROLES) {
        if (re.test(norm)) {
            return role;
        }
    }
    return null;
}

/**
 * The roles named by a header that merges several columns ("Clip Rld",
 * "Wt Avl"), in order — or null when the header is not such a merge. Every
 * word must itself name a role.
 */
export function mergedHeaderRoles(header: string): Role[] | null {
    const words = normalizeHeader(header).split(" ");
    if (words.length < 2) {
        return null;
    }
    const roles: Role[] = [];
    for (const word of words) {
        const role = headerRole(word);
        if (role === null) {
            return null;
        }
        roles.push(role);
    }
    return roles;
}

/** Item attributes that grade items but never name one. */
const SCALE_ROLES: ReadonlySet<Role> = new Set(["availability", "renown", "weight", "cost"]);

/**
 * A table led by an attribute column (its rows keyed by availability, weight
 * or cost) is a scale of that attribute, not a catalogue of items.
 */
export function isAttributeScale(leadRoles: readonly Role[] | null | undefined): boolean {
    return leadRoles?.some((r) => SCALE_ROLES.has(r)) ?? false;
}

/**
 * A table of what a character may buy — skills, talents and the like side by
 * side, each with its price — defines none of them: it is no catalogue. It is
 * keyed by "Advance", or prices rows gated by prerequisites (a catalogue of
 * talents names prerequisites but no price; a catalogue of goods, a price but
 * no prerequisites).
 */
export function isAdvanceList(roles: readonly Role[] | null | undefined): boolean {
    return (
        (roles?.includes("advance") ?? false) ||
        ((roles?.includes("cost") ?? false) && (roles?.includes("prerequisites") ?? false))
    );
}
