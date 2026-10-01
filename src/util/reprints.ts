// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RawTextRun } from "../types/ir.ts";
import { quantizeCoord, quantizeSize } from "./rounding.ts";
import { stripSubsetPrefix } from "./text.ts";

/** Points a run may overhang the run it reprints (glyph side bearings). */
const REPRINT_SLACK = 1;

const letters = (s: string): string => s.replace(/\s+/gu, "").toLowerCase();

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
 * repeats, is that copy; read as well, its letters would double in the word
 * ("GETG", "CCOVERING"). The fuller run is the one kept; order is preserved.
 *
 * A layer may also set a line in overlapping pieces, each beginning with
 * letters the piece before already set ("be Lu", "Luck", "cky" for "be
 * Lucky"): a run starting inside the run before it, whose leading letters
 * repeat that run's last ones over the width they overlap, loses them.
 */
export function withoutReprints(runs: readonly RawTextRun[]): RawTextRun[] {
    const bySetting = new Map<string, number[]>();
    runs.forEach((r, i) => {
        if (letters(r.text).length > 0) {
            const key = setting(r);
            bySetting.set(key, [...(bySetting.get(key) ?? []), i]);
        }
    });
    const reprinted = new Set<number>();
    for (const members of bySetting.values()) {
        for (const i of members) {
            const r = runs[i];
            if (r === undefined) {
                continue;
            }
            const text = letters(r.text);
            // Covered by a run with more letters, or by an identical wider (or,
            // as wide, earlier) one: never by list or x order, which a reprint
            // need not follow.
            const covered = members.some((j) => {
                const k = runs[j];
                if (k === undefined || j === i) {
                    return false;
                }
                const own = letters(k.text);
                const wider = k.width > r.width || (k.width === r.width && j < i);
                return (
                    (own.length > text.length || (own === text && wider)) &&
                    own.includes(text) &&
                    r.x >= k.x - REPRINT_SLACK &&
                    r.x + r.width <= k.x + k.width + REPRINT_SLACK
                );
            });
            if (covered) {
                reprinted.add(i);
            }
        }
    }
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
    return runs.flatMap((r, i) => (reprinted.has(i) ? [] : [trimmed.get(i) ?? r]));
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
    if (repeated < 1 || repeated >= run.text.length || !before.text.endsWith(run.text.slice(0, repeated))) {
        return run;
    }
    const lead = repeated * perChar;
    return { ...run, text: run.text.slice(repeated), x: run.x + lead, width: run.width - lead };
}
