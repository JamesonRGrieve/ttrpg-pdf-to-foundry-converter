// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IRTextRun } from "../../types/ir.ts";
import { numAsc } from "../../util/ordered.ts";
import type { Cell, Line } from "./layout.ts";
import { joinText } from "./text.ts";
import { plainWords } from "./vocab.ts";

/**
 * A class's level progression table: a header row with a level column and a
 * features column, then one row per level.
 *
 * The columns are where the rows' cells stand: cells of different rows that
 * overlap are one column. Header text is placed over those columns word by
 * word, so a header set over two lines ("Proficiency" over "Bonus"), or
 * several headers set as one run of text, each name the column below them. A
 * cell that wraps continues on the lines after its row, and the table may
 * break across columns or pages: its later rows sit at a different x, so
 * cells are placed by their offset from their own row's level cell.
 */

export interface ProgressionRow {
    level: number;
    /** Text per column; "" where the row has none. */
    cells: string[];
}

export interface Progression {
    headers: string[];
    levelColumn: number;
    featuresColumn: number;
    rows: ProgressionRow[];
    /** The lines the table occupies (header included). */
    lines: Set<Line>;
}

/** A level cell: a number, or an ordinal ("1st", "12th"). */
const LEVEL = /^(\d{1,2})(?:st|nd|rd|th)?$/u;
/** Most ems above the header a second header line may sit. */
const HEADER_STACK_EM = 1.6;
/** Most ems below the previous line a wrapped cell may sit. */
const WRAP_EM = 1.9;
/** Lines after a break a wrapped cell may run on for before the next row. */
const WRAP_LOOKAHEAD = 3;
/** Points between two cells' spans within which they are one column. */
const COLUMN_JOIN = 2;

interface Span {
    x: number;
    right: number;
}

/** A row's cells, shifted onto the first row's position. */
interface PlacedRow {
    level: number;
    cells: Span[];
    texts: string[];
}

const overlap = (a: Span, b: Span): number => Math.min(a.right, b.right) - Math.max(a.x, b.x);
const centre = (s: Span): number => (s.x + s.right) / 2;

/** The span a cell (shifted by `dx`) overlaps most, else the one nearest its centre. */
function spanOf(cell: Span, spans: readonly Span[]): number {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    spans.forEach((s, i) => {
        const o = overlap(cell, s);
        const score = o > 0 ? o : -Math.abs(centre(cell) - centre(s)) - Number.MAX_SAFE_INTEGER / 2;
        if (score > bestScore) {
            best = i;
            bestScore = score;
        }
    });
    return best;
}

/** The columns: the rows' cell spans, overlapping spans joined. */
function columnSpans(rows: readonly PlacedRow[]): Span[] {
    const cells = rows.flatMap((r) => r.cells).sort((a, b) => numAsc(a.x, b.x));
    const spans: Span[] = [];
    for (const cell of cells) {
        const last = spans.at(-1);
        if (last !== undefined && cell.x <= last.right + COLUMN_JOIN) {
            last.right = Math.max(last.right, cell.right);
        } else {
            spans.push({ x: cell.x, right: cell.right });
        }
    }
    return spans;
}

/** A header run's words, each with the span it takes up in proportion to its characters. */
function headerWords(run: IRTextRun): { text: string; span: Span }[] {
    const text = run.text;
    const out: { text: string; span: Span }[] = [];
    const perChar = text.length === 0 ? 0 : run.width / text.length;
    for (const match of text.matchAll(/\S+/gu)) {
        const start = match.index;
        out.push({
            text: match[0],
            span: { x: run.x + start * perChar, right: run.x + (start + match[0].length) * perChar },
        });
    }
    return out;
}

/** The row line for `level` within a few lines after `lines[from]`, if any. */
function rowFollowing(lines: readonly Line[], from: number, level: number): Line | undefined {
    return lines.slice(from + 1, from + 1 + WRAP_LOOKAHEAD).find((l) => {
        const match = LEVEL.exec(l.cells[0]?.text ?? "");
        return match !== null && Number(match[1]) === level;
    });
}

const allBold = (line: Line): boolean => line.cells.every((c: Cell) => c.bold);
const namesFeatures = (text: string): boolean => /\bfeatures?\b/u.test(plainWords(text));

/**
 * The progression table starting at `lines[start]`, if that line is its
 * header: bold, opening with the level column's header and naming a features
 * column. (Its cells may run together; the columns come from the rows.)
 */
function readFrom(lines: readonly Line[], start: number): Progression | null {
    const header = lines[start];
    if (
        header === undefined ||
        !allBold(header) ||
        !/^level\b/u.test(plainWords(header.text)) ||
        !namesFeatures(header.text)
    ) {
        return null;
    }
    const headerLines = [header];
    const used = new Set<Line>([header]);
    const above = lines[start - 1];
    if (
        above?.cells.every((c) => c.bold) === true &&
        above.region === header.region &&
        above.bottom - header.bottom <= HEADER_STACK_EM * header.size
    ) {
        headerLines.unshift(above);
        used.add(above);
    }

    const rows: PlacedRow[] = [];
    /** The first row's level cell: where every row's level cell is placed. */
    let anchor: number | null = null;
    let anchorRight = 0;
    let dx = 0;
    let prev: Line = header;
    const place = (row: PlacedRow, line: Line): void => {
        for (const cell of line.cells) {
            row.cells.push({ x: cell.x - dx, right: cell.right - dx });
            row.texts.push(cell.text);
        }
    };
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) {
            break;
        }
        const first = line.cells[0];
        const match = first === undefined ? null : LEVEL.exec(first.text);
        const expected = (rows.at(-1)?.level ?? 0) + 1;
        if (
            first !== undefined &&
            match !== null &&
            Number(match[1]) === expected &&
            line.cells.length >= 2
        ) {
            if (anchor === null) {
                anchor = first.x;
                anchorRight = first.right;
            }
            dx = first.x - anchor;
            const row: PlacedRow = { level: expected, cells: [], texts: [] };
            place(row, line);
            rows.push(row);
        } else {
            const row = rows.at(-1);
            if (row === undefined || anchor === null) {
                break;
            }
            if (line.region !== prev.region) {
                // Across a column or page break the table only continues if a row follows
                // shortly, and its cells sit where that row's do.
                const next = rowFollowing(lines, i, expected);
                if (next === undefined) {
                    break;
                }
                dx = (next.cells[0]?.x ?? anchor) - anchor;
            } else if (prev.bottom - line.bottom > WRAP_EM * line.size) {
                break;
            }
            // A wrapped cell never reaches back into the level column.
            if (line.cells.some((c) => c.x - dx <= anchorRight)) {
                break;
            }
            place(row, line);
        }
        used.add(line);
        prev = line;
    }
    if (rows.length === 0) {
        return null;
    }

    const spans = columnSpans(rows);
    const headers = spans.map(() => "");
    for (const line of headerLines) {
        for (const run of [...line.runs].sort((a, b) => numAsc(a.x, b.x))) {
            for (const word of headerWords(run)) {
                const col = spanOf(word.span, spans);
                headers[col] = `${headers[col] ?? ""} ${word.text}`.trim();
            }
        }
    }
    const cells = rows.map((row) => {
        const texts = spans.map(() => "");
        row.cells.forEach((cell, i) => {
            const col = spanOf(cell, spans);
            texts[col] = joinText(texts[col] ?? "", row.texts[i] ?? "");
        });
        return { level: row.level, cells: texts };
    });
    const firstRow = rows[0]?.cells[0];
    const levelColumn = firstRow === undefined ? 0 : spanOf(firstRow, spans);
    const featuresColumn = headers.findIndex(namesFeatures);
    if (featuresColumn < 0) {
        return null;
    }
    return { headers, levelColumn, featuresColumn, rows: cells, lines: used };
}

/** The first progression table in a run of lines. */
export function readProgression(lines: readonly Line[]): Progression | null {
    for (let i = 0; i < lines.length; i += 1) {
        const table = readFrom(lines, i);
        if (table !== null) {
            return table;
        }
    }
    return null;
}

/** A features cell's feature names: comma-separated, a parenthetical kept with its name. */
export function featureNames(cell: string): string[] {
    const names: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of cell) {
        if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        }
        if (ch === "," && depth === 0) {
            names.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    names.push(current);
    return names.map((n) => n.trim()).filter((n) => n.length > 0 && /\p{L}/u.test(n));
}
