// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseDamage, parseRange, parseRateOfFire, parseReload, parseWeaponClass } from "./notation.ts";
import type { RowCells } from "./rows.ts";

/**
 * Weapon profiles printed inline in running text or a statblock's weapon
 * list: a name and its profile in brackets, its parts separated by
 * semicolons and the first of them a weapon class of the schema — "big
 * shoota (Heavy; 120m; −/−/10; 2d10+5 I; Pen 2; Clip 120; Reload Full;
 * Inaccurate, Unreliable)". Each part is placed by its own notation, not by
 * its position, since a profile leaves out the parts that do not apply.
 */

export interface InlineWeapon {
    name: string;
    cells: RowCells;
}

/**
 * A name starting a list item (the text's start, a list separator, or "or" /
 * "and"), then a bracketed profile whose qualities may nest one level of
 * brackets.
 */
const PROFILE =
    /(?<=^|[,;:\n•†]\s*|\b(?:or|and)\s+)(?<name>\p{L}[\p{L}\p{N}'’ -]{0,40}?)\s*\((?<profile>[^()]*(?:\([^()]*\)[^()]*)*)\)/gu;
/** Words that join a name to what comes before it rather than belonging to it. */
const LEADING_JOIN = /^(?:(?:or|and|a|an|the|with|plus)\s+)+/iu;
const LABELLED = /^(?<label>pen(?:etration)?|clip|reload|rld)\s*:?\s*(?<value>.+)$/iu;
/** Fewest profile parts a weapon profile carries (a class and a damage at least). */
const MIN_PARTS = 2;
/** Most words a weapon's name runs to; more is a sentence leading up to the bracket. */
const MAX_NAME_WORDS = 4;

/** Capitalise each word of a name the text set in lower case ("big shoota" → "Big Shoota"). */
function asName(text: string): string {
    return text.replace(/(^|\s)(\p{Ll})/gu, (_, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

/** The weapon profiles printed inline in `text`. */
export function inlineWeapons(text: string): InlineWeapon[] {
    const out: InlineWeapon[] = [];
    for (const m of text.matchAll(PROFILE)) {
        const rawName = m.groups?.["name"]?.trim().replace(LEADING_JOIN, "") ?? "";
        const parts = (m.groups?.["profile"] ?? "").split(";").map((p) => p.trim());
        const [first, ...rest] = parts;
        const words = rawName.split(/\s+/u).filter((w) => w.length > 0).length;
        if (
            first === undefined ||
            parts.length < MIN_PARTS ||
            parseWeaponClass(first) === null ||
            words === 0 ||
            words > MAX_NAME_WORDS
        ) {
            continue;
        }
        const cells: RowCells = { name: rawName, class: first };
        const loose: string[] = [];
        for (const part of rest) {
            const labelled = LABELLED.exec(part)?.groups;
            if (labelled !== undefined) {
                const label = (labelled["label"] ?? "").toLowerCase();
                const role = label.startsWith("pen") ? "penetration" : label === "clip" ? "clip" : "reload";
                cells[role] = labelled["value"] ?? "";
            } else if (cells.damage === undefined && parseDamage(part) !== null) {
                cells.damage = part;
            } else if (cells.rof === undefined && parseRateOfFire(part) !== null) {
                cells.rof = part;
            } else if (cells.range === undefined && parseRange(part) !== null) {
                cells.range = part;
            } else if (
                cells.reload === undefined &&
                parseReload(part) !== null &&
                /\bfull|half\b/iu.test(part)
            ) {
                cells.reload = part;
            } else {
                loose.push(part);
            }
        }
        if (cells.damage === undefined) {
            continue;
        }
        if (loose.length > 0) {
            cells.special = loose.join(", ");
        }
        out.push({ name: asName(rawName), cells });
    }
    return out;
}
