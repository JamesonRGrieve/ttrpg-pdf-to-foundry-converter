// SPDX-License-Identifier: AGPL-3.0-or-later
import { numAsc } from "./ordered.ts";

/**
 * The 3×3 lattice of a block of values set in even rows and columns (a
 * statblock's characteristic grid), found among a cluster of positioned
 * items that may also hold strays beside it (a wounds box, a label's digit).
 * Geometry only: items are points with a size, and the lattice is the evenly
 * spaced three rows by three columns whose crossings hold the most of them.
 */

/** Rows and columns of a lattice. */
export const LATTICE_SIDE = 3;
/** Items of one row or column align within this share of their size. */
const ALIGN_TOLERANCE = 0.6;
/** A lattice's two row (or column) gaps differ by at most this ratio. */
const SPACING_RATIO = 1.35;
/** A lattice's rows (and columns) lie at least this many item sizes apart: cells never overlap. */
const MIN_GAP = 1;
/** …and at most this many: a grid's cells sit close. */
const MAX_GAP = 6;
/**
 * Most items a lattice is sought among. A grid with the strays beside it is a
 * few dozen at most; a cluster beyond this is a table or index of numbers,
 * not a grid, and searching it would cost the cube of its bands twice over.
 */
export const MAX_LATTICE_ITEMS = 40;

export interface LatticePoint {
    x: number;
    y: number;
    size: number;
}

export interface Lattice<T> {
    /** Column centres, left to right. */
    cols: number[];
    /** Row centres, top to bottom (PDF y descending). */
    rows: number[];
    /** The items at each crossing, row by row, left to right (9 lists). */
    cells: T[][];
    /** How many crossings hold an item. */
    filled: number;
}

/** One axis's positions grouped within `tolerance`, ascending: each group's mean, and which item fell in it. */
function bands(values: readonly number[], tolerance: number): { centres: number[]; bandOf: number[] } {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => numAsc(a.v, b.v) || numAsc(a.i, b.i));
    const groups: { v: number; i: number }[][] = [];
    for (const entry of order) {
        const last = groups.at(-1);
        if (last !== undefined && entry.v - (last.at(-1)?.v ?? entry.v) <= tolerance) {
            last.push(entry);
        } else {
            groups.push([entry]);
        }
    }
    const bandOf = values.map(() => 0);
    groups.forEach((g, b) => {
        for (const { i } of g) {
            bandOf[i] = b;
        }
    });
    return { centres: groups.map((g) => g.reduce((s, e) => s + e.v, 0) / g.length), bandOf };
}

/** Index triples of positions in order whose two gaps are alike and within `[minGap, maxGap]`. */
function evenTriples(positions: readonly number[], minGap: number, maxGap: number): number[][] {
    const out: number[][] = [];
    const fits = (gap: number): boolean => gap >= minGap && gap <= maxGap;
    positions.forEach((a, i) => {
        positions.forEach((b, j) => {
            if (j <= i || !fits(b - a)) {
                return;
            }
            positions.forEach((c, k) => {
                const gaps = [b - a, c - b];
                if (k > j && fits(c - b) && Math.max(...gaps) <= SPACING_RATIO * Math.min(...gaps)) {
                    out.push([i, j, k]);
                }
            });
        });
    });
    return out;
}

/**
 * The evenly spaced 3×3 lattice holding the most of `items` (at least
 * `minFilled` crossings), or null — also for more than `MAX_LATTICE_ITEMS`. Ties keep the first found, scanning
 * columns then rows in ascending order, so the result is deterministic.
 */
export function bestLattice<T>(
    items: readonly T[],
    point: (item: T) => LatticePoint,
    minFilled: number,
): Lattice<T> | null {
    if (items.length < minFilled || items.length > MAX_LATTICE_ITEMS) {
        return null;
    }
    const points = items.map(point);
    const size = points.map((p) => p.size).sort(numAsc)[Math.floor(points.length / 2)] ?? 0;
    const tolerance = ALIGN_TOLERANCE * size;
    const cols = bands(
        points.map((p) => p.x),
        tolerance,
    );
    const rows = bands(
        points.map((p) => p.y),
        tolerance,
    );
    const atCrossing = new Map<string, T[]>();
    items.forEach((item, i) => {
        const key = `${cols.bandOf[i]},${rows.bandOf[i]}`;
        atCrossing.set(key, [...(atCrossing.get(key) ?? []), item]);
    });
    const rowTriples = evenTriples(rows.centres, MIN_GAP * size, MAX_GAP * size);
    let best: Lattice<T> | null = null;
    for (const c of evenTriples(cols.centres, MIN_GAP * size, MAX_GAP * size)) {
        for (const ascending of rowTriples) {
            const r = [...ascending].reverse();
            const cells = r.flatMap((ri) => c.map((ci) => atCrossing.get(`${ci},${ri}`) ?? []));
            const filled = cells.filter((cell) => cell.length > 0).length;
            if (filled >= minFilled && filled > (best?.filled ?? 0)) {
                best = {
                    cols: c.map((ci) => cols.centres[ci] ?? 0),
                    rows: r.map((ri) => rows.centres[ri] ?? 0),
                    cells,
                    filled,
                };
            }
        }
    }
    return best;
}
