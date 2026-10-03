// SPDX-License-Identifier: AGPL-3.0-or-later
import { bestLattice, LATTICE_SIDE } from "../util/lattice.ts";
import { numAsc } from "../util/ordered.ts";
import type { OcrWord, PdfBox } from "./types.ts";

/**
 * Numeric grids on a scanned page that recognition read only in part: a 3×3
 * block of small numbers set at one size in even rows and columns (a
 * statblock's characteristic values), some of whose cells it missed or misread.
 * From the cells it did read, the grid's rows and columns give each missing
 * cell's place, so that cell can be read again on its own. Geometry only.
 */

/** Fewest cells read before a grid is completed from them. */
export const MIN_READ_CELLS = 5;
/** A cell's value is at most this many characters ("38", "—", a long dash read as "——"). */
const MAX_CELL_CHARS = 3;
/** Values beyond this are a misread of a two-digit value ("128" for "28"). */
const MAX_CELL_VALUE = 100;
/** Words of one grid differ in height by at most this ratio. */
const HEIGHT_RATIO = 1.35;
/** Rows and columns sit within this many cell heights of their neighbours. */
const NEIGHBOUR_REACH = 5;

const CELL_TEXT = /^(?:\d{1,3}|[—–-]{1,2})$/u;
const DASH = /^[—–-]{1,2}$/u;

export interface GridCellToRead {
    /** The cell's box (PDF space) to read again. */
    box: PdfBox;
    /** The word recognition placed there, when it read one that cannot be the value. */
    misread: OcrWord | null;
}

const height = (w: OcrWord): number => w.box[3] - w.box[1];
const centreX = (w: OcrWord): number => (w.box[0] + w.box[2]) / 2;
const centreY = (w: OcrWord): number => (w.box[1] + w.box[3]) / 2;

function median(values: readonly number[]): number {
    return [...values].sort(numAsc)[Math.floor(values.length / 2)] ?? 0;
}

/** Numbers of one height lying close to one another, grouped. */
function clusters(numbers: readonly OcrWord[]): OcrWord[][] {
    const parent = numbers.map((_, i) => i);
    const find = (i: number): number => {
        let n = i;
        while (parent[n] !== n) {
            n = parent[n] ?? n;
        }
        return n;
    };
    numbers.forEach((a, i) => {
        numbers.forEach((b, j) => {
            const h = Math.max(height(a), height(b));
            const similar = h <= HEIGHT_RATIO * Math.min(height(a), height(b));
            const near =
                Math.abs(centreX(a) - centreX(b)) <= NEIGHBOUR_REACH * h &&
                Math.abs(centreY(a) - centreY(b)) <= NEIGHBOUR_REACH * h;
            if (j > i && similar && near) {
                parent[find(i)] = find(j);
            }
        });
    });
    const out = new Map<number, OcrWord[]>();
    numbers.forEach((w, i) => {
        const root = find(i);
        out.set(root, [...(out.get(root) ?? []), w]);
    });
    return [...out.values()];
}

/** The cells of the page's partly read numeric grids to read again. */
export function gridCellsToRead(words: readonly OcrWord[]): GridCellToRead[] {
    const numbers = words.filter(
        (w) => CELL_TEXT.test(w.text.trim()) && [...w.text.trim()].length <= MAX_CELL_CHARS,
    );
    const out: GridCellToRead[] = [];
    for (const cluster of clusters(numbers)) {
        // Stray numbers beside a grid join its cluster but fall off its lattice.
        const lattice = bestLattice(
            cluster,
            (w) => ({ x: centreX(w), y: centreY(w), size: height(w) }),
            MIN_READ_CELLS,
        );
        if (lattice === null) {
            continue;
        }
        const h = median(cluster.map(height));
        const w = median(cluster.map((c) => c.box[2] - c.box[0]));
        lattice.cells.forEach((there, i) => {
            const x = lattice.cols[i % LATTICE_SIDE] ?? 0;
            const y = lattice.rows[Math.floor(i / LATTICE_SIDE)] ?? 0;
            const read = there.find((c) => /^\d+$/u.test(c.text.trim()) && Number(c.text) <= MAX_CELL_VALUE);
            if (read !== undefined || there.some((c) => DASH.test(c.text.trim()))) {
                return;
            }
            out.push({ box: [x - w / 2, y - h / 2, x + w / 2, y + h / 2], misread: there[0] ?? null });
        });
    }
    return out;
}
