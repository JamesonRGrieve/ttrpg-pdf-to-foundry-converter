// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IRTextRun } from "../types/ir.ts";
import { numAsc } from "../util/ordered.ts";
import { percentile } from "../util/stats.ts";
import { FUNCTION_WORDS } from "./names.ts";

/**
 * Rejoin table rows whose cells wrap onto several lines. Two structural signals
 * must agree before a line joins the row above it:
 *
 *  - SPACING: gaps between a table's consecutive lines fall into two clusters —
 *    the leading inside a wrapped row and the larger pitch between rows (or
 *    around section rows). When both clusters exist (the widest gaps are at
 *    least TWO_CLUSTER_RATIO × the narrowest), a continuation sits below their
 *    midpoint.
 *  - SHAPE: a wrapped line carries only the cells that wrapped, so it fills
 *    fewer columns than the table's typical row. A line filling as many columns
 *    as a typical row is a new record, however tight its spacing.
 *
 * Independently of spacing, a line whose cells show it cannot stand alone —
 * see `continuesStructurally` — joins the row above. Otherwise a table whose
 * gaps are uniform, or whose lines are all full, is untouched.
 */

/** Widest/narrowest gap ratio that shows two gap clusters rather than jitter. */
const TWO_CLUSTER_RATIO = 1.25;
/** Percentiles standing for the narrow and wide clusters (robust to outliers). */
const NARROW_PERCENTILE = 0.1;
const WIDE_PERCENTILE = 0.9;
/** A line filling at most 1/N of a typical row's cells is a fragment of a wrapped row. */
const FRAGMENT_DIVISOR = 3;

export interface LineRow {
    y: number;
    runs: IRTextRun[];
}

/** Most common value (ties → larger). */
function mode(values: readonly number[]): number {
    const counts = new Map<number, number>();
    for (const v of values) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const v of [...counts.keys()].sort(numAsc)) {
        const c = counts.get(v) ?? 0;
        if (c >= bestCount) {
            best = v;
            bestCount = c;
        }
    }
    return best;
}

/** Every run of `row` is set in a face (font, weight, size) already used by `prev`. */
function sameFaces(prev: LineRow, row: LineRow): boolean {
    return row.runs.every((r) =>
        prev.runs.some((p) => p.font === r.font && p.weight === r.weight && p.size === r.size),
    );
}

export interface RowShape<T> {
    /** The line's text per table column, in column order ("" where it has none; key first). */
    cells: (row: T) => string[];
}

const filled = (cells: readonly string[]): number => cells.filter((c) => c.trim().length > 0).length;

/** Text that stops mid-sentence: no terminal punctuation at its end. */
const UNFINISHED = /[^.!?:;)"”’]\s*$/u;

/**
 * Structure alone shows the line is part of the row above, however it is
 * spaced (a table of one-line rows has no spacing signal):
 *  - it has text only in the key column, where a typical row fills more — a
 *    record carries more than its name, so this is a wrapped name;
 *  - some cell it fills carries on, in lower case, from a cell above that
 *    stopped mid-sentence, and none of its cells starts afresh under a cell
 *    that had finished (a wrapped row wraps its unfinished cells together).
 */
function continuesStructurally(
    line: readonly string[],
    above: readonly string[],
    typicalFill: number,
): boolean {
    const others = line.map((text, col) => ({ text: text.trim(), col })).filter((c) => c.col > 0 && c.text);
    if (others.length === 0) {
        return (line[0] ?? "").trim().length > 0 && typicalFill > 1;
    }
    const unfinishedAbove = (col: number): boolean => UNFINISHED.test(above[col] ?? "");
    // Every cell it fills goes on from a cell above that broke off mid-list:
    // the line carries the rest of that list, whatever its case — unless its
    // key is a number (a roll band opens its own record).
    const key = (line[0] ?? "").trim();
    if (!/^\p{N}/u.test(key) && others.every(({ col }) => breaksOff(above[col] ?? ""))) {
        return true;
    }
    // A lower-case word, not a value such as "x1/2".
    const carriesOn = others.some(({ text, col }) => /^\p{Ll}{2,}/u.test(text) && unfinishedAbove(col));
    return carriesOn && others.every(({ text, col }) => unfinishedAbove(col) || /^\p{Ll}/u.test(text));
}

/** A cell that visibly stops mid-phrase: on a comma, or inside an unclosed parenthesis. */
function breaksOff(cell: string): boolean {
    const text = cell.trim();
    return /,$/u.test(text) || (text.match(/\(/gu)?.length ?? 0) > (text.match(/\)/gu)?.length ?? 0);
}

/**
 * A row still waiting for its next line: it fills fewer cells than the
 * table's fullest rows, and a cell it fills breaks off mid-phrase ("Low Grade
 * (Hab Sleeper Capsule,", "Int 30,") — its values are set on the line that
 * completes it.
 */
function awaitsRest(cells: readonly string[], fullest: number): boolean {
    return filled(cells) < fullest && cells.some((cell) => cell.trim().length > 0 && breaksOff(cell));
}

/**
 * A line opens a new record when its key cell starts with a capital or digit —
 * unless the row above is visibly unfinished: its key text ends on a connecting
 * word ("… of", "… from"), so the capitalized line completes that name.
 */
function opensRecord(key: string, previousKey: string): boolean {
    if (!/^[\p{Lu}\p{N}]/u.test(key.trim())) {
        return false;
    }
    const lastWord = previousKey.trim().split(/\s+/u).pop()?.toLowerCase() ?? "";
    return !FUNCTION_WORDS.has(lastWord);
}

/**
 * Merge wrapped lines into their row. `rows` must be ordered top to bottom.
 * Besides spacing and fill (above), a continuation is set in exactly the faces
 * of the row it continues — a section label or footnote in another face or
 * size is not a wrapped cell — and does not open a new record.
 */
export function mergeContinuationRows<T extends LineRow>(rows: readonly T[], shape: RowShape<T>): T[] {
    if (rows.length < 3) {
        return [...rows];
    }
    const gaps = rows.slice(1).map((r, i) => (rows[i]?.y ?? r.y) - r.y);
    const sorted = [...gaps].sort(numAsc);
    const narrow = percentile(sorted, NARROW_PERCENTILE);
    const wide = percentile(sorted, WIDE_PERCENTILE);
    const twoClusters = narrow > 0 && wide / narrow >= TWO_CLUSTER_RATIO;
    const threshold = (narrow + wide) / 2;
    // A record's typical fill, from the lines carrying more than a key (a
    // table of wrapped names has more name-only lines than records).
    const fills = rows.map((r) => filled(shape.cells(r)));
    const recordFills = fills.filter((f) => f > 1);
    const typicalFill = mode(recordFills.length > 0 ? recordFills : fills);
    const fullest = Math.max(...rows.map((r) => filled(shape.cells(r))));
    const out: T[] = [];
    // Key-only lines that open the record below them.
    const leads = new Set<T>();
    rows.forEach((row, i) => {
        const prev = out[out.length - 1];
        const gap = gaps[i - 1];
        if (prev !== undefined && leads.has(prev) && sameFaces(prev, row)) {
            prev.runs.push(...row.runs);
            leads.delete(prev);
            return;
        }
        const line = shape.cells(row);
        // A name on its own line, nearer the record below than the line above
        // (a record or a section row), is that record's first line: its
        // values sit beside its last line.
        const next = rows[i + 1];
        const gapBelow = gaps[i];
        if (
            gap !== undefined &&
            filled(line) === 1 &&
            (line[0] ?? "").trim().length > 0 &&
            next !== undefined &&
            gapBelow !== undefined &&
            gapBelow < gap &&
            filled(shape.cells(next)) >= typicalFill &&
            sameFaces(row, next)
        ) {
            const lead = { ...row, runs: [...row.runs] };
            leads.add(lead);
            out.push(lead);
            return;
        }
        if (prev === undefined || gap === undefined || !sameFaces(prev, row)) {
            out.push({ ...row, runs: [...row.runs] });
            return;
        }
        const above = shape.cells(prev);
        // A capitalised key opens a record unless the line is a mere fragment —
        // at most a third of a typical row's cells — at the leading inside a row.
        const fragment = filled(line) * FRAGMENT_DIVISOR <= typicalFill;
        const bySpacing =
            twoClusters &&
            gap < threshold &&
            filled(line) < typicalFill &&
            (fragment || !opensRecord(line[0] ?? "", above[0] ?? ""));
        // A line set apart by the wider row pitch is not a wrapped piece.
        const setApart = twoClusters && gap >= threshold;
        // A line breaking off mid-phrase opens a row its next line completes;
        // a line completing the row above joins it.
        const opensAwaited = awaitsRest(line, fullest);
        // A line with no key of its own under a line that is only a key: a
        // name set on lines around its row's values (the values centred
        // between them) — the values complete the name's record.
        const completesKey =
            (line[0] ?? "").trim().length === 0 && filled(above) === 1 && (above[0] ?? "").trim().length > 0;
        const continues =
            !opensAwaited &&
            (bySpacing ||
                (!setApart &&
                    (completesKey ||
                        continuesStructurally(line, above, typicalFill) ||
                        awaitsRest(above, fullest))));
        if (continues) {
            prev.runs.push(...row.runs);
        } else {
            out.push({ ...row, runs: [...row.runs] });
        }
    });
    return out;
}
