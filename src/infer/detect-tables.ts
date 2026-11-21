// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";
import { wordBreakBetween, wordSpace } from "../util/text.ts";
import type { DetectedTable, TableCell, TableRow } from "./types.ts";

/**
 * Detect tables from IR text runs by column alignment. Tables in PDFs are
 * groups of text runs that share consistent x-positions across multiple rows.
 * We detect them by:
 * 1. Finding horizontal rows (runs at similar y within a page)
 * 2. Detecting repeated column x-positions across consecutive rows
 * 3. Identifying header rows (bold/different font from body rows)
 * 4. Grouping consecutive aligned rows into table regions
 */

const Y_TOLERANCE = 4;
const X_TOLERANCE = 8;
const MIN_COLUMNS = 3;
const MIN_ROWS = 3;
/** Share of a page's lines of several cells a column's left edge must start. */
const EDGE_SHARE = 0.3;
/** Fewest wide lines (several cells each) set one under another that make a table's body. */
const MIN_WIDE_BLOCK = 2 * MIN_ROWS;
/** Lines below a table's row a wrapped cell's next line may sit (a row's text is centred between its lines). */
const WRAP_LINES = 2;
/** Gap between lines, in type sizes, under which they are one row split over lines. */
const SPLIT_ROW_GAP = 0.8;

interface RawRow {
    pageIndex: number;
    y: number;
    runs: IRTextRun[];
}

function mergeFragmentedRuns(runs: IRTextRun[]): IRTextRun[] {
    const [first, ...rest] = [...runs].sort((a, b) => a.x - b.x);
    if (first === undefined || rest.length === 0) {
        return runs;
    }
    const merged: IRTextRun[] = [];
    let current = { ...first };
    for (const next of rest) {
        const gap = next.x - (current.x + current.width);
        if (
            gap < 4 &&
            Math.abs(next.y - current.y) < Y_TOLERANCE &&
            next.font === current.font &&
            next.weight === current.weight
        ) {
            // One cell; its pieces are words where a word space parts them.
            current.text = wordBreakBetween(current.text, next.text, gap, wordSpace(current.size, next.size))
                ? `${current.text} ${next.text}`
                : current.text + next.text;
            current.width = next.x + next.width - current.x;
        } else {
            if (current.text.length > 0) {
                merged.push(current);
            }
            current = { ...next, text: next.text };
        }
    }
    if (current.text.length > 0) {
        merged.push(current);
    }
    return merged;
}

function groupRunsIntoRows(runs: IRTextRun[]): RawRow[] {
    const rows: RawRow[] = [];
    // Whitespace-only runs (inter-cell padding) carry no layout and would bridge columns.
    const sorted = runs
        .filter((r) => r.text.trim().length > 0)
        .sort((a, b) => (a.pageIndex !== b.pageIndex ? a.pageIndex - b.pageIndex : b.y - a.y));
    for (const run of sorted) {
        const existing = rows.find(
            (r) => r.pageIndex === run.pageIndex && Math.abs(r.y - run.y) < Y_TOLERANCE,
        );
        if (existing) {
            existing.runs.push(run);
        } else {
            rows.push({ pageIndex: run.pageIndex, y: run.y, runs: [run] });
        }
    }
    for (const row of rows) {
        row.runs = mergeFragmentedRuns(row.runs);
        row.runs.sort((a, b) => a.x - b.x);
    }
    return rows;
}

interface ColumnEdge {
    x: number;
    count: number;
}

function detectColumnEdges(rows: RawRow[]): ColumnEdge[] {
    const edges = (counted: readonly RawRow[], minCount: number): Map<number, number> => {
        const xCounts = new Map<number, number>();
        for (const row of counted) {
            const seenBuckets = new Set<number>();
            for (const run of row.runs) {
                const bucket = Math.round(run.x / X_TOLERANCE) * X_TOLERANCE;
                if (!seenBuckets.has(bucket)) {
                    xCounts.set(bucket, (xCounts.get(bucket) ?? 0) + 1);
                    seenBuckets.add(bucket);
                }
            }
        }
        return new Map([...xCounts].filter(([, count]) => count >= minCount));
    };
    const found = edges(rows, Math.max(MIN_ROWS, Math.floor(rows.length * EDGE_SHARE)));
    // Lines of prose beside a picture outnumber a table's lines without
    // holding a column; an edge that recurs among the lines of a table's
    // width (several cells each) is a column however much prose the page has.
    // Only a block of such lines set one under another is a table's body; a
    // few wide lines among prose (a stat line beside a paragraph) are not.
    const wide: RawRow[] = [];
    let block: RawRow[] = [];
    for (const row of [...rows].sort((a, b) => b.y - a.y)) {
        if (row.runs.length >= MIN_COLUMNS) {
            block.push(row);
            continue;
        }
        if (block.length >= MIN_WIDE_BLOCK) {
            wide.push(...block);
        }
        block = [];
    }
    if (block.length >= MIN_WIDE_BLOCK) {
        wide.push(...block);
    }
    for (const [x, count] of edges(wide, Math.max(MIN_ROWS, Math.floor(wide.length * EDGE_SHARE)))) {
        if (!found.has(x)) {
            found.set(x, count);
        }
    }
    return [...found.entries()].map(([x, count]) => ({ x, count })).sort((a, b) => a.x - b.x);
}

function assignRunsToColumns(runs: IRTextRun[], columns: ColumnEdge[]): TableCell[] {
    const cells: TableCell[] = [];
    for (const run of runs) {
        let bestCol = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        columns.forEach((column, i) => {
            const dist = Math.abs(run.x - column.x);
            if (dist < bestDist) {
                bestDist = dist;
                bestCol = i;
            }
        });
        const existing = cells.find((c) => c.colIndex === bestCol);
        if (existing) {
            existing.text += ` ${run.text}`;
        } else {
            cells.push({
                text: run.text,
                colIndex: bestCol,
                isHeader: run.weight === "bold",
            });
        }
    }
    cells.sort((a, b) => a.colIndex - b.colIndex);
    return cells;
}

/**
 * Whether a row reads as a header: set bold. On a page read from its image
 * (`measured`) weight is measured word by word and some header words read
 * regular, so there a row mostly bold, or set wholly in capitals, is one.
 */
function headerSet(row: RawRow, measured: boolean): boolean {
    const bold = row.runs.filter((r) => r.weight === "bold").length;
    if (!measured) {
        return bold === row.runs.length;
    }
    const capitals = row.runs.every((r) => /\p{Lu}/u.test(r.text) && !/\p{Ll}/u.test(r.text));
    return capitals || bold * 2 > row.runs.length;
}

function isSpanningHeader(row: RawRow, columns: ColumnEdge[], measured: boolean): boolean {
    if (row.runs.length === 0) {
        return false;
    }
    if (!headerSet(row, measured)) {
        return false;
    }
    const cells = assignRunsToColumns(row.runs, columns);
    if (cells.length > 2) {
        return false;
    }
    const text = row.runs.map((r) => r.text).join(" ");
    return text.length < 60;
}

export function detectTables(ir: IR): DetectedTable[] {
    const allRows = groupRunsIntoRows(ir.runs);
    const tables: DetectedTable[] = [];

    const pageGroups = new Map<number, RawRow[]>();
    for (const row of allRows) {
        const list = pageGroups.get(row.pageIndex) ?? [];
        list.push(row);
        pageGroups.set(row.pageIndex, list);
    }

    const measuredPages = new Set(ir.pages.filter((p) => !p.hasTextLayer).map((p) => p.pageIndex));
    for (const [pageIndex, pageRows] of pageGroups) {
        const measured = measuredPages.has(pageIndex);
        const sorted = [...pageRows].sort((a, b) => b.y - a.y);
        if (sorted.length < MIN_ROWS) {
            continue;
        }

        const columns = detectColumnEdges(sorted);
        if (columns.length < MIN_COLUMNS) {
            continue;
        }

        let tableStart = -1;
        let headerRow: TableRow | null = null;
        const tableRows: TableRow[] = [];
        /** The runs of the table being read: its header and records. */
        const tableRuns: IRTextRun[] = [];

        /** Lines of a cell that wrapped, waiting for the row they belong to. */
        let wrapped: { y: number; cell: TableCell }[] = [];
        let lastRow: { y: number; row: TableRow } | null = null;
        /** Where each of the table's rows stands. */
        const rowAt = new Map<TableRow, number>();
        /** Where the table's last line (its header, or a row) stands. */
        let lastY: number | null = null;
        const joinWrapped = (into: TableRow | null): void => {
            for (const w of wrapped) {
                // A line wrapped from a cell its row leaves empty is that row's
                // (a row set beside its cell's lines); any other continues the row above.
                const empty = into !== null && !into.cells.some((c) => c.colIndex === w.cell.colIndex);
                const target = empty ? into : (lastRow?.row ?? null);
                if (target === null) {
                    continue;
                }
                const cell = target.cells.find((c) => c.colIndex === w.cell.colIndex);
                if (cell === undefined) {
                    target.cells.push({ ...w.cell });
                    target.cells.sort((a, b) => a.colIndex - b.colIndex);
                } else {
                    cell.text = `${cell.text} ${w.cell.text}`;
                }
            }
            wrapped = [];
        };
        for (const [i, row] of sorted.entries()) {
            const cells = assignRunsToColumns(row.runs, columns);
            // A cell's text wrapped onto a line of its own: one cell, set on a
            // column's edge in the face of the table's cells, within a line or
            // two of the table's last row (or its header).
            const only = cells[0];
            const run = row.runs[0];
            const bodyFonts = new Set(tableRuns.filter((r) => r.weight !== "bold").map((r) => r.font));
            if (
                tableStart !== -1 &&
                // Lines of noise on a page read from its picture can pass for
                // wrapped cells; there only a table with a header row has them.
                (headerRow !== null || !measured) &&
                lastY !== null &&
                cells.length === 1 &&
                only !== undefined &&
                run !== undefined &&
                // Before any row, a line no larger than the header's and not set as it is.
                (bodyFonts.size > 0
                    ? row.runs.every((r) => bodyFonts.has(r.font))
                    : row.runs.every(
                          (r) => r.weight !== "bold" && tableRuns.every((h) => r.size <= h.size),
                      )) &&
                row.runs.every(
                    (r) => Math.abs(r.x - (columns[only.colIndex]?.x ?? Number.NaN)) <= X_TOLERANCE,
                ) &&
                lastY - row.y <= WRAP_LINES * run.size
            ) {
                wrapped.push({ y: row.y, cell: only });
                tableRuns.push(...row.runs);
                continue;
            }

            // A line of italic text set alone in the first column between two
            // records (a quote down the table's margin, on baselines of its
            // own) is beside the table: it neither joins nor ends it.
            const next = sorted[i + 1];
            if (
                tableStart !== -1 &&
                lastY !== null &&
                cells.length === 1 &&
                only?.colIndex === 0 &&
                run !== undefined &&
                row.runs.every((r) => r.italic) &&
                lastY - row.y <= WRAP_LINES * run.size &&
                next !== undefined &&
                assignRunsToColumns(next.runs, columns).length >= MIN_COLUMNS - 1
            ) {
                continue;
            }

            if (cells.length >= MIN_COLUMNS - 1) {
                if (tableStart === -1) {
                    tableStart = i;
                }
                tableRuns.push(...row.runs);
                const isHeader = headerSet(row, measured) && !headerRow;
                const spanning = isSpanningHeader(row, columns, measured);

                if (spanning && tableRows.length > 0) {
                    const sectionName = row.runs
                        .map((r) => r.text)
                        .join(" ")
                        .trim();
                    tableRows.push({
                        cells: [],
                        isHeaderRow: false,
                        isSectionHeader: true,
                        sectionName,
                    });
                } else if (isHeader) {
                    lastY = row.y;
                    headerRow = {
                        cells,
                        isHeaderRow: true,
                        isSectionHeader: false,
                        sectionName: null,
                    };
                } else {
                    const record: TableRow = {
                        cells,
                        isHeaderRow: false,
                        isSectionHeader: false,
                        sectionName: null,
                    };
                    tableRows.push(record);
                    rowAt.set(record, row.y);
                    joinWrapped(record);
                    lastRow = { y: row.y, row: record };
                    lastY = row.y;
                }
                continue;
            }
            joinWrapped(null);
            lastRow = null;
            lastY = null;
            if (tableStart !== -1 && tableRows.length >= MIN_ROWS) {
                pushTable(
                    tables,
                    buildTable(
                        pageIndex,
                        headerRow,
                        joinSplitRows(tableRows, rowAt, tableRuns),
                        tableRuns,
                        tableRows,
                    ),
                );
                tableStart = -1;
                headerRow = null;
                tableRows.length = 0;
                tableRuns.length = 0;
            } else if (tableStart !== -1) {
                tableStart = -1;
                headerRow = null;
                tableRows.length = 0;
                tableRuns.length = 0;
            }
        }
        joinWrapped(null);
        if (tableStart !== -1 && tableRows.length >= MIN_ROWS) {
            pushTable(
                tables,
                buildTable(
                    pageIndex,
                    headerRow,
                    joinSplitRows(tableRows, rowAt, tableRuns),
                    tableRuns,
                    tableRows,
                ),
            );
        }
    }
    return tables;
}

/**
 * A table's rows with each row the layout split over several lines put back
 * together. A row set beside its cells' wrapped lines reads as several lines
 * closer together than the rows are (a line of some columns, a line of the
 * others, a line continuing the first): lines nearer each other than a line
 * of type are one row.
 */
function joinSplitRows(
    rows: readonly TableRow[],
    rowAt: ReadonlyMap<TableRow, number>,
    runs: readonly IRTextRun[],
): TableRow[] {
    const size = median(runs.map((r) => r.size));
    const out: TableRow[] = [];
    let lastY: number | undefined;
    for (const row of rows) {
        const y = rowAt.get(row);
        const last = out.at(-1);
        if (
            last !== undefined &&
            !last.isSectionHeader &&
            !row.isSectionHeader &&
            y !== undefined &&
            lastY !== undefined &&
            lastY - y < SPLIT_ROW_GAP * size
        ) {
            for (const cell of row.cells) {
                const into = last.cells.find((c) => c.colIndex === cell.colIndex);
                if (into === undefined) {
                    last.cells.push({ ...cell });
                } else {
                    into.text = `${into.text} ${cell.text}`;
                }
            }
            last.cells.sort((a, b) => a.colIndex - b.colIndex);
        } else {
            out.push({ ...row, cells: row.cells.map((c) => ({ ...c })) });
        }
        lastY = y;
    }
    return out;
}

/**
 * Median cell length above which an "aligned" region is running prose whose
 * line starts happen to line up (two-column text, indented paragraphs), not a
 * table: table cells are short values and names.
 */
const PROSE_CELL_LENGTH = 24;

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function buildTable(
    pageIndex: number,
    headerRow: TableRow | null,
    rows: TableRow[],
    runs: readonly IRTextRun[],
    lines: readonly TableRow[] = rows,
): DetectedTable | null {
    // Prose is judged by the lines as set, before a row split over lines is joined.
    const cellLengths = lines.flatMap((r) => r.cells.map((c) => c.text.trim().length)).filter((n) => n > 0);
    if (median(cellLengths) > PROSE_CELL_LENGTH) {
        return null;
    }
    const headers = headerRow ? headerRow.cells.map((c) => c.text.trim()) : [];
    return { pageIndex, headers, rows: [...rows], tableTitle: null, runs: [...runs] };
}

function pushTable(tables: DetectedTable[], table: DetectedTable | null): void {
    if (table !== null) {
        tables.push(table);
    }
}
