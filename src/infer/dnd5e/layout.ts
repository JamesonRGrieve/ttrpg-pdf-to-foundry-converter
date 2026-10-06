// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../../types/ir.ts";
import { groupByBaseline } from "../../util/baselines.ts";
import { bodyStyle } from "../../util/body-style.ts";
import { numAsc } from "../../util/ordered.ts";
import { joinRuns, marginalIn, type TextLine, withoutRunningFurniture } from "../detect-entries.ts";

/**
 * Reading order and section structure of a document, from geometry and
 * typography alone.
 *
 * A page is read by cutting it into regions: at a column edge the document
 * uses, where no text crosses it, the page splits into columns read left to
 * right; where a full-width block (a table set across both columns) crosses
 * the edge, the page splits above and below that block first, so the columns
 * on either side of it are each read top to bottom. Each region's runs then
 * form lines, and a line's runs form cells wherever a wide gap separates them
 * (table cells, a label and its value).
 *
 * Headings are bold lines set larger than the body text; their sizes nest the
 * lines into a section tree.
 */

/** A run of words on a line with no wide gap inside it. */
export interface Cell {
    x: number;
    right: number;
    text: string;
    bold: boolean;
    italic: boolean;
}

export interface Line extends TextLine {
    /** Left edge of the first cell. */
    x: number;
    /** Highest top and lowest baseline of the line's runs. */
    top: number;
    bottom: number;
    /** The size and font carrying most of the line's characters. */
    size: number;
    font: string;
    bold: boolean;
    italic: boolean;
    cells: Cell[];
    /** Distance from the left edge of the line's region. */
    indent: number;
    /** Which region (column, or full-width block) of the document the line is in, in reading order. */
    region: number;
    /** Position in the document's reading order. */
    order: number;
}

export interface Section {
    /** The heading line; null for the document root. */
    heading: Line | null;
    title: string;
    size: number;
    /** Body lines and subsections, in reading order. */
    items: (Line | Section)[];
    parent: Section | null;
    /** Whether the heading captions a table (and the section holds only that table). */
    caption: boolean;
}

export interface Layout {
    lines: Line[];
    root: Section;
    bodySize: number;
}

/** Fewest pages a column edge must recur on to be one of the document's column edges. */
const MIN_EDGE_PAGES = 3;
/** Least share of the most-used edge's pages another edge must recur on. */
const EDGE_SHARE = 0.05;
/** Points within which two column edges are the same edge. */
const EDGE_MERGE = 3;
/** Points a run may start left of a column edge and still begin that column. */
const EDGE_TOLERANCE = 2;
/** Narrowest empty channel before a column edge that separates two columns, in points. */
const MIN_CHANNEL = 6;
/** Narrowest content on each side of a cut, in points. */
const MIN_SIDE = 36;
/** Deepest region recursion (columns within full-width blocks within columns …). */
const MAX_CUT_DEPTH = 8;
/** Baselines within this many points are one line. */
const BASELINE_TOLERANCE = 2;
/** A gap wider than this many ems between runs separates cells. */
const CELL_GAP_EM = 1.2;
/** Between runs of different weights, a gap this many ems wide (a tab stop, not a word space) separates cells. */
const WEIGHT_CHANGE_GAP_EM = 0.6;
/** A heading is set at least this many points larger than the body. */
const HEADING_SIZE_MARGIN = 0.4;
/** Longest heading, in characters; longer bold text is a bold paragraph. */
const MAX_HEADING_LENGTH = 90;
/** Two heading lines within this many of their ems of each other are one heading. */
const HEADING_JOIN_EM = 1.6;

const visible = (r: IRTextRun): boolean => r.text.trim().length > 0;

/** The modal start of a page column's runs, to the nearest point. */
function modalStart(runs: readonly IRTextRun[]): number | null {
    const counts = new Map<number, number>();
    for (const r of runs) {
        const x = Math.round(r.x);
        counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [x, n] of [...counts].sort((a, b) => numAsc(a[0], b[0]))) {
        if (n > bestCount) {
            best = x;
            bestCount = n;
        }
    }
    return best;
}

/**
 * The left edges of the document's columns after the first: where each page's
 * later columns most often start, kept when the same edge recurs on several
 * pages.
 */
export function columnEdges(ir: IR): number[] {
    const byPageColumn = new Map<string, IRTextRun[]>();
    for (const r of ir.runs) {
        if (r.column > 0 && visible(r)) {
            const key = `${r.pageIndex}:${r.column}`;
            byPageColumn.set(key, [...(byPageColumn.get(key) ?? []), r]);
        }
    }
    const pages = new Map<number, number>();
    for (const runs of byPageColumn.values()) {
        const x = modalStart(runs);
        if (x !== null) {
            pages.set(x, (pages.get(x) ?? 0) + 1);
        }
    }
    const ranked = [...pages].sort((a, b) => numAsc(b[1], a[1]) || numAsc(a[0], b[0]));
    // Table pages read as columns add stray edges; a layout's edge recurs on many pages.
    const floor = Math.max(MIN_EDGE_PAGES, EDGE_SHARE * (ranked[0]?.[1] ?? 0));
    const edges: { x: number; pages: number }[] = [];
    for (const [x, n] of ranked) {
        if (n >= floor && edges.every((e) => Math.abs(e.x - x) > EDGE_MERGE)) {
            edges.push({ x, pages: n });
        }
    }
    return edges.map((e) => e.x).sort(numAsc);
}

const runTop = (r: IRTextRun): number => r.y + r.height;

/** Runs left and right of a column edge, or null when a run crosses it. */
function splitAt(runs: readonly IRTextRun[], edge: number): [IRTextRun[], IRTextRun[]] | null {
    const left: IRTextRun[] = [];
    const right: IRTextRun[] = [];
    for (const r of runs) {
        if (r.x >= edge - EDGE_TOLERANCE) {
            right.push(r);
        } else if (r.x + r.width <= edge - MIN_CHANNEL) {
            left.push(r);
        } else {
            return null;
        }
    }
    return [left, right];
}

/** Fewest rows a table must carry across a channel for the channel to run through a table. */
const MIN_TABLE_ROWS = 3;
/** A line's cells on the right of a table are each at most this share of that side's width. */
const TABLE_CELL_SHARE = 0.4;
/** Least share of each side's lines over a table's rows that are its rows. */
const TABLE_SPAN_SHARE = 0.8;
/** Rows of one table follow each other within this many ems (a wrapped cell between them included). */
const TABLE_ROW_PITCH_EM = 3;

/** The side's lines: baseline groups of its runs, each sorted left to right. */
function sideLines(runs: readonly IRTextRun[]): IRTextRun[][] {
    const ordered = [...runs].sort((a, b) => numAsc(b.y, a.y) || numAsc(a.x, b.x));
    return groupByBaseline(ordered, BASELINE_TOLERANCE, true).map((g) =>
        [...g.runs].sort((a, b) => numAsc(a.x, b.x)),
    );
}

/**
 * The runs of a table set across a channel: rows of several cells on its
 * left whose baselines carry short cells on its right — more columns of the
 * same rows, so that over the rows' span most of the right side's lines are
 * such cells (a column of prose beside a table is mostly long lines). Empty
 * unless several rows do.
 */
function tableAcross(left: readonly IRTextRun[], right: readonly IRTextRun[]): IRTextRun[] {
    if (left.length === 0 || right.length === 0) {
        return [];
    }
    const rightWidth = Math.max(...right.map((r) => r.x + r.width)) - Math.min(...right.map((r) => r.x));
    const rightLines = sideLines(right);
    const short = new Set(
        rightLines.filter((l) =>
            cellsOf(l).every(({ cell }) => cell.right - cell.x <= TABLE_CELL_SHARE * rightWidth),
        ),
    );
    const leftRows = sideLines(left).filter((l) => cellsOf(l).length >= 2);
    const rows: IRTextRun[] = [];
    const matched = new Set<IRTextRun[]>();
    const paired: number[] = [];
    leftRows.forEach((line, index) => {
        const y = line[0]?.y ?? 0;
        const across = rightLines.find(
            (l) => short.has(l) && Math.abs((l[0]?.y ?? 0) - y) <= BASELINE_TOLERANCE,
        );
        if (across !== undefined) {
            rows.push(...line, ...across);
            matched.add(across);
            paired.push(index);
        }
    });
    if (matched.size < MIN_TABLE_ROWS) {
        return [];
    }
    // The left table's rows run on together; nearly all of them must carry on across
    // the channel, and over their span the right side must be mostly those cells —
    // two tables that merely share a row pitch, or a table beside prose, are not one.
    let first = Math.min(...paired);
    let last = Math.max(...paired);
    const near = (a: IRTextRun[] | undefined, b: IRTextRun[] | undefined): boolean =>
        a !== undefined &&
        b !== undefined &&
        Math.abs((a[0]?.y ?? 0) - (b[0]?.y ?? 0)) <= TABLE_ROW_PITCH_EM * (a[0]?.size ?? 0);
    while (first > 0 && near(leftRows[first - 1], leftRows[first])) {
        first -= 1;
    }
    while (last < leftRows.length - 1 && near(leftRows[last], leftRows[last + 1])) {
        last += 1;
    }
    const top = leftRows[first]?.[0]?.y ?? 0;
    const bottom = leftRows[last]?.[0]?.y ?? 0;
    const spanned = rightLines.filter((l) => (l[0]?.y ?? 0) <= top && (l[0]?.y ?? 0) >= bottom).length;
    return paired.length >= TABLE_SPAN_SHARE * (last - first + 1) &&
        matched.size >= TABLE_SPAN_SHARE * spanned
        ? rows
        : [];
}

/** Whether a cut at the edge leaves content on both sides of it. */
function splits(runs: readonly IRTextRun[], edge: number): boolean {
    const left = Math.min(...runs.map((r) => r.x));
    const right = Math.max(...runs.map((r) => r.x + r.width));
    return edge - left >= MIN_SIDE && right - edge >= MIN_SIDE;
}

/**
 * The runs above, inside and below the full-width block around the runs that
 * cross an edge. The region's runs fall into bands separated by whitespace
 * gaps at least `gap` points tall across its whole width; the block is the
 * bands the crossing runs are in.
 */
function aroundBlock(
    runs: readonly IRTextRun[],
    blockers: ReadonlySet<IRTextRun>,
    gap: number,
): [IRTextRun[], IRTextRun[], IRTextRun[]] {
    const sorted = [...runs].sort((a, b) => numAsc(runTop(b), runTop(a)));
    const bands: IRTextRun[][] = [];
    let floor = Number.POSITIVE_INFINITY;
    for (const r of sorted) {
        const band = bands.at(-1);
        if (band === undefined || runTop(r) <= floor - gap) {
            bands.push([r]);
        } else {
            band.push(r);
        }
        floor = Math.min(floor, r.y);
    }
    const blocked = bands.map((band) => band.some((r) => blockers.has(r)));
    const first = blocked.indexOf(true);
    const last = blocked.lastIndexOf(true);
    return [bands.slice(0, first).flat(), bands.slice(first, last + 1).flat(), bands.slice(last + 1).flat()];
}

/** A page region's runs as reading-order leaves (each read top to bottom). */
function cutRegion(
    runs: readonly IRTextRun[],
    edges: readonly number[],
    gap: number,
    depth: number,
): IRTextRun[][] {
    if (runs.length === 0) {
        return [];
    }
    const candidates = edges.filter((e) => splits(runs, e));
    if (depth < MAX_CUT_DEPTH) {
        for (const edge of candidates) {
            const sides = splitAt(runs, edge);
            if (
                sides !== null &&
                sides[0].length > 0 &&
                sides[1].length > 0 &&
                tableAcross(sides[0], sides[1]).length === 0
            ) {
                return sides.flatMap((side) => cutRegion(side, edges, gap, depth + 1));
            }
        }
        for (const edge of candidates) {
            // A full-width block: runs crossing the edge, and the rows of a table set across it.
            const crossing = runs.filter(
                (r) => r.x < edge - EDGE_TOLERANCE && r.x + r.width > edge - MIN_CHANNEL,
            );
            const clear = runs.filter((r) => !crossing.includes(r));
            const blockers = new Set([
                ...crossing,
                ...tableAcross(
                    clear.filter((r) => r.x < edge - EDGE_TOLERANCE),
                    clear.filter((r) => r.x >= edge - EDGE_TOLERANCE),
                ),
            ]);
            if (blockers.size === 0) {
                continue;
            }
            const [above, inside, below] = aroundBlock(runs, blockers, gap);
            if (above.length > 0 || below.length > 0) {
                return [
                    ...cutRegion(above, edges, gap, depth + 1),
                    ...cutRegion(inside, edges, gap, depth + 1),
                    ...cutRegion(below, edges, gap, depth + 1),
                ];
            }
        }
    }
    return [[...runs]];
}

/** Split a line's runs (sorted by x) into cells at wide gaps. */
export function cellsOf(runs: readonly IRTextRun[]): { cell: Cell; runs: IRTextRun[] }[] {
    const groups: IRTextRun[][] = [];
    let prevEnd = Number.NEGATIVE_INFINITY;
    let prevSize = 0;
    let prevWeight: IRTextRun["weight"] | null = null;
    for (const r of runs) {
        if (!visible(r)) {
            continue;
        }
        const gap = r.x - prevEnd;
        const em = Math.max(prevSize, r.size);
        const last = groups.at(-1);
        if (
            last === undefined ||
            gap > CELL_GAP_EM * em ||
            (r.weight !== prevWeight && gap > WEIGHT_CHANGE_GAP_EM * em)
        ) {
            groups.push([r]);
        } else {
            last.push(r);
        }
        prevEnd = r.x + r.width;
        prevSize = r.size;
        prevWeight = r.weight;
    }
    return groups.map((group) => ({
        runs: group,
        cell: {
            x: group[0]?.x ?? 0,
            right: Math.max(...group.map((r) => r.x + r.width)),
            text: joinRuns(group),
            bold: group.every((r) => r.weight === "bold"),
            italic: group.every((r) => r.italic),
        },
    }));
}

/** The value of `key` carrying the most characters of the runs. */
function dominant<T>(runs: readonly IRTextRun[], key: (r: IRTextRun) => T): T | null {
    const chars = new Map<T, number>();
    for (const r of runs) {
        chars.set(key(r), (chars.get(key(r)) ?? 0) + r.text.length);
    }
    let best: T | null = null;
    let bestChars = -1;
    for (const [value, n] of chars) {
        if (n > bestChars) {
            best = value;
            bestChars = n;
        }
    }
    return best;
}

function buildLine(runs: readonly IRTextRun[], region: number, regionLeft: number): Line | null {
    const sorted = [...runs].filter(visible).sort((a, b) => numAsc(a.x, b.x));
    const cells = cellsOf(sorted);
    const [first] = sorted;
    if (first === undefined || cells.length === 0) {
        return null;
    }
    const x = cells[0]?.cell.x ?? first.x;
    return {
        pageIndex: first.pageIndex,
        column: 0,
        y: Math.min(...sorted.map((r) => r.y)),
        runs: sorted,
        text: cells.map((c) => c.cell.text).join(" "),
        right: Math.max(...sorted.map((r) => r.x + r.width)),
        x,
        top: Math.max(...sorted.map(runTop)),
        bottom: Math.min(...sorted.map((r) => r.y)),
        size: dominant(sorted, (r) => r.size) ?? first.size,
        font: dominant(sorted, (r) => r.font) ?? first.font,
        bold: sorted.every((r) => r.weight === "bold"),
        italic: sorted.every((r) => r.italic),
        cells: cells.map((c) => c.cell),
        indent: x - regionLeft,
        region,
        order: 0,
    };
}

/** Every line of the document in reading order, page furniture removed. */
export function readingOrder(ir: IR, bodySize: number): Line[] {
    const edges = columnEdges(ir);
    const byPage = new Map<number, IRTextRun[]>();
    // A text layer may set the same text twice on the same spot; it reads once.
    const placed = new Set<string>();
    for (const r of ir.runs) {
        const place = `${r.pageIndex}|${r.x}|${r.y}|${r.size}|${r.text}`;
        if (visible(r) && !placed.has(place)) {
            placed.add(place);
            byPage.set(r.pageIndex, [...(byPage.get(r.pageIndex) ?? []), r]);
        }
    }
    const lines: Line[] = [];
    let region = 0;
    for (const page of [...byPage.keys()].sort(numAsc)) {
        for (const leaf of cutRegion(byPage.get(page) ?? [], edges, bodySize, 0)) {
            const left = Math.min(...leaf.map((r) => r.x));
            const ordered = [...leaf].sort((a, b) => numAsc(b.y, a.y) || numAsc(a.x, b.x));
            for (const group of groupByBaseline(ordered, BASELINE_TOLERANCE, true)) {
                const line = buildLine(group.runs, region, left);
                if (line !== null) {
                    lines.push(line);
                }
            }
            region += 1;
        }
    }
    // A line holds a whole running foot, folio included: its digits differ page to page.
    const kept = withoutRunningFurniture(lines, marginalIn(ir), (text) => text.replace(/\d+/gu, "#"));
    kept.forEach((line, i) => {
        line.order = i;
    });
    return kept;
}

/** Whether a line is a heading: one bold cell set larger than the body. */
export function isHeading(line: Line, bodySize: number): boolean {
    const [cell] = line.cells;
    return (
        line.cells.length === 1 &&
        cell !== undefined &&
        cell.bold &&
        !cell.italic &&
        line.size >= bodySize + HEADING_SIZE_MARGIN &&
        /\p{L}/u.test(cell.text) &&
        cell.text.length <= MAX_HEADING_LENGTH
    );
}

/** Join a heading set over several lines ("Subclass:" / "Its Name") into one heading. */
function joinHeadings(lines: readonly Line[], bodySize: number): Line[] {
    const out: Line[] = [];
    for (const line of lines) {
        const prev = out.at(-1);
        if (
            prev !== undefined &&
            isHeading(prev, bodySize) &&
            isHeading(line, bodySize) &&
            prev.size === line.size &&
            prev.font === line.font &&
            prev.region === line.region &&
            prev.bottom - line.bottom <= HEADING_JOIN_EM * line.size
        ) {
            const text = `${prev.text} ${line.text}`;
            out[out.length - 1] = {
                ...prev,
                runs: [...prev.runs, ...line.runs],
                text,
                cells: [{ ...(prev.cells[0] as Cell), text, right: Math.max(prev.right, line.right) }],
                bottom: line.bottom,
                y: line.y,
            };
        } else {
            out.push(line);
        }
    }
    return out;
}

/** Whether a heading captions a table: the line after it is a row of cells. */
function isCaption(lines: readonly Line[], index: number): boolean {
    return (lines[index + 1]?.cells.length ?? 0) >= 2;
}

/** A single-cell line this many times wider than the table's widest cell is prose after it. */
const PROSE_AFTER_TABLE = 1.5;

/** A caption's table and where it stands: its region, and its widest cell so far. */
interface CaptionState {
    region: number;
    widest: number;
}

/**
 * Whether a line ends a caption's table: it is in another region, or it is a
 * single cell that leads with a bold-italic run (a trait after the table) or
 * runs wider than any cell of the table (a paragraph after it).
 */
function endsTable(line: Line, caption: CaptionState): boolean {
    if (line.region !== caption.region) {
        return true;
    }
    if (line.cells.length >= 2) {
        caption.widest = Math.max(caption.widest, ...line.cells.map((c) => c.right - c.x));
        return false;
    }
    const lead = line.runs[0];
    return (
        (lead !== undefined && lead.weight === "bold" && lead.italic) ||
        line.right - line.x > PROSE_AFTER_TABLE * caption.widest
    );
}

/**
 * Nest lines into sections by heading size. A table's caption heads a section
 * only for the table itself, so the text after a table (a full-width one, or
 * one inside a column) goes back to the section the table interrupted.
 */
export function sectionTree(lines: readonly Line[], bodySize: number): Section {
    const root: Section = {
        heading: null,
        title: "",
        size: Number.POSITIVE_INFINITY,
        items: [],
        parent: null,
        caption: false,
    };
    const stack: Section[] = [root];
    const captions = new Map<Section, CaptionState>();
    const top = (): Section => stack.at(-1) ?? root;
    lines.forEach((line, index) => {
        while (stack.length > 1) {
            const caption = captions.get(top());
            if (caption === undefined || !endsTable(line, caption)) {
                break;
            }
            stack.pop();
        }
        if (isHeading(line, bodySize)) {
            while (stack.length > 1 && top().size <= line.size) {
                stack.pop();
            }
            const caption = isCaption(lines, index);
            const section: Section = {
                heading: line,
                title: line.text,
                size: line.size,
                items: [],
                parent: top(),
                caption,
            };
            top().items.push(section);
            stack.push(section);
            if (caption) {
                captions.set(section, { region: line.region, widest: 0 });
            }
        } else {
            top().items.push(line);
        }
    });
    return root;
}

export function readLayout(ir: IR): Layout {
    const bodySize = bodyStyle(ir).size;
    const lines = joinHeadings(readingOrder(ir, bodySize), bodySize);
    lines.forEach((line, i) => {
        line.order = i;
    });
    return { lines, root: sectionTree(lines, bodySize), bodySize };
}

export const isSection = (item: Line | Section): item is Section => "items" in item;

/** The section and every section under it, in reading order. */
export function sectionsOf(section: Section): Section[] {
    return [section, ...section.items.filter(isSection).flatMap(sectionsOf)];
}

/** The section's own body lines (not its subsections'). */
export function ownLines(section: Section): Line[] {
    return section.items.filter((item): item is Line => !isSection(item));
}

/** Every body line under the section, its subsections' included, in reading order. */
export function allLines(section: Section): Line[] {
    return section.items.flatMap((item) => (isSection(item) ? allLines(item) : [item]));
}

/** The section's ancestors, nearest first. */
export function ancestors(section: Section): Section[] {
    const out: Section[] = [];
    for (let s = section.parent; s !== null; s = s.parent) {
        out.push(s);
    }
    return out;
}
