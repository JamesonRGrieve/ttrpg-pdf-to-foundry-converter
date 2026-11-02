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

/** Fewest spaced small letters after a capital for it to open a word of its own. */
const MIN_WORD_TAIL = 2;

/** How many lone small letters follow `tokens[i]` before anything else. */
function smallLettersAfter(tokens: readonly string[], i: number): number {
    let n = 0;
    while (/^\p{Ll}$/u.test(tokens[i + 1 + n] ?? "")) {
        n += 1;
    }
    return n;
}

/**
 * Close up a name set in spaced capitals: a single letter following a word
 * ends that word ("fr A g" → "frAg"), as a text layer spaces small-caps glyphs.
 */
export function closeUpSpacedLetters(text: string): string {
    const out: string[] = [];
    const tokens = text.split(/\s+/u).filter((t) => t.length > 0);
    for (const [i, token] of tokens.entries()) {
        const prev = out.at(-1);
        // Spaced letters keep their words' capitals: a capital after a word
        // set as a capital and small letters, before small letters of its
        // own, opens the next word ("L a m p W i c k" → "Lamp Wick"); after
        // small letters alone ("fr A g"), or among letters of scrambled case,
        // it is a small capital that lost its case.
        const opensWord =
            /^\p{Lu}-?$/u.test(token) &&
            /^\p{Lu}\p{Ll}+$/u.test(prev ?? "") &&
            smallLettersAfter(tokens, i) >= MIN_WORD_TAIL;
        const joins =
            prev !== undefined &&
            !opensWord &&
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

/** Fewest words of prose a name line's lead-in sentence runs to. */
const MIN_LEAD_IN_WORDS = 3;

/**
 * A name line's name without a sentence of prose leading into it ("The craft
 * may take one hull mount. Lamp Gun" → "Lamp Gun"): what follows the last
 * full stop or colon, when what precedes it is prose of a few words.
 */
export function afterLeadIn(name: string): string {
    const m = /^(.*[.:])\s+(\S.*)$/su.exec(name);
    const lead = m?.[1] ?? "";
    return m !== null && /\p{Ll}{2}/u.test(lead) && lead.split(/\s+/u).length >= MIN_LEAD_IN_WORDS
        ? (m[2] ?? name)
        : name;
}

/** Whether a line is a profile's name line: a name closing on the schema's weapon class. */
export function isWeaponNameLine(line: string): boolean {
    const named = NAME_LINE.exec(line.trim())?.groups;
    return named !== undefined && parseWeaponClass(named["cls"]?.trim() ?? "") !== null;
}

/** The weapon profiles printed in a statblock panel's lines, in order. */
export function panelWeapons(lines: readonly string[]): PanelWeapon[] {
    const out: PanelWeapon[] = [];
    let current: PanelWeapon | null = null;
    for (const line of lines) {
        const named = NAME_LINE.exec(line.trim())?.groups;
        const cls = named?.["cls"]?.trim() ?? "";
        if (named !== undefined && parseWeaponClass(cls) !== null) {
            const spaced = closeUpSpacedLetters(afterLeadIn(named["name"] ?? ""));
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
