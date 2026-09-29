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
    | "advance";

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
    [/^(special|special rules|qualities)$/u, "special"],
    [/^(wt|weight|kg)$/u, "weight"],
    [/^(avl|avail|availability)$/u, "availability"],
    [/^(cost|price)$/u, "cost"],
    [/^(ap|armou?r points?)$/u, "armourPoints"],
    [/^(locations?( covered)?|location s covered|coverage)$/u, "locations"],
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
];

export function normalizeHeader(header: string): string {
    return (
        header
            // Letter-spaced display text ("D AM") collapses to the word it spells.
            .replace(/\b(\p{Lu}) (?=\p{Lu}\b|\p{Lu}{2,})/gu, "$1")
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
const SCALE_ROLES: ReadonlySet<Role> = new Set(["availability", "weight", "cost"]);

/**
 * A table led by an attribute column (its rows keyed by availability, weight
 * or cost) is a scale of that attribute, not a catalogue of items.
 */
export function isAttributeScale(leadRoles: readonly Role[] | null | undefined): boolean {
    return leadRoles?.some((r) => SCALE_ROLES.has(r)) ?? false;
}

/**
 * A table keyed by "Advance" lists what a character may buy — skills,
 * talents and the like side by side, each with its price — and defines none
 * of them: it is no catalogue.
 */
export function isAdvanceList(leadRoles: readonly Role[] | null | undefined): boolean {
    return leadRoles?.includes("advance") ?? false;
}
