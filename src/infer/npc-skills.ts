// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject } from "../types/entity.ts";
import { CHARACTERISTICS } from "./entry-types.ts";
import { splitTopLevel } from "./origin-paths.ts";

/**
 * A statblock's printed skills line → the schema's `trainedSkills`: a sparse
 * map keyed by skill, each skill an advancement at its printed rank. The
 * notation is the one statblocks print — `Name (Specialisation) (Char) +20` —
 * and the map's shape is the NPC data model's own.
 */

/** One skill a statblock lists. */
export interface ListedSkill {
    /** The schema's key for the skill: its name without parentheticals, lower camel case. */
    key: string;
    /** The printed name, its specialisation kept, its characteristic tag and rank dropped. */
    name: string;
    specialization: string;
    /** The schema's characteristic key, "" when the line prints none. */
    characteristic: string;
    /** Rank 1–4: known, then one per +10 printed. */
    advance: number;
    /** What a printed modifier adds beyond the top rank. */
    bonus: number;
}

/** A skill's name as the schema keys skills: lower camel case ("Forbidden Lore" → `forbiddenLore`). */
export const skillKey = (name: string): string =>
    name
        .trim()
        .split(/[\s/-]+/u)
        .filter((w) => w.length > 0)
        .map((w, i) =>
            i === 0 ? w.toLowerCase() : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`,
        )
        .join("");

/** An entry recording that the statblock has no skills. */
const NO_SKILLS = /^(?:none|n\/a|[-–—]{1,2})$/iu;
/** A printed rank modifier closing an entry: "+20". */
const RANK_CLOSE = /\+\s*(?<plus>\d+)\s*$/u;
/** A parenthetical closing an entry. */
const PAREN_CLOSE = /\((?<inner>[^()]*)\)\s*$/u;
/** A rank modifier printed inside the specialisation's brackets: "(Wards +10)". */
const RANK_INSIDE = /\((?<spec>[^()]*?)\s*(?<plus>\+\s*\d+)\s*\)\s*$/u;
/** Points of modifier per rank above known. */
const RANK_STEP = 10;
/** The top rank: known plus three steps. */
const TOP_RANK = 4;

/** A characteristic tag printed in a longer abbreviation than the schema's own. */
const TAG_ALIASES: Readonly<Record<string, string>> = { str: "strength" };
/** The schema's characteristic key a bracket's text tags, if it is a tag. */
const taggedCharacteristic = (inner: string): string | undefined => {
    const tag = inner.trim().toLowerCase();
    return CHARACTERISTICS[tag] ?? TAG_ALIASES[tag];
};

/** One bracket listing several specialisations, at least one at a rank of its own: "(Reeds +20, Tides)". */
const RANKED_SPECIALISATIONS = /^(?<base>[^()]+?)\s*\((?<inner>[^()]*,[^()]*)\)(?<tail>.*)$/su;

/**
 * A skill printed once over specialisations at ranks of their own ("Lore
 * (Reeds +20, Tides +10) (Int)") is that skill once per specialisation, each
 * at its rank; specialisations sharing the skill's one rank stay one entry.
 */
function perSpecialisation(entry: string): string[] {
    const groups = RANKED_SPECIALISATIONS.exec(entry)?.groups;
    const inner = groups?.["inner"] ?? "";
    if (groups === undefined || !/\+\s*\d+/u.test(inner)) {
        return [entry];
    }
    return inner
        .split(",")
        .map((spec) => spec.trim())
        .filter((spec) => spec.length > 0)
        .map((spec) => {
            const rank = RANK_CLOSE.exec(spec);
            const name = rank === null ? spec : spec.slice(0, rank.index).trim();
            return `${groups["base"] ?? ""} (${name})${groups["tail"] ?? ""}${rank === null ? "" : ` ${rank[0]}`}`;
        });
}

/** The skills a printed line lists, in order. */
/**
 * A printed skill list with its print noise evened out: full-width brackets
 * as plain ones, a rank's sign set apart from its figure ("+ 10"), a full
 * stop standing for the comma between entries, footnote marks, and a
 * bracket closed twice or opened never ("Barter Fel) +20").
 */
function printedList(line: string): string {
    return (
        line
            .normalize("NFKC")
            .replace(/[†‡*]+/gu, "")
            .replace(/\+\s+(\d)/gu, "+$1")
            .replace(/([)\d])\.\s+(?=\p{Lu})/gu, "$1, ")
            // A figure in brackets after a rank ("+20 (2)") is a callout, not the entry's.
            .replace(/(\+\d+)\s*\(\d+\)/gu, "$1")
            // A rank after a closed tag, closed again ("(Fel) +20)"): the second bracket is stray.
            .replace(/(\)\s*\+\d+)\)/gu, "$1")
            // A bracket closed twice after a tag ("(S))"), or left after a comma.
            .replace(/(\((?:WS|BS|S|T|Ag|Int|Per|WP|Fel)\))\)/gu, "$1")
            .replace(/(\+\d+|\((?:WS|BS|S|T|Ag|Int|Per|WP|Fel)\)),\s*\)/gu, "$1,")
            // A list inside brackets closed after a comma ("(Reeds, Tides,)").
            .replace(/,\s*\)/gu, ")")
            // A note in brackets after the entry's tag or rank ("(Ag) (against …)")
            // qualifies it; a specialisation comes before them.
            .replace(/(\((?:WS|BS|S|T|Ag|Int|Per|WP|Fel)\)|\+\d+)\s*\(\s*\p{Ll}[^()]*\)/gu, "$1")
            // A rank run into the next entry with no comma ("+10 Search").
            .replace(/(\+\d+)\s+(?=\p{Lu})/gu, "$1, ")
            .replace(/(^|,\s*)([^,()]+?)\s+(WS|BS|S|T|Ag|Int|Per|WP|Fel)\)/gu, "$1$2 ($3)")
    );
}

export function listedSkills(line: string): ListedSkill[] {
    const out: ListedSkill[] = [];
    // A characteristic tag closes its entry: one run into the next with no
    // comma ("Concealment (Ag) Deceive (Fel)") is two.
    const separated = printedList(line).replace(
        /\(([^()]{1,4})\)((?:\s*\+\d+)?)\s+(?=\p{Lu})/gu,
        (whole, inner: string, rank: string) =>
            taggedCharacteristic(inner) === undefined ? whole : `(${inner})${rank}, `,
    );
    for (const entry of splitTopLevel(separated, /^,\s*/u).flatMap(perSpecialisation)) {
        let name = entry
            .replace(/[.;\s]+$/u, "")
            // The list's closing conjunction ("…, and Tracking") is not part of the name.
            .replace(/^(?:and|or)\s+/iu, "")
            // A lore printed kind-last ("Lore: Scholastic (Wards)") is the "Scholastic Lore" skill.
            .replace(/^Lore:\s*(\p{L}+)\b/u, "$1 Lore")
            .replace(RANK_INSIDE, "($<spec>) $<plus>")
            // A rank printed alone in brackets ("(+20)") leaves none behind.
            .replace(/\s*\(\s*\)/gu, "")
            .trim();
        // Trailing groups come in either order ("(Ag) +20", "+10 (Int)"): peel
        // them until neither closes the entry, keeping the highest rank.
        let plus = 0;
        let characteristic = "";
        for (;;) {
            const rank = RANK_CLOSE.exec(name);
            if (rank !== null) {
                plus = Math.max(plus, Number(rank.groups?.["plus"] ?? "0"));
                name = name.slice(0, rank.index).trim();
                continue;
            }
            const paren = PAREN_CLOSE.exec(name);
            const tagged = taggedCharacteristic(paren?.groups?.["inner"] ?? "");
            if (paren !== null && tagged !== undefined) {
                characteristic = tagged;
                name = name.slice(0, paren.index).trim();
                continue;
            }
            break;
        }
        // A tag printed before the specialisation ("Lore (Int) (Reeds)") is
        // the characteristic all the same.
        name = name
            .replace(/\s*\(([^()]*)\)/gu, (whole, inner: string) => {
                const tagged = taggedCharacteristic(inner);
                if (tagged === undefined || characteristic !== "") {
                    return whole;
                }
                characteristic = tagged;
                return "";
            })
            .trim();
        const key = skillKey(name.replace(/\([^()]*\)/gu, " "));
        // A skill's name is capitalised: running text in the list ("any others as needed") is none.
        if (key.length === 0 || NO_SKILLS.test(name) || /^\p{Ll}/u.test(name)) {
            continue;
        }
        const advance = Math.min(TOP_RANK, Math.floor(plus / RANK_STEP) + 1);
        out.push({
            key,
            name,
            specialization: PAREN_CLOSE.exec(name)?.groups?.["inner"]?.trim() ?? "",
            characteristic,
            advance,
            bonus: Math.max(0, plus - (advance - 1) * RANK_STEP),
        });
    }
    return out;
}

/**
 * Whether a listed skill read whole: outside its brackets its name is words
 * alone. A rank or a number left in it ("Wading (S) +10 8", a callout beside
 * the line; "Hush +20 (2)") shows the entry was not all skill.
 */
export function readsWhole(skill: ListedSkill): boolean {
    return !/[+\d]/u.test(skill.name.replace(/\([^()]*\)/gu, " "));
}

/** The rank's cumulative mirrors, as the data model derives them. */
const rankFlags = (advance: number): JsonObject => ({
    trained: advance >= 1,
    plus10: advance >= 2,
    plus20: advance >= 3,
    plus30: advance >= TOP_RANK,
});

/**
 * The schema's `trainedSkills` for a statblock's listed skills. A skill
 * listed once is one row, its specialisation kept in its name; one listed
 * under several specialisations is a base row at rank 0 with an entry per
 * specialisation, each at its own rank. A specialisation printed twice
 * counts once, at its higher rank.
 */
export function trainedSkillsOf(skills: readonly ListedSkill[]): JsonObject {
    const groups = new Map<string, Map<string, ListedSkill>>();
    for (const skill of skills) {
        const bySpec = groups.get(skill.key) ?? new Map<string, ListedSkill>();
        groups.set(skill.key, bySpec);
        const prior = bySpec.get(skill.specialization);
        if (
            prior === undefined ||
            skill.advance > prior.advance ||
            (skill.advance === prior.advance && skill.bonus > prior.bonus)
        ) {
            bySpec.set(skill.specialization, skill);
        }
    }
    const trained: JsonObject = {};
    for (const [key, bySpec] of groups) {
        const [first, ...rest] = [...bySpec.values()];
        if (first === undefined) {
            continue;
        }
        if (rest.length === 0) {
            trained[key] = {
                name: first.name,
                characteristic: first.characteristic,
                advance: first.advance,
                ...rankFlags(first.advance),
                bonus: first.bonus,
            };
            continue;
        }
        const baseName = first.name.replace(PAREN_CLOSE, "").trim();
        trained[key] = {
            name: baseName.length > 0 ? baseName : first.name,
            characteristic: first.characteristic,
            advance: 0,
            ...rankFlags(0),
            bonus: 0,
            entries: [first, ...rest].map((s) => ({
                name: s.specialization.length > 0 ? s.specialization : s.name,
                specialization: s.specialization,
                characteristic: s.characteristic,
                advance: s.advance,
                bonus: s.bonus,
            })),
        };
    }
    return trained;
}
