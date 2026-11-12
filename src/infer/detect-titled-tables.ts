// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";
import { type BaselineLine, groupByBaseline } from "../util/baselines.ts";
import { bodyStyle } from "../util/body-style.ts";
import { columnAt } from "../util/columns.ts";
import { numAsc } from "../util/ordered.ts";
import { inMarginBand, inSideMargin, type MarginBands, marginBandsOf } from "../util/page-bands.ts";
import { percentile } from "../util/stats.ts";
import { NOTE_MARKERS, wordBreakBetween } from "../util/text.ts";
import { headerRole, isAdvanceList, mergedHeaderRoles, normalizeHeader } from "./columns.ts";
import { restoreWordSpaces } from "./names.ts";
import { mergeContinuationRows } from "./row-merge.ts";
import type { DetectedTable, TableCell, TableRow, TitledTable } from "./types.ts";

/**
 * Detect tables by their title pattern ("Table N-N: Title") and extract row
 * data from the text runs below the title. This is more robust than pure
 * column-alignment detection for PDFs with decorative fonts that fragment
 * runs — the title anchors the table region, and row parsing uses y-position
 * grouping rather than global column alignment.
 */

const TABLE_TITLE_RE = /^Table\s+\d+[-–]\d+:?\s*(.*)/i;
/** The first run of a caption: it opens with the word. */
const CAPTION_START = /^Table\b/i;

/** A numbered table caption ("Table 3-2: …"), not a heading of its own. */
export function isTableCaption(text: string): boolean {
    return TABLE_TITLE_RE.test(text.trim());
}
const Y_TOL = 5;
/** Runs within this many points vertically share a printed line. */
const LINE_Y_TOL = 2;
/** A captioned table has at least this many columns (a roll table: roll + result). */
const MIN_COLUMNS = 2;

interface TitleHit {
    pageIndex: number;
    y: number;
    /** The caption's title; null for a table anchored on its header row alone. */
    title: string | null;
    run: IRTextRun;
}

/** Widest gap between runs of one caption line. */
const CAPTION_GAP = 12;
/** A caption line within this many caption-sizes below continues the caption. */
const CAPTION_WRAP_FACTOR = 1.4;

/**
 * The full caption text: the matching run, the same-style runs that continue
 * its baseline, and wrapped caption lines directly beneath it.
 */
function captionText(ir: IR, start: IRTextRun): string {
    const sameStyle = (r: IRTextRun): boolean =>
        r.pageIndex === start.pageIndex && r.font === start.font && r.weight === start.weight && r !== start;
    let text = start.text;
    let end = start.x + start.width;
    const onLine = ir.runs
        .filter((r) => sameStyle(r) && Math.abs(r.y - start.y) < LINE_Y_TOL && r.x >= end - 1)
        .sort((a, b) => a.x - b.x);
    for (const r of onLine) {
        if (r.x - end > CAPTION_GAP) {
            break;
        }
        text = joinText(text, r.text, r.x - end);
        end = r.x + r.width;
    }
    let y = start.y;
    for (;;) {
        const below = ir.runs
            .filter(
                (r) =>
                    sameStyle(r) &&
                    y - r.y > LINE_Y_TOL &&
                    y - r.y <= CAPTION_WRAP_FACTOR * start.size &&
                    Math.abs(r.x - start.x) < CAPTION_GAP,
            )
            .sort((a, b) => a.x - b.x);
        const [lead] = below;
        if (lead === undefined) {
            break;
        }
        text = `${text} ${below.map((r) => r.text).join(" ")}`;
        y = lead.y;
    }
    return text.replace(/\s+/gu, " ").trim();
}

/**
 * A caption stands alone on its baseline. A table reference set in the same
 * bold face inside running text ("… roll on Table 8-15: Malignancies (see
 * page 290) …") has text in another face right beside it.
 */
function inRunningText(ir: IR, run: IRTextRun): boolean {
    return ir.runs.some(
        (r) =>
            r.pageIndex === run.pageIndex &&
            r !== run &&
            r.text.trim().length > 0 &&
            (r.font !== run.font || r.weight !== run.weight) &&
            Math.abs(r.y - run.y) < LINE_Y_TOL &&
            r.x + r.width >= run.x - CAPTION_GAP &&
            r.x <= run.x + run.width + CAPTION_GAP,
    );
}

/** On a page read from its image, a caption is set at least this many times the body text's size. */
const CAPTION_SIZE_RATIO = 1.2;

/**
 * Captions are set apart from running text: in bold, or in a face other than
 * the body text's. A table named inside prose is set in the body face. A page
 * read from its image has one face and measured weights, so there a caption
 * set clearly larger than the body text is set apart too.
 */
function findTableTitles(ir: IR): TitleHit[] {
    const body = bodyStyle(ir);
    const [bodyFont, , bodyWeight] = body.style.split("|");
    const measured = new Set(ir.pages.filter((p) => !p.hasTextLayer).map((p) => p.pageIndex));
    const captionFace = (r: IRTextRun): boolean =>
        r.weight === "bold" ||
        r.font !== bodyFont ||
        r.weight !== bodyWeight ||
        (measured.has(r.pageIndex) && r.size >= CAPTION_SIZE_RATIO * body.size);
    const hits: TitleHit[] = [];
    for (const run of ir.runs) {
        // A caption may be set in several runs ("Table" · "6-1:" in a larger
        // numeral · "Ranged Weapons"): its first run opens with the word, and
        // the whole caption line is what is tested.
        if (!captionFace(run) || !CAPTION_START.test(run.text) || inRunningText(ir, run)) {
            continue;
        }
        const text = captionText(ir, run);
        const m = text.match(TABLE_TITLE_RE);
        if (m === null) {
            continue;
        }
        const printed = m[1]?.trim() ?? "";
        hits.push({
            pageIndex: run.pageIndex,
            y: run.y,
            title: restoreWordSpaces(printed.length > 0 ? printed : referencedTitle(ir, text, run.pageIndex)),
            run,
        });
    }
    return hits;
}

/** A table's number, as its caption and references to it print it. */
const TABLE_NUMBER = /^Table\s+(?<number>\d+[-–]\d+)/iu;

/**
 * The title a caption printing only its number ("Table 2-9:", its title
 * set as art) is given where the text refers to the table by number and
 * title — on the caption's page first, else anywhere in the document.
 */
function referencedTitle(ir: IR, caption: string, pageIndex: number): string {
    const number = TABLE_NUMBER.exec(caption)?.groups?.["number"]?.replace("–", "-");
    if (number === undefined) {
        return "";
    }
    const titles = ir.runs.flatMap((r) => {
        const m = TABLE_TITLE_RE.exec(r.text.trim());
        const title = m?.[1]?.trim().replace(/[\s,.;:]+$/u, "") ?? "";
        const same = TABLE_NUMBER.exec(r.text.trim())?.groups?.["number"]?.replace("–", "-") === number;
        return same && title.length > 0 ? [{ title, here: r.pageIndex === pageIndex }] : [];
    });
    return (titles.find((t) => t.here) ?? titles[0])?.title ?? "";
}

/** Share of keys that must follow a finished sentence for a table's keys to head their rows. */
const HEADED_KEY_SHARE = 0.8;

/**
 * Keyed tables set a row's key (a roll band, a severity number) either on the
 * row's first line or vertically centred against its multi-line text. Keys
 * head their rows when the first line carries one, every key's line opens its
 * text, and the line before each later key finishes a sentence (the previous
 * row's end); then every line joins the key above it. Otherwise, when only some lines have content in the
 * key column, every line joins the nearest keyed line (ties go to the key
 * above).
 */
export function groupByKeyAnchors(lines: readonly RawRow[], colBoundaries: readonly number[]): RawRow[] {
    const variants = variantLines(lines, colBoundaries);
    if (variants.size === 0) {
        return groupAnchored(lines, colBoundaries);
    }
    const rows = groupAnchored(
        lines.filter((l) => !variants.has(l)),
        colBoundaries,
    );
    const own = [...variants].map(([line, key]) => ({
        y: line.y,
        runs: [{ ...key, y: line.y }, ...line.runs],
    }));
    return [...rows, ...own].sort((a, b) => b.y - a.y);
}

/** Most words a value cell of a variant row holds: values, not wrapped text. */
const VARIANT_CELL_WORDS = 4;

/**
 * Lines of values under a keyed row with no key of their own (a component's
 * figures for a second hull size, set on the next line): each fills the very
 * columns its key's line fills, with short cells, some of them numbers, so it
 * is a row of that key rather than wrapped text. Mapped to the key run above.
 */
function variantLines(lines: readonly RawRow[], colBoundaries: readonly number[]): Map<RawRow, IRTextRun> {
    const out = new Map<RawRow, IRTextRun>();
    const cells = (row: RawRow): Map<number, string> => {
        const m = new Map<number, string>();
        for (const r of row.runs.filter((x) => x.text.trim().length > 0)) {
            const col = columnOfRun(r.x, colBoundaries);
            m.set(col, `${m.get(col) ?? ""} ${r.text}`.trim());
        }
        return m;
    };
    const values = (m: Map<number, string>): number[] => [...m.keys()].filter((c) => c > 0).sort(numAsc);
    const short = (m: Map<number, string>): boolean =>
        values(m).every((c) => (m.get(c) ?? "").split(/\s+/u).length <= VARIANT_CELL_WORDS) &&
        values(m).some((c) => /^(?:[+\-–−]?\d+|[-–—])$/u.test(m.get(c) ?? ""));
    let anchor: { line: RawRow; cells: Map<number, string>; key: IRTextRun } | null = null;
    for (const line of lines) {
        const m = cells(line);
        const key = line.runs.find((r) => r.text.trim().length > 0 && columnOfRun(r.x, colBoundaries) === 0);
        if (key !== undefined) {
            anchor = { line, cells: m, key };
            continue;
        }
        const own = values(m);
        const keyed = anchor === null ? [] : values(anchor.cells);
        if (
            anchor !== null &&
            own.length >= 2 &&
            own.length === keyed.length &&
            own.every((c, i) => c === keyed[i]) &&
            short(m) &&
            short(anchor.cells)
        ) {
            out.set(line, anchor.key);
        }
    }
    return out;
}

function groupAnchored(lines: readonly RawRow[], colBoundaries: readonly number[]): RawRow[] {
    const keyRun = (row: RawRow): IRTextRun | undefined =>
        row.runs.find((r) => r.text.trim().length > 0 && columnOfRun(r.x, colBoundaries) === 0);
    // A bold line among records that are not is a section row ("Chain
    // Weapons"), set centred over the columns: it stands as its own row
    // rather than joining the nearest key.
    const allBold = (row: RawRow): boolean => {
        const visible = row.runs.filter((r) => r.text.trim().length > 0);
        return visible.length > 0 && visible.every((r) => r.weight === "bold");
    };
    const boldRecords = lines.filter(allBold).length * 2 > lines.length;
    const isSection = (row: RawRow): boolean => !boldRecords && allBold(row) && keyRun(row) === undefined;
    const anchors = lines.filter((row) => keyRun(row) !== undefined || isSection(row));
    if (anchors.length === 0 || anchors.length === lines.length) {
        return [...lines];
    }
    const lineText = (row: RawRow): string =>
        [...row.runs]
            .sort((a, b) => a.x - b.x)
            .map((r) => r.text)
            .join(" ")
            .trim();
    const later = anchors.slice(1).map((a) => lines[lines.indexOf(a) - 1]);
    const finished = later.filter((prev) => prev !== undefined && /[.!?)]["”’]?$/u.test(lineText(prev)));
    // A key heading its row opens the row's text; a centred key may sit mid-sentence.
    const opensText = (row: RawRow): boolean => {
        const key = keyRun(row);
        const text = lineText({ y: row.y, runs: row.runs.filter((r) => r !== key) });
        return /^[\p{Lu}\p{N}"“‘']/u.test(text);
    };
    if (
        lines[0] === anchors[0] &&
        anchors.every((a) => isSection(a) || opensText(a)) &&
        finished.length >= HEADED_KEY_SHARE * later.length
    ) {
        const rows: RawRow[] = [];
        for (const line of lines) {
            const current = rows.at(-1);
            if (anchors.includes(line) || current === undefined) {
                rows.push({ y: line.y, runs: [...line.runs] });
            } else {
                current.runs.push(...line.runs);
            }
        }
        return rows;
    }
    // Distances are measured from the key itself: a key set mid-row can share
    // a baseline group with a neighbouring line of its cell.
    const grouped = anchors.map((a) => ({
        anchor: a,
        keyY: keyRun(a)?.y ?? a.y,
        row: { y: a.y, runs: [...a.runs] },
    }));
    for (const line of lines) {
        if (anchors.includes(line)) {
            continue;
        }
        // Nearest key (never a section row); a tie goes to the one above.
        const keyed = grouped.filter((g) => !isSection(g.anchor));
        const nearest = (keyed.length > 0 ? keyed : grouped).reduce((best, g) => {
            const d = Math.abs(g.keyY - line.y);
            const bestD = Math.abs(best.keyY - line.y);
            return d < bestD || (d === bestD && g.keyY > best.keyY) ? g : best;
        });
        nearest.row.runs.push(...line.runs);
    }
    return grouped.map((g) => g.row);
}

type RawRow = BaselineLine;

/** A run of note markers alone (a dagger): as a superscript it annotates a cell and sits off its baseline. */
const NOTE_MARKER_ONLY = new RegExp(`^(?:${NOTE_MARKERS.source}|\\s)+$`, "u");
/** A run set below this share of the table's typical size is a superscript. */
const SUPERSCRIPT_RATIO = 0.8;

/**
 * Runs in the table's band. Whitespace-only runs (inter-cell padding) carry no
 * layout and would bridge columns; note-marker runs carry no value and, set as
 * superscripts, would bridge lines; page furniture in the margin bands and
 * thumb-index tabs in the side margins are not part of any table.
 */
function collectTableRuns(
    ir: IR,
    bands: MarginBands,
    pageIndex: number,
    belowY: number,
    aboveY: number,
): IRTextRun[] {
    const page = ir.pages.find((p) => p.pageIndex === pageIndex);
    const band = ir.runs.filter(
        (r) =>
            r.pageIndex === pageIndex &&
            r.y < belowY &&
            r.y > aboveY &&
            !inMarginBand(r.y, page?.height ?? 0, bands) &&
            !inSideMargin(r.x, r.x + r.width, page?.width ?? 0) &&
            r.text.trim().length > 0,
    );
    // A full-size marker can be a cell's own value ("see the note"); only a
    // superscript one is dropped.
    const sizes = band.map((r) => r.size).sort((a, b) => a - b);
    const typical = sizes[Math.floor(sizes.length / 2)] ?? 0;
    return band.filter((r) => !(NOTE_MARKER_ONLY.test(r.text) && r.size < SUPERSCRIPT_RATIO * typical));
}

function groupIntoRows(runs: IRTextRun[]): RawRow[] {
    const rows = groupByBaseline(
        [...runs].sort((a, b) => b.y - a.y),
        Y_TOL,
    );
    for (const row of rows) {
        row.runs.sort((a, b) => a.x - b.x);
    }
    return rows.sort((a, b) => b.y - a.y);
}

/** Runs closer than this many font-sizes are pieces of one header label (a word space). */
const HEADER_JOIN_FACTOR = 0.45;
/** Widest plausible glyph advance, in font-sizes (a wide capital). */
const MAX_GLYPH_ADVANCE = 0.75;
/** A gap wider than this between joined runs is a word space. */
const WORD_GAP = 1.5;
/** A cell's text may start this far left of its column's header edge (centred values). */
const COLUMN_EDGE_TOLERANCE = 4;

function joinText(a: string, b: string, gap: number): string {
    return wordBreakBetween(a, b, gap, WORD_GAP) ? `${a} ${b}` : a + b;
}

/** Merge a header row's runs into its column labels (words of one label sit close together). */
/** Fewest body lines that must start a cell at one x for it to be a column edge. */
const MIN_ALIGNED_ROWS = 3;

/**
 * Where the lines below a header start their cells: every x at which at least
 * MIN_ALIGNED_ROWS lines start a run. A header label there opens a column,
 * however narrow the gap before it.
 */
function cellEdges(below: readonly RawRow[]): number[] {
    const starts = below.flatMap((line) => [
        ...new Set(line.runs.filter((r) => r.text.trim().length > 0).map((r) => Math.round(r.x))),
    ]);
    return [...new Set(starts)].filter(
        (x) => starts.filter((s) => Math.abs(s - x) <= COLUMN_EDGE_TOLERANCE).length >= MIN_ALIGNED_ROWS,
    );
}

function mergeAdjacentText(
    runs: IRTextRun[],
    edges: readonly number[],
): { text: string; x: number; width: number; bold: boolean }[] {
    const [first, ...rest] = [...runs].sort((a, b) => a.x - b.x);
    if (first === undefined) {
        return [];
    }
    const merged: { text: string; x: number; width: number; bold: boolean }[] = [];
    let cur = { text: first.text, x: first.x, width: first.width, bold: first.weight === "bold" };
    let prev = first;
    for (const r of rest) {
        // A run can carry trailing advance past its glyphs; measure the gap
        // from where its text can plausibly end.
        const inkEnd = Math.min(
            cur.x + cur.width,
            prev.x + prev.text.trimEnd().length * prev.size * MAX_GLYPH_ADVANCE,
        );
        const gap = r.x - inkEnd;
        // A lone letter is a small-capital initial set as its own run ("d" of
        // "d" · "aM"): the label goes on in the next run, whatever edge that
        // run happens to start on.
        const initial = /^\p{L}$/u.test(cur.text.trim());
        const joins =
            gap < HEADER_JOIN_FACTOR * Math.max(r.size, prev.size) &&
            (initial || !edges.some((x) => Math.abs(r.x - x) <= COLUMN_EDGE_TOLERANCE));
        prev = r;
        if (joins) {
            cur.text = joinText(cur.text, r.text, gap);
            cur.width = r.x + r.width - cur.x;
            cur.bold = cur.bold || r.weight === "bold";
        } else {
            if (cur.text.trim().length > 0) {
                merged.push(cur);
            }
            cur = { text: r.text, x: r.x, width: r.width, bold: r.weight === "bold" };
        }
    }
    if (cur.text.trim().length > 0) {
        merged.push(cur);
    }
    return merged;
}

/**
 * Split runs that span a column edge. A text extractor fuses neighbouring
 * cells into one run when they sit closer than a word space, so a run crossing
 * an edge is cut at its word starts, each word placed by its estimated x
 * (proportional to character offset — exact enough to fall on the right side
 * of a gutter).
 */
function splitAtColumns(runs: readonly IRTextRun[], colBoundaries: readonly number[]): IRTextRun[] {
    const out: IRTextRun[] = [];
    for (const r of runs) {
        const end = r.x + r.width;
        const crosses = colBoundaries.some((b) => b > r.x + COLUMN_EDGE_TOLERANCE && b < end);
        if (!crosses || !/\s/u.test(r.text.trim()) || r.text.length === 0) {
            out.push(r);
            continue;
        }
        out.push(...cutAtEdges(r, colBoundaries));
    }
    return out;
}

/**
 * Split a run that crosses column edges into one piece per column. A text
 * layer can set a whole row's cells as one run, the wide gap between cells
 * written as a single space — so letters are not evenly spaced, and a cut is
 * made at the word break nearest each edge the run crosses. The piece after an
 * edge starts no further left than it.
 */
export function cutAtEdges(r: IRTextRun, colBoundaries: readonly number[]): IRTextRun[] {
    const perChar = r.width / r.text.length;
    const breaks = [...r.text.matchAll(/\s+/gu)].map((m) => m.index);
    const edges = colBoundaries.filter((b) => b > r.x + COLUMN_EDGE_TOLERANCE && b < r.x + r.width);
    const cuts: { at: number; edge: number }[] = [];
    for (const edge of edges) {
        const target = (edge - r.x) / perChar;
        const after = cuts.at(-1)?.at ?? -1;
        const [best] = breaks
            .filter((b) => b > after)
            .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
        if (best !== undefined) {
            cuts.push({ at: best, edge });
        }
    }
    const pieces: IRTextRun[] = [];
    let start = 0;
    let left = r.x;
    for (const { at, edge } of [...cuts, { at: r.text.length, edge: r.x + r.width }]) {
        const text = r.text.slice(start, at).trim();
        if (text.length > 0) {
            const x = Math.max(left, r.x + start * perChar);
            pieces.push({ ...r, text, x, width: Math.max(0, r.x + at * perChar - x) });
        }
        start = at;
        left = edge;
    }
    return pieces;
}

/**
 * A cell centred under its label may start left of the label's edge, inside
 * the column before. A run that starts mid-column (away from its column's own
 * edge, where a left-set cell or a row of fused cells starts) and lies mostly
 * past the next edge is that next column's cell: it is placed at that edge.
 */
export function centredInColumn(r: IRTextRun, colBoundaries: readonly number[]): IRTextRun {
    const end = r.x + r.width;
    const own = colBoundaries[columnOfRun(r.x, colBoundaries)] ?? r.x;
    const next = colBoundaries.find((b) => b > r.x + COLUMN_EDGE_TOLERANCE && b < end);
    if (next === undefined || r.x - own <= COLUMN_EDGE_TOLERANCE || end - next <= next - r.x) {
        return r;
    }
    return { ...r, x: next, width: end - next };
}

/** The column a run starts in: the last header edge at or left of it. */
function columnOfRun(x: number, colBoundaries: readonly number[]): number {
    return columnAt(x, colBoundaries, COLUMN_EDGE_TOLERANCE);
}

/** Share of body lines that must start a cell at one x for it to be the column's edge. */
const ALIGN_SHARE = 0.3;

/**
 * A header label may be inset from its column's text. Where the body lines
 * consistently start a run a little left of a header-derived edge (within the
 * header's gap to its left neighbour's own edge, and at most a font size
 * away), the column really starts there. Mutates `bounds` in place.
 */
export function alignBoundariesToData(bounds: number[], body: readonly RawRow[]): void {
    for (let i = 1; i < bounds.length; i += 1) {
        const edge = bounds[i];
        const left = bounds[i - 1];
        if (edge === undefined || left === undefined) {
            continue;
        }
        const counts = new Map<number, number>();
        for (const line of body) {
            const starts = new Set(
                line.runs
                    .filter(
                        (r) => r.text.trim().length > 0 && r.x < edge && edge - r.x <= r.size && r.x > left,
                    )
                    .map((r) => Math.round(r.x)),
            );
            for (const x of starts) {
                counts.set(x, (counts.get(x) ?? 0) + 1);
            }
        }
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (best !== undefined && best[1] >= ALIGN_SHARE * body.length) {
            bounds[i] = best[0] - COLUMN_EDGE_TOLERANCE / 2;
        }
    }
}

/**
 * Split header runs that set two labels as one ("Clip Rld") where the
 * records below start a column at the run's left edge and again inside it:
 * at the word nearest each inner edge, each piece becoming its own run —
 * only when every piece is a schema field label and the whole is not one, so
 * a long label over centred values ("Crit Rating", "Roll D100") or a label
 * naming one field ("Armour Type") stays whole. Word positions are estimated
 * from the run's even glyph advance.
 */
export function splitHeaderRuns(runs: readonly IRTextRun[], edges: readonly number[]): IRTextRun[] {
    return runs.flatMap((run) => {
        const words = [...run.text.matchAll(/\S+/gu)];
        const advance = run.text.length > 0 ? run.width / run.text.length : 0;
        const inside = edges.filter(
            (e) => e > run.x + COLUMN_EDGE_TOLERANCE && e < run.x + run.width - COLUMN_EDGE_TOLERANCE,
        );
        const atStart = edges.some((e) => Math.abs(e - run.x) <= COLUMN_EDGE_TOLERANCE);
        const twoLabels = words.length >= 2 && advance > 0 && headerRole(run.text) === null;
        if (!twoLabels || inside.length === 0 || !atStart) {
            return [run];
        }
        // Word starts (after the first) nearest each inner edge.
        const cuts = [
            ...new Set(
                inside.map((e) => {
                    const distance = (index: number): number => Math.abs(run.x + index * advance - e);
                    const starts = words.slice(1).map((w) => w.index);
                    return starts.sort((a, b) => distance(a) - distance(b))[0] ?? 0;
                }),
            ),
        ]
            .filter((c) => c > 0)
            .sort((a, b) => a - b);
        const bounds = [0, ...cuts, run.text.length];
        const pieces = bounds.slice(0, -1).map((start, i) => {
            const end = bounds[i + 1] ?? run.text.length;
            const text = run.text.slice(start, end).trimEnd();
            return { ...run, text, x: run.x + start * advance, width: text.length * advance };
        });
        return pieces.every((p) => headerRole(p.text) !== null) ? pieces : [run];
    });
}

function inferColumnBoundaries(headerRow: RawRow, edges: readonly number[]): number[] {
    const merged = mergeAdjacentText(headerRow.runs, edges);
    return merged.map((m) => m.x);
}

function assignToColumns(runs: IRTextRun[], colBoundaries: number[]): TableCell[] {
    const cells: TableCell[] = Array.from({ length: colBoundaries.length }, (_, i) => ({
        text: "",
        colIndex: i,
        isHeader: false,
    }));

    // A row may span several printed lines (wrapped cells). Each run is placed
    // in its column individually — never merged across a column edge — and a
    // column's pieces are joined line by line in reading order.
    const lines = groupByBaseline(
        [...runs].sort((a, b) => b.y - a.y),
        LINE_Y_TOL,
    );
    for (const line of lines) {
        const prevEnd = new Map<number, number>();
        for (const r of splitAtColumns(
            [...line.runs].sort((a, b) => a.x - b.x),
            colBoundaries,
        )) {
            const col = columnOfRun(r.x, colBoundaries);
            const cell = cells[col];
            if (r.text.length === 0 || cell === undefined) {
                continue;
            }
            const end = prevEnd.get(col);
            cell.text =
                end === undefined
                    ? cell.text
                        ? `${cell.text} ${r.text}`
                        : r.text
                    : joinText(cell.text, r.text, r.x - end);
            cell.isHeader = cell.isHeader || r.weight === "bold";
            prevEnd.set(col, r.x + r.width);
        }
    }
    for (const cell of cells) {
        cell.text = cell.text.replace(/\s+/gu, " ").trim();
    }
    return cells.filter((c) => c.text.length > 0);
}

/** Fewest schema field labels that make a bold line a table header with no caption. */
const MIN_ANCHOR_ROLES = 3;
/** Points below a caption's baseline a table's runs start (clearing the caption line). */
const CAPTION_CLEARANCE = 5;
/** An anchored table's title sits just above its header row, so the band keeps that row. */
const ANCHOR_LIFT = CAPTION_CLEARANCE + 1;

/**
 * Header rows of tables printed with no caption: a line whose bold labels
 * name at least MIN_ANCHOR_ROLES of the schema's fields ("Name", "Dam",
 * "Avail"), not already part of a captioned table (`covered`).
 */
function headerAnchors(ir: IR, covered: ReadonlySet<IRTextRun>): TitleHit[] {
    const hits: TitleHit[] = [];
    const pages = new Map<number, IRTextRun[]>();
    for (const r of ir.runs) {
        pages.set(r.pageIndex, [...(pages.get(r.pageIndex) ?? []), r]);
    }
    for (const [pageIndex, runs] of pages) {
        for (const row of groupIntoRows(runs)) {
            const bold = headerLabels(row).runs;
            const first = bold.find((r) => r.text.trim().length > 0);
            if (first === undefined || bold.some((r) => covered.has(r))) {
                continue;
            }
            const labels = mergeAdjacentText(bold, []);
            const roles = labels.filter((l) => headerRole(l.text) !== null).length;
            if (labels.length >= MIN_COLUMNS && roles >= MIN_ANCHOR_ROLES) {
                hits.push({ pageIndex, y: row.y + ANCHOR_LIFT, title: null, run: first });
            }
        }
    }
    return hits;
}

/**
 * Read the table each title opens: it runs down to the nearest title below it
 * in the same text column, else to the page's text floor.
 */
function readAtTitles(ir: IR, titles: readonly TitleHit[], bands: MarginBands): TitledTable[] {
    const tables: TitledTable[] = [];
    for (const title of titles) {
        const below = titles.filter(
            (tt) => tt.pageIndex === title.pageIndex && tt.y < title.y && tt.run.column === title.run.column,
        );
        const bottomBound = below.length > 0 ? Math.max(...below.map((tt) => tt.y)) + 10 : 30;
        const band = collectTableRuns(ir, bands, title.pageIndex, title.y - CAPTION_CLEARANCE, bottomBound);
        // The table spans exactly the text columns its header row occupies: a
        // neighbouring column's prose shares the band, while a wide table may
        // straddle several columns. The header is looked for in the caption's
        // own column first. A table anchored on its header row starts at that
        // row, whatever columns its labels fall in.
        const ownColumn = band.filter((r) => r.column === title.run.column);
        const header =
            title.title === null
                ? findHeader(groupIntoRows(band))
                : (findHeader(groupIntoRows(ownColumn)) ?? findHeader(groupIntoRows(band)));
        if (header !== null) {
            const inTable = band.filter(inColumns(headerColumns(header, band)));
            const own = inTable.filter(withinHeaderSpan(header, inTable));
            tables.push(...readSubTables(own, title, Math.max(...header.runs.map((r) => r.size))));
        }
    }
    return tables;
}

/**
 * Fewest records a table with no caption lists: a line of field labels over a
 * single line of values is a statblock's panel, not a catalogue. A record has
 * a key and fills at least half the table's columns.
 */
const MIN_ANCHOR_RECORDS = 3;

function isRecord(row: TableRow, columns: number): boolean {
    const filled = row.cells.filter((c) => c.text.trim().length > 0);
    const key = filled.find((c) => c.colIndex === 0)?.text ?? "";
    // A `Label:` key is a statblock's field line, not a record's name.
    return key.length > 0 && !/^[^:]{1,20}:/u.test(key) && filled.length * 2 >= columns;
}

/**
 * Whether a table with no caption holds a catalogue: its headers name fields
 * (not a list of advances to purchase, read with its career), its rows are
 * records.
 */
function isAnchoredCatalogue(table: TitledTable): boolean {
    const roles = table.headers.map(headerRole).filter((r) => r !== null);
    const records = table.rows.filter((r) => isRecord(r, table.headers.length));
    return (
        new Set(roles).size >= MIN_ANCHOR_ROLES &&
        !isAdvanceList(roles) &&
        records.length >= MIN_ANCHOR_RECORDS
    );
}

export function detectTitledTables(ir: IR): TitledTable[] {
    const bands = marginBandsOf(ir);
    const captioned = readAtTitles(ir, findTableTitles(ir), bands);
    // Tables printed with no caption are anchored on their header rows.
    const covered = new Set(captioned.flatMap((t) => t.runs));
    const anchored = readAtTitles(ir, headerAnchors(ir, covered), bands).filter(isAnchoredCatalogue);
    return joinContinuations([...captioned, ...anchored]);
}

/** Type sizes past its header's last label that a table's own text may start. */
const HEADER_REACH_FACTOR = 2;
/** Type sizes of gap within which a run carries on the text before it on its line. */
const CARRY_ON_FACTOR = 1.5;

/**
 * A table spans no further across the page than its header: every cell sits
 * under a label. Text starting well past the last label belongs to the table
 * only as the run-on of a cell (following the text before it on its line at
 * word spacing); otherwise it is set beside the table (a neighbouring
 * column's prose sharing its baselines).
 */
function withinHeaderSpan(header: RawRow, band: readonly IRTextRun[]): (r: IRTextRun) => boolean {
    // Every label on the header's baseline, across all the columns it spans.
    const faces = new Set(header.runs.map((r) => `${r.font}|${r.weight}`));
    const labels = band.filter(
        (r) =>
            r.text.trim().length > 0 &&
            faces.has(`${r.font}|${r.weight}`) &&
            Math.abs(r.y - header.y) < Y_TOL,
    );
    const right = Math.max(...labels.map((r) => r.x + r.width));
    const size = Math.max(...labels.map((r) => r.size));
    const gapBefore = (r: IRTextRun): number => {
        const before = band.filter((o) => o !== r && Math.abs(o.y - r.y) < LINE_Y_TOL && o.x < r.x);
        return r.x - Math.max(...before.map((o) => o.x + o.width), Number.NEGATIVE_INFINITY);
    };
    // Text set to the right of the table's header, between it and the caption,
    // opens a column of running text beside the table: no cell sits above the
    // header, so whatever starts at that column's edge further down is that
    // text's too.
    const top = Math.max(...labels.map((r) => r.y));
    const besideStarts = band
        .filter((r) => r.y > top + LINE_Y_TOL && r.x > right && gapBefore(r) > CARRY_ON_FACTOR * r.size)
        .map((r) => r.x);
    const beside = Math.min(...besideStarts, Number.POSITIVE_INFINITY) - COLUMN_EDGE_TOLERANCE;
    return (r) => {
        if (r.x > right && r.x >= beside) {
            return false;
        }
        if (r.x <= right + HEADER_REACH_FACTOR * size) {
            return true;
        }
        return gapBefore(r) <= CARRY_ON_FACTOR * r.size;
    };
}

/** Most lines (a note, a section row) between a table's end and a sub-table's header. */
const MAX_SUBTABLE_LEAD = 3;

/**
 * A captioned table may run on as sub-tables, each opened by its own section
 * row and header with its own columns (a note line may end the one before).
 * Each is read in turn while a header row, set like the table's own
 * (`headerSize`, not display headings side by side), opens within a few lines
 * of the last one's end.
 */
function readSubTables(tableRuns: IRTextRun[], title: TitleHit, headerSize: number): TitledTable[] {
    const out: TitledTable[] = [];
    let runs = tableRuns;
    for (;;) {
        const table = readTable(runs, title);
        if (table === null) {
            break;
        }
        out.push(table);
        const end = Math.min(...table.runs.map((r) => r.y));
        const rest = runs.filter((r) => r.y < end - Y_TOL);
        const lines = groupIntoRows(rest);
        const opens = lines
            .slice(0, MAX_SUBTABLE_LEAD + 1)
            .some(
                (line, i) =>
                    isHeaderRow(line, cellEdges(lines.slice(i + 1))) &&
                    Math.max(...headerLabels(line).runs.map((r) => r.size)) <=
                        DISPLAY_SIZE_FACTOR * headerSize,
            );
        if (!opens) {
            break;
        }
        runs = rest;
    }
    return out;
}

/** A caption marking a table carried over from an earlier page: "… (Continued)". */
const CONTINUED = /\s*\((?:cont(?:inued|'d|\.)?)\)\s*$/iu;

/**
 * A continuation is the same table under its base caption. Its rows keep their
 * own page: each record's span is its row, wherever the table began.
 */
export function joinContinuations<T extends DetectedTable>(tables: readonly T[]): T[] {
    return tables.map((t) => {
        const title = t.tableTitle ?? "";
        const base = title.replace(CONTINUED, "");
        return base === title ? t : { ...t, tableTitle: base };
    });
}

/** A gap this many times the table's median line gap ends the table. */
const TABLE_END_GAP_FACTOR = 3;
/** A single run this long crossing column edges is running prose, not a cell. */
const PROSE_RUN_LENGTH = 40;
/** A run this many times the records' median size is a heading set below the table. */
const DISPLAY_SIZE_FACTOR = 1.15;
/**
 * Labels of one header differ in size by less than this ratio (a small-caps
 * label's initial is set a little larger); a run this much larger than another
 * on the line is a display heading sharing its baseline.
 */
const DISPLAY_HEADING_FACTOR = 1.5;

/** A line opening with a bold `Label:` — a field line of prose, not a table record. */
function opensWithLabel(line: RawRow): boolean {
    const first = [...line.runs].sort((a, b) => a.x - b.x).find((r) => r.text.trim().length > 0);
    return first?.weight === "bold" && /:\s*$/u.test(first.text);
}

/** A note marker leading a line: "†", "††", "*". */
const LEADING_NOTE_MARKER = /^[†‡*§¶]+/u;

/** A footnote line: led by a note marker, or set wholly in italics. */
function isNoteLine(line: RawRow): boolean {
    const visible = [...line.runs].sort((a, b) => a.x - b.x).filter((r) => r.text.trim().length > 0);
    const first = visible[0];
    return (
        first !== undefined && (LEADING_NOTE_MARKER.test(first.text.trim()) || visible.every((r) => r.italic))
    );
}

/** Cut the lines below a header where the table visibly ends. */
export function tableBody(lines: readonly RawRow[], colBoundaries: readonly number[]): RawRow[] {
    const gaps = lines.slice(1).map((l, i) => (lines[i]?.y ?? l.y) - l.y);
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0;
    const body: RawRow[] = [];
    for (const [i, line] of lines.entries()) {
        const recordSize = percentile(
            body.flatMap((l) => l.runs.map((r) => r.size)).sort((a, b) => a - b),
            0.5,
        );
        const displayed = body.length > 0 && line.runs.some((r) => r.size > DISPLAY_SIZE_FACTOR * recordSize);
        const isProse = (l: RawRow): boolean =>
            l.runs.some(
                (r) =>
                    r.text.trim().length > PROSE_RUN_LENGTH &&
                    colBoundaries.filter((b) => b > r.x + COLUMN_EDGE_TOLERANCE && b < r.x + r.width)
                        .length >= 2,
            );
        const proseRun = isProse(line);
        // A record's key is a name or value; a sentence break in it is prose.
        const key = line.runs
            .filter((r) => columnOfRun(r.x, colBoundaries) === 0)
            .map((r) => r.text)
            .join(" ");
        // A caption line below the header — the next table's, or prose citing
        // this one ("Table 2-1: … above lists …") — is no record.
        // So is a sentence break before a word whose small capitals lost
        // their case ("GLOW. remember").
        const proseKey =
            /\.\s+\p{Lu}/u.test(key) || /\p{Lu}{2,}\.\s+\p{Ll}{2,}/u.test(key) || isTableCaption(key);
        // A wide gap ends the table unless the line past it still fills
        // several columns (a gap between multi-line records).
        const gapBefore = i === 0 ? 0 : (gaps[i - 1] ?? 0);
        const wide = (gap: number): boolean => medianGap > 0 && gap > TABLE_END_GAP_FACTOR * medianGap;
        const columnsOf = (l: RawRow): number =>
            new Set(l.runs.map((r) => columnOfRun(r.x, colBoundaries))).size;
        // A section row set apart by a wide gap still belongs to the table
        // when records resume right after it (before the next wide gap).
        const never = (): boolean => false;
        const resumes = (isRecord: (l: RawRow) => boolean, stop: (l: RawRow) => boolean): boolean => {
            for (let j = i + 1; j < lines.length && !wide(gaps[j - 1] ?? 0); j++) {
                const next = lines[j];
                if (next === undefined || stop(next)) {
                    return false;
                }
                if (isRecord(next)) {
                    return true;
                }
            }
            return false;
        };
        const halfTheColumns = colBoundaries.length / 2;
        const setApart =
            wide(gapBefore) && columnsOf(line) < 2 && !resumes((l) => columnsOf(l) >= halfTheColumns, never);
        // A larger line is the table's own section row while records follow
        // it — two cells or more, not a line of prose or a `Label:` field
        // line — and otherwise a heading below the table.
        const record = (l: RawRow): boolean =>
            columnsOf(l) >= Math.max(MIN_COLUMNS, halfTheColumns) && !opensWithLabel(l);
        // In a table of few columns a line of prose fills as many cells as a
        // record does, so there a larger line set apart by a wide gap is a
        // heading whatever follows it. Records found only past a line of prose
        // below it belong to what the heading opens (the next table).
        const narrow = colBoundaries.length < 2 * MIN_COLUMNS;
        const heading = displayed && ((narrow && wide(gapBefore)) || !resumes(record, isProse));
        // A footnote set among the records (led by a note marker, or wholly
        // in italics) is no record, but the table goes on past it when
        // records resume below it.
        if (proseRun && isNoteLine(line) && resumes(record, never)) {
            continue;
        }
        if (proseRun || proseKey || setApart || heading) {
            break;
        }
        body.push(line);
    }
    return body;
}

/**
 * A table header row: bold and naming at least two columns (a stacked header
 * may put a single label on a line of its own above it).
 */
function isHeaderRow(row: RawRow, edges: readonly number[]): boolean {
    const labels = mergeAdjacentText(headerLabels(row).runs, edges);
    // `Label:` runs are field labels in prose, not column headings; nor is a
    // display heading set on another's baseline (sizes no header mixes).
    const sizes = headerLabels(row)
        .runs.filter((r) => r.text.trim().length > 0)
        .map((r) => r.size);
    return (
        labels.length >= MIN_COLUMNS &&
        !labels.some((l) => l.text.trim().endsWith(":")) &&
        Math.max(...sizes) < DISPLAY_HEADING_FACTOR * Math.min(...sizes)
    );
}

/**
 * A header line's labels: its bold runs. Prose from a neighbouring text column
 * can share the header's baseline; it is not a column label.
 */
function headerLabels(row: RawRow): RawRow {
    const bold = row.runs.filter((r) => r.weight === "bold");
    return { ...row, runs: bold.length > 0 ? bold : plainLabels(row.runs) };
}

/** Share of a plain-set line's labels that must name schema fields for it to be a header. */
const PLAIN_HEADER_ROLE_SHARE = 0.75;

/**
 * A header set in the body weight, not bold: a line in one face, of at least
 * MIN_ANCHOR_ROLES labels, nearly all naming schema fields ("Name", "Class",
 * "Range", "RoF", "Dmg", "Pen", …) — a record's values never do. Otherwise
 * none.
 */
function plainLabels(runs: readonly IRTextRun[]): IRTextRun[] {
    const labels = runs.filter((r) => r.text.trim().length > 0);
    const faces = new Set(labels.map((r) => `${r.font}|${r.weight}|${r.size}`));
    const named = labels.filter((r) => headerRole(r.text) !== null || mergedHeaderRoles(r.text) !== null);
    return faces.size === 1 &&
        named.length >= MIN_ANCHOR_ROLES &&
        named.length >= PLAIN_HEADER_ROLE_SHARE * labels.length
        ? runs.filter((r) => labels.includes(r) || r.text.trim().length === 0)
        : [];
}

/**
 * The table's header: the first header row — or, when a fuller header row
 * follows it directly, that one, as a stacked header prints some labels' first
 * words on a line above the rest ("LOCATIONS" over "COVERED"). Each upper label
 * is then prefixed to the column label it sits over. Labels are read against
 * the cell edges of the lines below. Returns the header's line index and its
 * labels.
 */
export function stackedHeader(lines: readonly RawRow[]): { index: number; row: RawRow } | null {
    const index = lines.findIndex((line, i) => isHeaderRow(line, cellEdges(lines.slice(i + 1))));
    const first = lines[index];
    if (first === undefined) {
        return null;
    }
    const edges = cellEdges(lines.slice(index + 1));
    const upper = withLabelsAbove(headerLabels(first), lines[index - 1]);
    const next = lines[index + 1];
    const wrapped = next === undefined ? null : wrappedLabels(upper, next, lines.slice(index + 2));
    if (wrapped !== null) {
        return { index: index + 1, row: wrapped };
    }
    if (next === undefined || !isHeaderRow(next, edges)) {
        return { index, row: upper };
    }
    const lower = headerLabels(next);
    const lowerLabels = mergeAdjacentText(lower.runs, edges);
    if (lowerLabels.length <= mergeAdjacentText(upper.runs, edges).length) {
        return { index, row: upper };
    }
    const runs = lower.runs.map((r) => ({ ...r }));
    for (const label of mergeAdjacentText(upper.runs, edges)) {
        const under = lowerLabels.find((l) => label.x < l.x + l.width && l.x < label.x + label.width);
        const lead =
            under === undefined
                ? undefined
                : runs
                      .filter((r) => r.x >= under.x - COLUMN_EDGE_TOLERANCE && r.x < under.x + under.width)
                      .sort((a, b) => a.x - b.x)[0];
        if (lead !== undefined) {
            lead.text = `${label.text} ${lead.text}`;
        }
    }
    return { index: index + 1, row: { ...lower, runs } };
}

/** Most header sizes a wrapped label's second line sits below its first: ordinary leading. */
const LABEL_WRAP_FACTOR = 1.5;

/**
 * A header whose fewer labels print their first words on a line of their own
 * above it ("Weight per" over "location"): the line directly above, at
 * ordinary leading, all bold, each run set over a label other than the first
 * (a section row above a header starts where its first label does) — each is
 * prefixed to the label it sits over. Returns the header, completed or as it was.
 */
function withLabelsAbove(header: RawRow, above: RawRow | undefined): RawRow {
    const visible = (runs: readonly IRTextRun[]): IRTextRun[] => runs.filter((r) => r.text.trim().length > 0);
    const labels = visible(header.runs).sort((a, b) => a.x - b.x);
    const runs = visible(above?.runs ?? []);
    const size = Math.max(...labels.map((r) => r.size));
    if (
        above === undefined ||
        runs.length === 0 ||
        runs.length >= labels.length ||
        !runs.every((r) => r.weight === "bold") ||
        above.y - header.y > LABEL_WRAP_FACTOR * size
    ) {
        return header;
    }
    const under = runs.map((r) =>
        labels.findIndex(
            (l) =>
                Math.abs(l.x - r.x) <= COLUMN_EDGE_TOLERANCE || (r.x < l.x + l.width && l.x < r.x + r.width),
        ),
    );
    if (under.some((i) => i < 1) || new Set(under).size !== under.length) {
        return header;
    }
    const prefixes = new Map(under.map((i, k) => [labels[i], runs[k]?.text.trim() ?? ""] as const));
    return {
        ...header,
        runs: header.runs.map((r) => {
            const prefix = prefixes.get(r);
            return prefix === undefined ? r : { ...r, text: `${prefix} ${r.text.trim()}` };
        }),
    };
}

/**
 * A header whose labels wrap onto a second line ("ROLL" over "(D100)"): the
 * line directly below, at ordinary leading, all bold, each run under a label
 * and fewer than the header's, completes those labels. A section row may sit
 * as close, but its like recurs further down the table (`rest`): a line of
 * bold runs starting where it starts. Returns the completed header, or null.
 */
function wrappedLabels(header: RawRow, below: RawRow, rest: readonly RawRow[]): RawRow | null {
    const runs = below.runs.filter((r) => r.text.trim().length > 0);
    const size = Math.max(...header.runs.map((r) => r.size));
    const labels = header.runs.filter((r) => r.text.trim().length > 0);
    const over = (r: IRTextRun): IRTextRun | undefined =>
        labels.find((l) => r.x < l.x + l.width && l.x < r.x + r.width);
    const visible = (line: RawRow): IRTextRun[] => line.runs.filter((r) => r.text.trim().length > 0);
    const recurs = rest.some((line) => {
        const own = visible(line);
        return (
            own.length === runs.length &&
            own.every((r) => r.weight === "bold") &&
            Math.abs((own[0]?.x ?? 0) - (runs[0]?.x ?? 0)) <= COLUMN_EDGE_TOLERANCE
        );
    });
    if (
        runs.length === 0 ||
        runs.length >= labels.length ||
        recurs ||
        header.y - below.y > LABEL_WRAP_FACTOR * size ||
        !runs.every((r) => r.weight === "bold" && over(r) !== undefined)
    ) {
        return null;
    }
    const completed = header.runs.map((r) => ({ ...r }));
    for (const r of runs) {
        const label = completed.find((l) => l.x === over(r)?.x && l.text === over(r)?.text);
        if (label !== undefined) {
            label.text = `${label.text} ${r.text}`;
        }
    }
    return { ...header, runs: completed };
}

function findHeader(lines: readonly RawRow[]): RawRow | null {
    return stackedHeader(lines)?.row ?? null;
}

/**
 * The text columns a table occupies: those holding its header labels, and any
 * between them (a column of values under a label set as one run with its
 * neighbour's, "Clip Rld"). A wide table's header continues across a gutter
 * on the same baseline in the same header face; a neighbouring column's prose
 * on that baseline does not share the face, so it is left out.
 */
function headerColumns(header: RawRow, band: readonly IRTextRun[]): Set<number> {
    const faces = new Set(header.runs.map((r) => `${r.font}|${r.weight}`));
    const columns = new Set(header.runs.map((r) => r.column));
    for (const r of band) {
        // A bold `Label:` beside the header is a field line's label, not a column's.
        if (
            Math.abs(r.y - header.y) < Y_TOL &&
            faces.has(`${r.font}|${r.weight}`) &&
            !r.text.trim().endsWith(":")
        ) {
            columns.add(r.column);
        }
    }
    const lowest = Math.min(...columns);
    const highest = Math.max(...columns);
    for (const r of band) {
        if (r.column > lowest && r.column < highest) {
            columns.add(r.column);
        }
    }
    // A header set inside one text column may head rows set across the page:
    // a column whose lines below the header start cells under several of its
    // labels holds the table's body.
    const body = new Set<number>();
    const labelEdges = header.runs.filter((r) => r.text.trim().length > 0).map((r) => r.x);
    for (const column of new Set(band.map((r) => r.column))) {
        const lines = groupIntoRows(band.filter((r) => r.column === column && r.y < header.y - Y_TOL));
        const under = cellEdges(lines).filter((x) =>
            labelEdges.some((edge) => Math.abs(edge - x) <= COLUMN_EDGE_TOLERANCE),
        );
        if (under.length >= MIN_COLUMNS) {
            body.add(column);
        }
    }
    return new Set([...columns, ...body]);
}

/**
 * A table set between columns of running text (an inset with prose to its
 * left) holds nothing that starts left of both its caption and its header and
 * ends before its first column starts: those runs are the text beside it. A
 * key centred under the first label reaches under it; a cell left of a centred
 * label starts where the caption does. Every line keeps only the table's own
 * runs; a body line left with none is dropped.
 */
function besideText(
    rows: readonly RawRow[],
    headerIdx: number,
    header: RawRow,
    caption: IRTextRun,
): RawRow[] {
    const labels = header.runs.filter((r) => r.text.trim().length > 0);
    const start = Math.min(...labels.map((r) => r.x)) - COLUMN_EDGE_TOLERANCE;
    const left = Math.min(start, caption.x - COLUMN_EDGE_TOLERANCE);
    const beside = (r: IRTextRun): boolean => r.x < left && r.x + r.width <= start;
    const own = (row: RawRow): RawRow => ({ ...row, runs: row.runs.filter((r) => !beside(r)) });
    // Lines down to the header keep their places (the header is found by index).
    return rows.map(own).filter((row, i) => i <= headerIdx || row.runs.some((r) => r.text.trim().length > 0));
}

function inColumns(columns: ReadonlySet<number>): (r: IRTextRun) => boolean {
    return (r) => columns.has(r.column);
}

/** Read one captioned table from `tableRuns`, or null when they hold no table. */
function readTable(tableRuns: IRTextRun[], title: TitleHit): TitledTable | null {
    if (tableRuns.length < 10) {
        return null;
    }
    const rows = groupIntoRows(tableRuns);
    if (rows.length < 2) {
        return null;
    }
    // The header is the first bold row that names at least two columns (a
    // stacked header may put a single label on a line of its own above it).
    const header = stackedHeader(rows);
    if (header === null) {
        return null;
    }
    const { index: headerIdx } = header;
    const lines = besideText(rows, headerIdx, header.row, title.run);
    const edges = cellEdges(lines.slice(headerIdx + 1));
    const headerRow = { ...header.row, runs: splitHeaderRuns(header.row.runs, edges) };
    const colBoundaries = inferColumnBoundaries(headerRow, edges);
    if (colBoundaries.length < MIN_COLUMNS) {
        return null;
    }

    const headerCells = assignToColumns(headerRow.runs, colBoundaries);
    const headers = headerCells.map((c) => c.text.replace(/\s+/g, " ").trim());
    const read = tableBody(lines.slice(headerIdx + 1), inferColumnBoundaries(headerRow, edges));
    // A header naming another set of columns opens the next sub-table; a
    // repeat of this table's own header carries on.
    const otherHeader = read.findIndex((line, i) => {
        const labels = mergeAdjacentText(headerLabels(line).runs, cellEdges(read.slice(i + 1)));
        // A section row ("Chain Weapons") names at most one field; a header names several.
        const fields = new Set(labels.map((l) => headerRole(l.text)).filter((r) => r !== null));
        return (
            isHeaderRow(line, cellEdges(read.slice(i + 1))) &&
            labels.length !== headers.length &&
            fields.size >= MIN_COLUMNS
        );
    });
    const body = otherHeader < 0 ? read : read.slice(0, otherHeader);
    alignBoundariesToData(colBoundaries, body);

    // A table printed as side-by-side copies of one column set (its header
    // repeats) holds a record per copy on each line: each copy is read as its
    // own table, left copy first.
    const period = headerPeriod(headers);
    const dataRows: TableRow[] = [];
    for (let start = 0; start < headers.length; start += period) {
        const bounds = colBoundaries.slice(start, start + period);
        const next = colBoundaries[start + period];
        // The first copy has no neighbour to its left: a key centred under its
        // label may start left of the label.
        const inCopy = (r: IRTextRun): boolean =>
            (start === 0 || r.x >= (bounds[0] ?? 0) - COLUMN_EDGE_TOLERANCE) &&
            (next === undefined || r.x < next - COLUMN_EDGE_TOLERANCE);
        const copy = body
            .map((line) => ({
                ...line,
                runs: splitAtColumns(
                    line.runs.map((r) => centredInColumn(r, colBoundaries)),
                    colBoundaries,
                ).filter(inCopy),
            }))
            .filter((line) => line.runs.length > 0);
        dataRows.push(...withRepeatedHeaders(readRows(copy, bounds), headers.slice(start, start + period)));
    }

    // A section row set above the header names the first part's section.
    const lead = leadSection(lines, headerRow);
    const sectioned =
        lead === null || dataRows.length === 0 || dataRows[0]?.isSectionHeader === true
            ? dataRows
            : [{ cells: [], isHeaderRow: false, isSectionHeader: true, sectionName: lead }, ...dataRows];

    return dataRows.length > 0
        ? {
              pageIndex: title.pageIndex,
              headers: headers.slice(0, period),
              rows: sectioned,
              tableTitle: title.title,
              runs: [...lines.slice(0, headerIdx + 1), ...body].flatMap((l) => l.runs),
          }
        : null;
}

/** Most header sizes a section row set above the header sits above it: ordinary leading. */
const LEAD_SECTION_FACTOR = 1.8;

/**
 * A section row set directly above a table's header, between it and the
 * caption ("Las Weapons" over "Name Class Range …"): one bold run of words
 * naming no column, starting where the header's first label starts. Its
 * text, or null.
 */
export function leadSection(lines: readonly RawRow[], header: RawRow): string | null {
    const start = lines.findIndex((line, i) => isHeaderRow(line, cellEdges(lines.slice(i + 1))));
    const above = lines[start - 1];
    const runs = above?.runs.filter((r) => r.text.trim().length > 0) ?? [];
    const firstLabel = header.runs
        .filter((r) => r.text.trim().length > 0)
        .reduce<IRTextRun | null>((a, r) => (a === null || r.x < a.x ? r : a), null);
    const text = runs
        .map((r) => r.text)
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
    const size = Math.max(...header.runs.map((r) => r.size));
    return above === undefined ||
        firstLabel === null ||
        runs.length === 0 ||
        !runs.every((r) => r.weight === "bold") ||
        !/^\p{L}[\p{L}\s'’-]*$/u.test(text) ||
        headerRole(text) !== null ||
        Math.abs(Math.min(...runs.map((r) => r.x)) - firstLabel.x) > COLUMN_EDGE_TOLERANCE ||
        above.y - header.y > LEAD_SECTION_FACTOR * size
        ? null
        : text;
}

/**
 * A row repeating the table's header labels, column for column, is the header
 * printed again over the next part of the table, not a record. Words set
 * before the first label in its first cell ("Carapace Armour Name" over
 * "Name") are that part's section row.
 */
export function withRepeatedHeaders(rows: readonly TableRow[], headers: readonly string[]): TableRow[] {
    const labels = headers.map(normalizeHeader);
    const first = labels[0] ?? "";
    return rows.flatMap((row): TableRow[] => {
        if (row.isHeaderRow || row.isSectionHeader || labels.length < MIN_COLUMNS || first === "") {
            return [row];
        }
        const text = (col: number): string => row.cells.find((c) => c.colIndex === col)?.text ?? "";
        const repeats = labels.every((label, col) => col === 0 || normalizeHeader(text(col)) === label);
        const key = normalizeHeader(text(0));
        if (!repeats || !(key === first || key.endsWith(` ${first}`))) {
            return [row];
        }
        const header: TableRow = { ...row, isHeaderRow: true };
        const words = text(0).trim().split(/\s+/u);
        const section = words.slice(0, words.length - first.split(" ").length).join(" ");
        return key === first
            ? [header]
            : [{ cells: [], isHeaderRow: false, isSectionHeader: true, sectionName: section }, header];
    });
}

/**
 * The width of the column set a header row repeats ("NAME EFFECT NAME EFFECT"
 * → 2), or the full width when it does not repeat.
 */
export function headerPeriod(headers: readonly string[]): number {
    const keys = headers.map(normalizeHeader);
    for (let p = MIN_COLUMNS; p < keys.length; p += 1) {
        if (keys.length % p === 0 && keys.every((k, i) => k === keys[i % p])) {
            return p;
        }
    }
    return keys.length;
}

/**
 * Printed lines below a header → rows: lines gather around their row key, then
 * wrapped lines rejoin their row (tight spacing AND fewer filled columns than
 * a typical row).
 */
/** Fewest cells a table's typical record fills for a key standing alone to name a section. */
const KEYED_SECTION_FILL = 3;

function readRows(body: readonly RawRow[], colBoundaries: number[]): TableRow[] {
    const lineCells = (row: RawRow): string[] =>
        colBoundaries.map((_, col) =>
            row.runs
                .filter((r) => columnOfRun(r.x, colBoundaries) === col)
                .sort((a, b) => b.y - a.y || a.x - b.x)
                .map((r) => r.text)
                .join(" ")
                .trim(),
        );
    const rows = mergeContinuationRows(groupByKeyAnchors(body, colBoundaries), { cells: lineCells });
    const fills = rows.map((row) => lineCells(row).filter((c) => c.length > 0).length);
    const recordFill = percentile(
        fills.filter((f) => f > 1).sort((a, b) => a - b),
        0.5,
    );
    const dataRows: TableRow[] = [];
    for (const [i, row] of rows.entries()) {
        const cells = assignToColumns(row.runs, colBoundaries);
        const allBold = row.runs.every((r) => r.weight === "bold");
        const fewCells = cells.filter((c) => c.text.length > 0).length <= 2;
        // A label centred across the columns may touch several of them; with
        // no key it still names a section, not a record.
        const keyless = !cells.some((c) => c.colIndex === 0 && c.text.length > 0);
        // A key standing alone over records that fill several cells, no
        // wrapped name's piece (merging joined those), names their section
        // in the records' own face.
        const keyAlone =
            fills[i] === 1 && !keyless && recordFill >= KEYED_SECTION_FILL && (fills[i + 1] ?? 0) > 1;
        if ((allBold && (fewCells || keyless)) || keyAlone) {
            const sectionText = row.runs
                .map((r) => r.text)
                .join(" ")
                .trim();
            dataRows.push({
                cells: [],
                isHeaderRow: false,
                isSectionHeader: true,
                sectionName: sectionText,
            });
        } else {
            dataRows.push({
                cells,
                isHeaderRow: false,
                isSectionHeader: false,
                sectionName: null,
            });
        }
    }
    return dataRows;
}
