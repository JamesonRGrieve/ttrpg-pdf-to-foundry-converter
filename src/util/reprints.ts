// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RawTextRun } from "../types/ir.ts";
import { quantizeCoord, quantizeSize } from "./rounding.ts";
import { stripSubsetPrefix } from "./text.ts";

/** A text layer read without its reprints. */
export interface Reprints {
    /** The layer's runs, reprints dropped and repeated lead letters trimmed. */
    runs: RawTextRun[];
    /** The runs dropped as exact copies of a kept run. */
    copies: RawTextRun[];
}

/** Points a run may overhang the run it reprints (glyph side bearings). */
const REPRINT_SLACK = 1;

const letters = (s: string): string => s.replace(/\s+/gu, "").toLowerCase();

/**
 * Whether `part`'s letters all appear, in order, within `whole`: a reprint
 * can repeat a run with a letter left out or set as a space ("T bl" over
 * "Tabl").
 */
function inOrderWithin(part: string, whole: string): boolean {
    let at = 0;
    for (const ch of whole) {
        if (ch === part[at]) {
            at += 1;
        }
    }
    return at === part.length;
}

/** Runs set on one baseline in one face and size: the only runs that can reprint each other. */
const setting = (r: RawTextRun): string =>
    [r.pageIndex, quantizeCoord(r.y), quantizeSize(r.fontSize), stripSubsetPrefix(r.fontName), r.weight].join(
        "\u0000",
    );

/**
 * A text layer without its reprints. A layer may print text twice over
 * itself — a drop cap set again on top of its word ("G" over "GET"), a display
 * line set whole and then glyph by glyph ("HULLS" under "H", "UL", …). A run
 * lying within another of the same face, size and baseline, whose letters it
 * repeats in order, is that copy; read as well, its letters would double in the word
 * ("GETG", "CCOVERING"). The fuller run is the one kept; order is preserved.
 *
 * A layer may also set a line in overlapping pieces, each beginning with
 * letters the piece before already set ("be Lu", "Luck", "cky" for "be
 * Lucky"): a run starting inside the run before it, whose leading letters
 * repeat that run's last ones over the width they overlap, loses them.
 *
 * The runs dropped as exact copies of a kept run are returned as well: a
 * layer that draws its text over and over in place is unreliable to read.
 */
export function readReprints(runs: readonly RawTextRun[]): Reprints {
    const bySetting = new Map<string, number[]>();
    runs.forEach((r, i) => {
        if (letters(r.text).length > 0) {
            const key = setting(r);
            bySetting.set(key, [...(bySetting.get(key) ?? []), i]);
        }
    });
    const reprinted = new Set<number>();
    const copies: RawTextRun[] = [];
    for (const members of bySetting.values()) {
        for (const i of members) {
            const r = runs[i];
            if (r === undefined) {
                continue;
            }
            const text = letters(r.text);
            const within = (k: RawTextRun): boolean =>
                r.x >= k.x - REPRINT_SLACK && r.x + r.width <= k.x + k.width + REPRINT_SLACK;
            // Covered by a run with more letters, or by an identical wider (or,
            // as wide, earlier) one: never by list or x order, which a reprint
            // need not follow.
            const others = members.flatMap((j) => {
                const k = runs[j];
                return k === undefined || j === i || !within(k) ? [] : [{ k, j, own: letters(k.text) }];
            });
            const copy = others.some(
                ({ k, j, own }) => own === text && (k.width > r.width || (k.width === r.width && j < i)),
            );
            if (copy) {
                copies.push(r);
            }
            if (copy || others.some(({ own }) => own.length > text.length && inOrderWithin(text, own))) {
                reprinted.add(i);
            }
        }
    }
    // A word space set inside a run's own letters breaks no word: a layer
    // drawing glyphs over again can emit one wherever it steps back.
    runs.forEach((r, i) => {
        if (letters(r.text).length > 0 || r.text.length === 0) {
            return;
        }
        const inside = (bySetting.get(setting(r)) ?? []).some((j) => {
            const k = runs[j];
            return (
                k !== undefined &&
                !reprinted.has(j) &&
                r.x > k.x + REPRINT_SLACK &&
                r.x + r.width < k.x + k.width - REPRINT_SLACK
            );
        });
        if (inside) {
            reprinted.add(i);
        }
    });
    const trimmed = new Map<number, RawTextRun>();
    for (const members of bySetting.values()) {
        const kept = members
            .filter((i) => !reprinted.has(i))
            .sort((a, b) => (runs[a]?.x ?? 0) - (runs[b]?.x ?? 0) || a - b);
        kept.forEach((i, n) => {
            const before = runs[kept[n - 1] ?? -1];
            const r = runs[i];
            if (before !== undefined && r !== undefined) {
                const piece = withoutRepeatedLead(before, r);
                if (piece !== r) {
                    trimmed.set(i, piece);
                }
            }
        });
    }
    return { runs: runs.flatMap((r, i) => (reprinted.has(i) ? [] : [trimmed.get(i) ?? r])), copies };
}

/**
 * Whether `lead` repeats `tail` letter for letter, a space in `lead` standing
 * for any one letter (a reprint can set a letter as a space: "3 2:" over
 * "3–2:"), and it repeats at least one letter.
 */
function repeats(tail: string, lead: string): boolean {
    return (
        tail.length === lead.length &&
        /\S/u.test(lead) &&
        [...lead].every((ch, i) => ch === tail[i] || /\s/u.test(ch))
    );
}

/**
 * `run` without the leading letters that repeat the end of `before`, when it
 * starts inside `before` and those letters span about the width they overlap.
 */
function withoutRepeatedLead(before: RawTextRun, run: RawTextRun): RawTextRun {
    const overlap = before.x + before.width - run.x;
    const perChar = run.text.length > 0 ? run.width / run.text.length : 0;
    if (overlap <= REPRINT_SLACK || perChar <= 0) {
        return run;
    }
    const repeated = Math.round(overlap / perChar);
    if (
        repeated < 1 ||
        repeated >= run.text.length ||
        !repeats(before.text.slice(-repeated), run.text.slice(0, repeated))
    ) {
        return run;
    }
    const lead = repeated * perChar;
    return { ...run, text: run.text.slice(repeated), x: run.x + lead, width: run.width - lead };
}
