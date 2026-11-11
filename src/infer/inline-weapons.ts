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

/** Capitalise each word of a name the text set in lower case ("wick lamp" → "Wick Lamp"). */
function asName(text: string): string {
    return text.replace(/(^|\s)(\p{Ll})/gu, (_, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

/**
 * A craft's weapon list: its weapons are mounted ("Turret-mounted X (…)",
 * "with co-axial mounted Y (…)"), their profiles open on a facing or the range
 * rather than a class, and they are of the schema's vehicle class.
 */
const MOUNTED_PROFILE =
    /(?<=^|[,;:\n•†]\s*|\b(?:or|and|with)\s+)(?<name>\p{L}[\p{L}\p{N}'’ -]{0,60}?)\s*\((?<profile>[^()]*(?:\([^()]*\)[^()]*)*)\)/gu;
/** The mounting a craft's weapon list names before a weapon: "Turret-mounted", "Co-Axial mounted", "Fixed". */
const MOUNTING = /^(?:(?:[\p{L}]+(?:[- ][\p{L}]+)?[- ])?mounted|fixed)\s+/iu;
/** A profile part naming the weapon's facing ("Front Facing", "Front-Facing"). */
const FACING = /\bfacing\b/iu;
/** The schema's weapon class for weapons mounted on a craft. */
const MOUNTED_CLASS = "vehicle";
/** A word joining a name to another, or to a choice: "or", "with", "either". */
const JOINING_WORD = /(?:^|\s)(?:or|and|with|either|plus)(?=\s|$)/iu;
/** The schema's weapon class of a profile with no range or rate of fire. */
const MELEE_CLASS = "melee";

/**
 * The weapon profiles printed inline in `text`; `mounted`: the text lists a
 * craft's weapons, whose profiles need print no class.
 */
export function inlineWeapons(text: string, mounted = false): InlineWeapon[] {
    const out: InlineWeapon[] = [];
    for (const m of text.matchAll(mounted ? MOUNTED_PROFILE : PROFILE)) {
        const rawName = m.groups?.["name"]?.trim().replace(LEADING_JOIN, "").replace(MOUNTING, "") ?? "";
        const printed = (m.groups?.["profile"] ?? "")
            .split(";")
            .map((p) => p.trim())
            .filter((p) => !(mounted && FACING.test(p)));
        const classed = printed[0] !== undefined && parseWeaponClass(printed[0]) !== null;
        // A profile opens on its class; a craft's weapon is of the vehicle
        // class; any other profile printing no class must print a damage and
        // a labelled penetration to read as one.
        const printedClass = classed ? printed[0] : mounted ? MOUNTED_CLASS : undefined;
        const rest = classed ? printed.slice(1) : printed;
        const words = rawName.split(/\s+/u).filter((w) => w.length > 0).length;
        if (
            rest.length + (printedClass === undefined ? 0 : 1) < MIN_PARTS ||
            words === 0 ||
            words > MAX_NAME_WORDS
        ) {
            continue;
        }
        const cells: RowCells = {
            name: rawName,
            ...(printedClass === undefined ? {} : { class: printedClass }),
        };
        const loose: string[] = [];
        for (const part of rest) {
            const labelled = LABELLED.exec(part)?.groups;
            if (labelled !== undefined) {
                const label = (labelled["label"] ?? "").toLowerCase();
                const role = label.startsWith("pen") ? "penetration" : label === "clip" ? "clip" : "reload";
                // As with damage, a second one is another mode's ("… or Melee; …; Pen 2").
                cells[role] ??= labelled["value"] ?? "";
            } else if (parseDamage(part) !== null) {
                // A second damage is another mode's (or ammunition's); the first is the profile's.
                cells.damage ??= part;
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
        // A classless name joining words ("Either a Gun", "Gun or Knife", "Gun
        // with Rounds") is a choice or a loadout, not one weapon.
        const joined = printedClass === undefined && JOINING_WORD.test(rawName);
        if (
            cells.damage === undefined ||
            joined ||
            (printedClass === undefined && cells.penetration === undefined)
        ) {
            continue;
        }
        // Printing neither range nor rate of fire, a classless profile is a melee weapon's.
        if (cells.class === undefined && cells.range === undefined && cells.rof === undefined) {
            cells.class = MELEE_CLASS;
        }
        if (loose.length > 0) {
            cells.special = loose.join(", ");
        }
        out.push({ name: asName(rawName), cells });
    }
    return out;
}
