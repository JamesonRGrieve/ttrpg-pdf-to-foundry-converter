// SPDX-License-Identifier: AGPL-3.0-or-later
import { headerRole, type Role } from "./columns.ts";
import { parseWeaponClass } from "./notation.ts";
import type { RowCells } from "./rows.ts";

/**
 * Weapon profiles boxed in a statblock's panel. Each opens with a line that
 * names the weapon and ends in its class ("LASGUN  CLASS BASIC"), then lines
 * of `LABEL value` pairs whose labels are the schema's own weapon column
 * headers ("RNG 100M ROF S/3/- DMG 1D10+3 (E)", "PEN 0 CLIP 60 RLD FULL WT 4KG
 * AVL CM"), and a qualities line ("SPECIAL: RELIABLE"). A profile ends at the
 * next weapon's name line or at a line carrying no such label. A name set in
 * spaced small capitals ("L A S g u n") is closed up; a closing count in
 * brackets ("Frag Grenades (3)") is how many are carried, not part of the name.
 */

export interface PanelWeapon {
    name: string;
    /** How many the statblock carries, when it prints a count. */
    count: number | null;
    cells: RowCells;
}

/** The profile roles a panel prints after their header label. */
const PROFILE_ROLES: ReadonlySet<Role> = new Set([
    "range",
    "rof",
    "damage",
    "penetration",
    "clip",
    "reload",
    "special",
    "weight",
    "availability",
]);

/** A name line: the weapon's name, then its class after the class label (in any case). */
const NAME_LINE = /^(?<name>.*?\p{L}.*?)\s+class\s*:?\s*(?<cls>[\p{L}/ ]+?)\s*$/iu;
/** A closing bracketed count ("(3)", "( 2)"). */
const COUNT = /\s*\(\s*(\d+)\s*\)\s*$/u;

/**
 * Close up a name set in spaced capitals: a single letter following a word
 * ends that word ("fr A g" → "frAg"), as a text layer spaces small-caps glyphs.
 */
export function closeUpSpacedLetters(text: string): string {
    const out: string[] = [];
    for (const token of text.split(/\s+/u).filter((t) => t.length > 0)) {
        const prev = out.at(-1);
        const joins =
            prev !== undefined &&
            /^[\p{L}-]+$/u.test(prev) &&
            // A lone letter (perhaps before a hyphen), or anything after a word broken at a hyphen.
            (/^\p{L}-?$/u.test(token) || (prev.endsWith("-") && /^\p{L}/u.test(token)));
        if (prev !== undefined && joins) {
            out[out.length - 1] = `${prev}${token}`;
        } else {
            out.push(token);
        }
    }
    return out.join(" ");
}

/**
 * A word that is a profile label, naming one of the profile's roles. Its case
 * is not relied on: a text layer that lost small capitals' case scrambles it.
 */
function labelRole(word: string): Role | null {
    const bare = word.replace(/:$/u, "");
    if (!/^\p{L}{2,}$/u.test(bare)) {
        return null;
    }
    const role = headerRole(bare);
    return role !== null && PROFILE_ROLES.has(role) ? role : null;
}

/** The `LABEL value` pairs of a profile line, by role; empty when the line carries no label. */
function labelledValues(line: string): RowCells {
    const cells: RowCells = {};
    let role: Role | null = null;
    let value: string[] = [];
    const close = (): void => {
        if (role !== null && cells[role] === undefined) {
            cells[role] = value.join(" ").trim();
        }
    };
    for (const word of line.split(/\s+/u).filter((w) => w.length > 0)) {
        const next = labelRole(word);
        if (next !== null) {
            close();
            role = next;
            value = [];
        } else if (role !== null) {
            value.push(word);
        }
    }
    close();
    return cells;
}

/** The weapon profiles printed in a statblock panel's lines, in order. */
export function panelWeapons(lines: readonly string[]): PanelWeapon[] {
    const out: PanelWeapon[] = [];
    let current: PanelWeapon | null = null;
    for (const line of lines) {
        const named = NAME_LINE.exec(line.trim())?.groups;
        const cls = named?.["cls"]?.trim() ?? "";
        if (named !== undefined && parseWeaponClass(cls) !== null) {
            const spaced = closeUpSpacedLetters(named["name"] ?? "");
            const count = COUNT.exec(spaced);
            current = {
                name: spaced.replace(COUNT, "").trim(),
                count: count === null ? null : Number(count[1]),
                cells: { class: cls },
            };
            out.push(current);
            continue;
        }
        if (current === null) {
            continue;
        }
        const cells = labelledValues(line);
        if (Object.keys(cells).length === 0) {
            // A line of words ends the profile; a stray figure (a superscript set apart) does not.
            if (/\p{L}{2}/u.test(line)) {
                current = null;
            }
            continue;
        }
        for (const [role, value] of Object.entries(cells) as [Role, string][]) {
            current.cells[role] ??= value;
        }
    }
    return out.filter((w) => /\p{L}{2}/u.test(w.name));
}
