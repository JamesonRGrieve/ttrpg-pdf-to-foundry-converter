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
    const xCounts = new Map<number, number>();
    for (const row of rows) {
        const seenBuckets = new Set<number>();
        for (const run of row.runs) {
            const bucket = Math.round(run.x / X_TOLERANCE) * X_TOLERANCE;
            if (!seenBuckets.has(bucket)) {
                xCounts.set(bucket, (xCounts.get(bucket) ?? 0) + 1);
                seenBuckets.add(bucket);
            }
        }
    }
    const minCount = Math.max(MIN_ROWS, Math.floor(rows.length * 0.3));
    return [...xCounts.entries()]
        .filter(([, count]) => count >= minCount)
        .map(([x, count]) => ({ x, count }))
        .sort((a, b) => a.x - b.x);
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

function isSpanningHeader(row: RawRow, columns: ColumnEdge[]): boolean {
    if (row.runs.length === 0) {
        return false;
    }
    const allBold = row.runs.every((r) => r.weight === "bold");
    if (!allBold) {
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

    for (const [pageIndex, pageRows] of pageGroups) {
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

        for (const [i, row] of sorted.entries()) {
            const cells = assignRunsToColumns(row.runs, columns);

            if (cells.length >= MIN_COLUMNS - 1) {
                if (tableStart === -1) {
                    tableStart = i;
                }
                const allBold = row.runs.every((r) => r.weight === "bold");
                const isHeader = allBold && !headerRow;
                const spanning = isSpanningHeader(row, columns);

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
                    headerRow = {
                        cells,
                        isHeaderRow: true,
                        isSectionHeader: false,
                        sectionName: null,
                    };
                } else {
                    tableRows.push({
                        cells,
                        isHeaderRow: false,
                        isSectionHeader: false,
                        sectionName: null,
                    });
                }
            } else if (tableStart !== -1 && tableRows.length >= MIN_ROWS) {
                pushTable(tables, buildTable(pageIndex, headerRow, tableRows));
                tableStart = -1;
                headerRow = null;
                tableRows.length = 0;
            } else if (tableStart !== -1) {
                tableStart = -1;
                headerRow = null;
                tableRows.length = 0;
            }
        }
        if (tableStart !== -1 && tableRows.length >= MIN_ROWS) {
            pushTable(tables, buildTable(pageIndex, headerRow, tableRows));
        }
    }
    return tables;
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

function buildTable(pageIndex: number, headerRow: TableRow | null, rows: TableRow[]): DetectedTable | null {
    const cellLengths = rows.flatMap((r) => r.cells.map((c) => c.text.trim().length)).filter((n) => n > 0);
    if (median(cellLengths) > PROSE_CELL_LENGTH) {
        return null;
    }
    const headers = headerRow ? headerRow.cells.map((c) => c.text.trim()) : [];
    return { pageIndex, headers, rows: [...rows], tableTitle: null };
}

function pushTable(tables: DetectedTable[], table: DetectedTable | null): void {
    if (table !== null) {
        tables.push(table);
    }
}
