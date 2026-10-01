// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";
import { groupByBaseline } from "../util/baselines.ts";
import { bodyStyle } from "../util/body-style.ts";
import { numAsc } from "../util/ordered.ts";
import { inMarginBand, inSideMargin, marginBandsOf } from "../util/page-bands.ts";
import { percentile } from "../util/stats.ts";
import { wordBreakBetween, wordSpace } from "../util/text.ts";
import { isTableCaption } from "./detect-titled-tables.ts";
import { FUNCTION_WORDS, NUMBERED_LABEL, readsAsProse, scrambledCase } from "./names.ts";

/**
 * Catalogue entries (talents, traits, powers, conditions, …) found by
 * typography alone:
 *
 *  - The BODY style is the (font, size) carrying the most characters.
 *  - A HEADING is a short line set entirely in one non-body style at least as
 *    large as body text. Its size ranks it in the heading hierarchy, so every
 *    entry knows the chain of section headings enclosing it.
 *  - A FIELD line opens with a bold `Label:`; its value runs to the end of the
 *    line and continues onto following lines only while the text wraps (the
 *    line reaches the column's right edge).
 *  - Everything else under a heading, up to the next heading of the same or a
 *    higher level, is the entry's body prose.
 */

/** Runs within this many points of a line's baseline belong to that line. */
const BASELINE_TOLERANCE = 2.5;
/** A heading line is at most this many characters. */
const MAX_HEADING_LENGTH = 60;
/** A rank closing a name of at least two words: "Wick Mastery 2". */
const RANK_SUFFIX = /(?<=\p{L}+\s+\p{L}+)\s+\d{1,2}$/u;
/** A line ending within this many points of its column's right edge wrapped. */
const WRAP_SLACK = 12;
// A stray run (an unstripped page number, a marginal mark) can end past the
// text measure, so the edge is where most full lines end, not the furthest.
/** A column's right edge: the right end reached by this fraction of its lines. */
const EDGE_PERCENTILE = 0.9;
/** Size step (points) that separates two heading levels. */
const LEVEL_STEP = 0.4;
/** A gap inside a line wider than this many font-sizes separates table columns, not words. */
// A display face's word space can run past one font-size (≈1.25×); table
// header labels sit further apart (≈1.4× and up).
const HEADING_MAX_GAP_FACTOR = 1.3;
/**
 * A gap inside a non-bold heading wider than this many font-sizes parts two
 * pieces of text; a letter-spaced display heading spaces far tighter.
 */
const DISPLAY_MAX_GAP_FACTOR = 2.5;
/** A heading line within this many heading-sizes below another continues it. */
const HEADING_WRAP_FACTOR = 1.6;
/** A gap above a body line wider than this many font-sizes opens a paragraph. */
const PARAGRAPH_GAP_FACTOR = 1.5;
/** Paragraph separator inside an entry body (what `toHtml` splits on). */
export const PARAGRAPH_BREAK = "\n\n";

export interface TextLine {
    pageIndex: number;
    column: number;
    y: number;
    runs: IRTextRun[];
    text: string;
    right: number;
}

export interface Heading {
    text: string;
    size: number;
    style: string;
    pageIndex: number;
}

export interface Entry {
    heading: Heading;
    /** Enclosing section headings, outermost first. */
    sections: string[];
    /** `Label: value` fields in printed order (label without the colon). */
    fields: [string, string][];
    body: string;
}

function joinRuns(runs: readonly IRTextRun[]): string {
    let text = "";
    let prevEnd = Number.NEGATIVE_INFINITY;
    let prevSize = 0;
    for (const r of runs) {
        if (r.text.length === 0) {
            continue;
        }
        // Adjacent runs without a gap continue one word.
        const gap = r.x - prevEnd;
        text +=
            text.length > 0 && wordBreakBetween(text, r.text, gap, wordSpace(prevSize, r.size))
                ? ` ${r.text}`
                : r.text;
        prevEnd = r.x + r.width;
        prevSize = r.size;
    }
    return text.replace(/\s+/gu, " ").trim();
}

export function buildLines(ir: IR): TextLine[] {
    const byColumn = new Map<string, IRTextRun[]>();
    for (const r of ir.runs) {
        const key = `${r.pageIndex}:${r.column}`;
        byColumn.set(key, [...(byColumn.get(key) ?? []), r]);
    }
    const out: TextLine[] = [];
    for (const columnRuns of byColumn.values()) {
        for (const group of groupByBaseline(columnRuns, BASELINE_TOLERANCE, true)) {
            const runs = [...group.runs].sort((a, b) => numAsc(a.x, b.x));
            const text = joinRuns(runs);
            const [first] = runs;
            if (text.length === 0 || first === undefined) {
                continue;
            }
            out.push({
                pageIndex: first.pageIndex,
                column: first.column,
                y: first.y,
                runs,
                text,
                right: Math.max(...runs.map((r) => r.x + r.width)),
            });
        }
    }
    return out.sort(
        (a, b) => numAsc(a.pageIndex, b.pageIndex) || numAsc(a.column, b.column) || numAsc(b.y, a.y),
    );
}

function visibleRuns(line: TextLine): IRTextRun[] {
    return line.runs.filter((r) => r.text.trim().length > 0);
}

/** Font + weight: a heading may set single glyphs larger (initials, markers) and stay one style. */
const faceOf = (r: IRTextRun): string => `${r.font}|${r.weight}`;

/** A small-size capitals heading is at most this many characters. */
const MAX_CAPS_HEADING_LENGTH = 40;
/** A word followed by a colon: a field label. */
const LABEL_COLON = /\p{L}\s*:/u;

/**
 * A short line of capitals in a face that sets headings elsewhere in the
 * document is a heading at any point size: a small-caps face prints its
 * capitals at a smaller nominal size than body text. A labelled value set in
 * the same capitals ("CREW: DRIVER") is a field, not a heading.
 */
function capsHeading(line: TextLine, face: string, headingFaces: ReadonlySet<string>): boolean {
    return (
        headingFaces.has(face) &&
        line.text.length <= MAX_CAPS_HEADING_LENGTH &&
        !LABEL_COLON.test(line.text) &&
        (!TITLE_CASED_WORD.test(line.text) || capitalsCaseLost(line.text))
    );
}

/** A word set wholly in capitals. */
const CAPITALS_WORD = /(?<!\p{L})\p{Lu}{2,}(?!\p{L})/u;

/**
 * Small capitals whose case the text layer lost only partly: case scrambled
 * inside a word ("sOul Ward"), a word in title case beside one wholly in
 * capitals ("Warp AWARENESS"), or a lower-case start before a capitalised
 * word ("sacred incense Burner").
 */
function capitalsCaseLost(text: string): boolean {
    return (
        scrambledCase(text) ||
        (TITLE_CASED_WORD.test(text) && CAPITALS_WORD.test(text)) ||
        (/^\P{L}*\p{Ll}/u.test(text) && /\p{Lu}/u.test(text))
    );
}

/** Most characters of a display-size line read as a heading whatever its case. */
const MAX_SHORT_DISPLAY_LENGTH = 25;

/**
 * A short line set larger than body text is a heading even when its case was
 * lost ("new role: ace"): running prose is set at body size.
 */
function shortDisplay(text: string, size: number, bodySize: number): boolean {
    return size > bodySize + LEVEL_STEP && text.length <= MAX_SHORT_DISPLAY_LENGTH;
}

/**
 * A word in ordinary title case ("Starting") marks mixed-case text. A
 * small-caps line whose case the text layer lost ("STARTING skills",
 * "background bonus") has none, and is still a capitals heading.
 */
const TITLE_CASED_WORD = /(?<!\p{L})\p{Lu}\p{Ll}+(?!\p{L})/u;

export function headingOf(
    line: TextLine,
    body: { style: string; size: number },
    inMargin: boolean,
    headingFaces: ReadonlySet<string> = new Set(),
): Heading | null {
    const runs = visibleRuns(line);
    if (runs.length === 0 || line.text.length < 2 || line.text.length > MAX_HEADING_LENGTH) {
        return null;
    }
    // Margin bands hold running heads, feet and folios — never a heading; and a
    // table caption heads its table, not a section of the text.
    if (inMargin || isTableCaption(line.text)) {
        return null;
    }
    const [first] = runs;
    // One face throughout, though a name within may be set in italics
    // ("Captain Vane's Lantern").
    const roman = runs.filter((r) => !r.italic);
    if (first === undefined || new Set((roman.length > 0 ? roman : runs).map(faceOf)).size !== 1) {
        return null;
    }
    const face = faceOf(first);
    // The heading's level is set by the size carrying most of its characters.
    const chars = new Map<number, number>();
    for (const r of runs) {
        chars.set(r.size, (chars.get(r.size) ?? 0) + r.text.trim().length);
    }
    const [[size] = [first.size]] = [...chars.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const style = `${first.font}|${size}|${first.weight}`;
    if (style === body.style || (size < body.size - LEVEL_STEP && !capsHeading(line, face, headingFaces))) {
        return null;
    }
    // A line set wholly in italics at body size is a quotation or emphasis, not a heading.
    if (runs.every((r) => r.italic) && size <= body.size + LEVEL_STEP) {
        return null;
    }
    // A field label or a sentence is not a heading, and a line carrying a value
    // outside parentheses — a word starting with a digit or sign ("12", "+10",
    // "2kg", "01-15") — is a table row, not a name. A name may end in its rank
    // ("Wick Mastery 2") or follow a numbered label ("Rank 2: Glow").
    const outsideParens = line.text
        .replace(/\([^)]*\)/gu, " ")
        .trim()
        .replace(RANK_SUFFIX, "")
        .replace(NUMBERED_LABEL, "");
    // A heading is title-like and contiguous (labels spread across columns are
    // a table row). A mixed-case line breaking off on a comma or connecting
    // word is running text; a display heading in capitals may wrap there.
    // A display-size line with no capitals at all, in a face that sets headings
    // elsewhere, is small capitals whose case the text layer lost
    // ("tempest-class strike frigate"), not running prose.
    const caseLostDisplay =
        !/\p{Lu}/u.test(line.text) && headingFaces.has(face) && size > body.size + LEVEL_STEP;
    const lastWord = line.text.trim().split(/\s+/u).at(-1)?.toLowerCase() ?? "";
    const brokenOff = /,$/u.test(line.text.trim()) || FUNCTION_WORDS.has(lastWord);
    // Table header labels (bold) sit spread across columns; a display heading
    // may be letter-spaced wide, so only a bold line is read as spread labels.
    // A gap holding a space glyph is a word space however wide it measures (a
    // text layer can under-report a word's width); cells carry no space between.
    const spaceIn = (from: number, to: number): boolean =>
        line.runs.some((s) => s.text.trim().length === 0 && s.x >= from && s.x < to);
    // Any line gapped wider than letter-spacing ever sets is two pieces of
    // text sharing a baseline (a title block beside another column's heading).
    const gapFactor = first.weight === "bold" ? HEADING_MAX_GAP_FACTOR : DISPLAY_MAX_GAP_FACTOR;
    const spread = runs.some((r, i) => {
        const next = runs[i + 1];
        return (
            next !== undefined &&
            next.x - (r.x + r.width) > gapFactor * size &&
            !spaceIn(r.x + r.width, next.x)
        );
    });
    if (
        /[:.]$/u.test(line.text) ||
        !/\p{L}/u.test(line.text) ||
        /(^|[\s:])[+-]?\d/u.test(outsideParens) ||
        (readsAsProse(line.text) &&
            !scrambledCase(line.text) &&
            !shortDisplay(line.text, size, body.size) &&
            !caseLostDisplay) ||
        // (A line with no capitals at all is display type whose case was lost.)
        (brokenOff && /\p{Ll}/u.test(line.text) && /\p{Lu}/u.test(line.text)) ||
        spread
    ) {
        return null;
    }
    return { text: line.text, size, style, pageIndex: line.pageIndex };
}

/** A line printed at the same place on at least this many pages is running page furniture. */
const FURNITURE_PAGES = 3;
/** Vertical bucket (points) within which repeated lines count as the same place. */
const FURNITURE_Y_BUCKET = 6;

/**
 * Drop running heads and feet — the same text at the same height in a margin
 * band on many pages. They belong to no entry and would otherwise read as
 * headings. (Body lines can repeat by coincidence; the margin band tells them
 * apart.)
 */
export function withoutRunningFurniture(
    lines: readonly TextLine[],
    marginal: (line: TextLine) => boolean,
): TextLine[] {
    const place = (l: TextLine): string => `${l.text}\u0000${Math.round(l.y / FURNITURE_Y_BUCKET)}`;
    const pages = new Map<string, Set<number>>();
    for (const l of lines.filter(marginal)) {
        const key = place(l);
        pages.set(key, (pages.get(key) ?? new Set()).add(l.pageIndex));
    }
    return lines.filter((l) => !marginal(l) || (pages.get(place(l))?.size ?? 0) < FURNITURE_PAGES);
}

/** Points within which a line starts "at" an x position (a column edge, a shared inset). */
const EDGE_TOLERANCE = 4;
/** Fewest lines on a column edge for the edge to be trusted. */
const MIN_EDGE_LINES = 3;
/** Fewest consecutive off-edge lines that make a figure. */
const FIGURE_MIN_LINES = 4;
/**
 * Points a figure's labels typically jump sideways from line to line; text
 * wrapped around an illustration drifts by less.
 */
const FIGURE_MIN_JUMP = 12;
/** Fewest type styles a figure mixes (title, labels, captions, values); prose keeps to one or two. */
const FIGURE_MIN_STYLES = 4;
/** Most share of a figure's line steps at one spacing; set text steps evenly. */
const FIGURE_MAX_REGULAR_SHARE = 0.55;
/** Points two line steps may differ by and still be the same spacing. */
const STEP_TOLERANCE = 1;

const lineStart = (l: TextLine): number => l.runs[0]?.x ?? 0;
const lineCentre = (l: TextLine): number => (lineStart(l) + l.right) / 2;

/** The position most lines of a group share (within `EDGE_TOLERANCE`), with how many do. */
function modalPosition(
    lines: readonly TextLine[],
    at: (l: TextLine) => number,
): { x: number; count: number } {
    const bins = new Map<number, number>();
    for (const l of lines) {
        const bin = Math.round(at(l));
        bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    let best = { x: 0, count: 0 };
    for (const bin of [...bins.keys()].sort((a, b) => a - b)) {
        let count = 0;
        for (let d = -EDGE_TOLERANCE; d <= EDGE_TOLERANCE; d++) {
            count += bins.get(bin + d) ?? 0;
        }
        if (count > best.count) {
            best = { x: bin, count };
        }
    }
    return best;
}

/** Median shift of the left edge between consecutive lines of a run. */
function medianStartJump(run: readonly TextLine[]): number {
    const jumps = run
        .slice(1)
        .map((l, i) => Math.abs(lineStart(l) - lineStart(run[i] ?? l)))
        .sort((a, b) => a - b);
    return jumps[Math.floor(jumps.length / 2)] ?? 0;
}

/** Share of a run's line steps at its most common spacing. */
function regularStepShare(run: readonly TextLine[]): number {
    const steps = run.slice(1).map((l, i) => (run[i]?.y ?? l.y) - l.y);
    if (steps.length === 0) {
        return 1;
    }
    const most = Math.max(...steps.map((s) => steps.filter((o) => Math.abs(o - s) <= STEP_TOLERANCE).length));
    return most / steps.length;
}

/** How many type styles a run's lines are set in (each line by its longest run). */
function styleCount(run: readonly TextLine[]): number {
    const styleOf = (l: TextLine): string => {
        const longest = [...l.runs].sort((a, b) => b.text.length - a.text.length)[0];
        return longest === undefined ? "" : `${longest.font}|${longest.size}`;
    };
    return new Set(run.map(styleOf)).size;
}

/**
 * Drop figures set in the text column — diagrams whose labels are placed
 * freely: a run of consecutive lines none of which starts at the column's
 * text edge, mixing several type styles at uneven spacing, whose left edges
 * jump about from line to line (text wrapped round an illustration drifts),
 * and most of which share neither a left edge (an inset sidebar does) nor a
 * centre (centred text does). They belong to no entry, and their labels would
 * read as headings that split the entry around them.
 */
export function withoutFigures(lines: readonly TextLine[]): TextLine[] {
    // A column's text edge is measured across the document for facing pages
    // alike (left and right pages mirror their margins): one page's column
    // can be mostly figure, or mis-split.
    const facing = (l: TextLine): string => `${l.pageIndex % 2}:${l.column}`;
    const byFacing = new Map<string, TextLine[]>();
    const byColumn = new Map<string, TextLine[]>();
    for (const l of lines) {
        byFacing.set(facing(l), [...(byFacing.get(facing(l)) ?? []), l]);
        const key = `${l.pageIndex}:${l.column}`;
        byColumn.set(key, [...(byColumn.get(key) ?? []), l]);
    }
    const edges = new Map(
        [...byFacing].map(([key, group]) => [key, modalPosition(group, lineStart)] as const),
    );
    const dropped = new Set<TextLine>();
    for (const column of byColumn.values()) {
        const [first] = column;
        const edge = first === undefined ? undefined : edges.get(facing(first));
        if (edge === undefined || edge.count < MIN_EDGE_LINES) {
            continue;
        }
        const offEdge = (l: TextLine): boolean => Math.abs(lineStart(l) - edge.x) > EDGE_TOLERANCE;
        const aligned = (group: readonly TextLine[], at: (l: TextLine) => number): boolean =>
            modalPosition(group, at).count * 2 >= group.length;
        let run: TextLine[] = [];
        const flush = (): void => {
            if (
                run.length >= FIGURE_MIN_LINES &&
                styleCount(run) >= FIGURE_MIN_STYLES &&
                medianStartJump(run) >= FIGURE_MIN_JUMP &&
                regularStepShare(run) < FIGURE_MAX_REGULAR_SHARE &&
                !aligned(run, lineStart) &&
                !aligned(run, lineCentre)
            ) {
                for (const l of run) {
                    dropped.add(l);
                }
            }
            run = [];
        };
        for (const l of column) {
            if (offEdge(l)) {
                run.push(l);
            } else {
                flush();
            }
        }
        flush();
    }
    return lines.filter((l) => !dropped.has(l));
}

/**
 * Every line of a table caption: the line opening "Table N-N:", the lines in
 * its face that carry on along its baseline (a caption set across the page's
 * columns), and the lines it wraps onto directly beneath.
 */
function captionLines(lines: readonly TextLine[]): Set<TextLine> {
    const out = new Set<TextLine>();
    for (const start of lines.filter((l) => isTableCaption(l.text))) {
        const [lead] = visibleRuns(start);
        if (lead === undefined) {
            continue;
        }
        out.add(start);
        let lowest = start.y;
        for (const l of lines) {
            const [r] = visibleRuns(l);
            if (r === undefined || l.pageIndex !== start.pageIndex || faceOf(r) !== faceOf(lead)) {
                continue;
            }
            const alongside = Math.abs(l.y - start.y) <= BASELINE_TOLERANCE;
            const beneath =
                l.column === start.column &&
                lowest - l.y > 0 &&
                lowest - l.y <= HEADING_WRAP_FACTOR * lead.size;
            if (alongside || beneath) {
                out.add(l);
                lowest = Math.min(lowest, l.y);
            }
        }
    }
    return out;
}

/** A field value ending mid-list — on a separator or conjunction — continues on the next line. */
export function valueUnfinished(value: string): boolean {
    return /(?:[,;&–-]|\b(?:and|or))\s*$/iu.test(value);
}

/** A value ending on a full stop (or other sentence end) is complete, whatever the line's length. */
export function endsSentence(value: string): boolean {
    return /[.!?]["”’)]*\s*$/u.test(value);
}

/** Most words an italic lead label carries; longer italic leads are emphasis in running text. */
const MAX_ITALIC_LABEL_WORDS = 2;

/**
 * A `Label: value` line: its label is the lead set apart from the text — in
 * bold, or in italics as a short capitalised label ("Mass: 6 megatonnes").
 */
function fieldOf(line: TextLine): [string, string] | null {
    const runs = visibleRuns(line);
    const first = runs[0];
    if (first === undefined) {
        return null;
    }
    const m = /^(?<label>[^:]{1,40}):\s*(?<value>.*)$/u.exec(line.text);
    const label = m?.groups?.["label"]?.trim();
    const value = m?.groups?.["value"]?.trim();
    if (label === undefined || value === undefined) {
        return null;
    }
    if (first.weight !== "bold") {
        const roman = runs.findIndex((r) => !r.italic);
        const italicLead = joinRuns(roman < 0 ? runs : runs.slice(0, roman));
        const italicLabel =
            first.italic &&
            /^\p{Lu}/u.test(label) &&
            label.split(/\s+/u).length <= MAX_ITALIC_LABEL_WORDS &&
            italicLead.startsWith(label);
        return italicLabel && value.length > 0 ? [label, value] : null;
    }
    // The label must be the bold lead, not a colon somewhere in prose.
    const boldText = joinRuns(runs.filter((r) => r.weight === "bold"));
    return boldText.startsWith(label) ? [label, value] : null;
}

/**
 * Entries in the document. `tableRuns` are the runs already read as a table's
 * header and records: a line made only of them is a table line, never a
 * heading, field or body text.
 */
/**
 * Whether a line lies in a page margin: top and bottom bands hold running
 * heads, feet and folios; a side margin holds thumb-index tabs and marginal
 * notes.
 */
function marginalIn(ir: IR): (line: TextLine) => boolean {
    const heights = new Map(ir.pages.map((p) => [p.pageIndex, p.height] as const));
    const widths = new Map(ir.pages.map((p) => [p.pageIndex, p.width] as const));
    const bands = marginBandsOf(ir);
    return (l) =>
        inMarginBand(l.y, heights.get(l.pageIndex) ?? 0, bands) ||
        inSideMargin(l.runs[0]?.x ?? 0, l.right, widths.get(l.pageIndex) ?? 0);
}

/**
 * Each page's running text: the margin lines, and the labels set sideways on
 * its edge, that repeat on many pages, other than folios. A running head names
 * the part of the book its page belongs to ("II: Lanterns"), a section no
 * heading on the page may repeat.
 */
export function runningHeads(ir: IR): Map<number, string[]> {
    const marginal = marginalIn(ir);
    const lines = buildLines(ir);
    const kept = new Set(withoutRunningFurniture(lines, marginal));
    const heads = new Map<number, string[]>();
    const add = (pageIndex: number, text: string): void => {
        if (/\p{L}/u.test(text)) {
            heads.set(pageIndex, [...(heads.get(pageIndex) ?? []), text]);
        }
    };
    for (const line of lines) {
        if (!kept.has(line)) {
            add(line.pageIndex, line.text);
        }
    }
    const edgePages = new Map<string, number>();
    for (const page of ir.pages) {
        for (const label of new Set(page.edgeText)) {
            edgePages.set(label, (edgePages.get(label) ?? 0) + 1);
        }
    }
    for (const page of ir.pages) {
        for (const label of page.edgeText) {
            if ((edgePages.get(label) ?? 0) >= FURNITURE_PAGES) {
                add(page.pageIndex, label);
            }
        }
    }
    return heads;
}

export function detectEntries(ir: IR, tableRuns: ReadonlySet<IRTextRun>): Entry[] {
    const body = bodyStyle(ir);
    const marginal = marginalIn(ir);
    const inTable = (l: TextLine): boolean => visibleRuns(l).every((r) => tableRuns.has(r));
    const lines = withoutFigures(withoutRunningFurniture(buildLines(ir), marginal)).filter(
        (l) => !inTable(l),
    );
    const headingFaces = new Set<string>();
    for (const line of lines) {
        const first = visibleRuns(line)[0];
        if (first !== undefined && headingOf(line, body, marginal(line)) !== null) {
            headingFaces.add(faceOf(first));
        }
    }
    const columnRights = new Map<string, number[]>();
    for (const l of lines) {
        const key = `${l.pageIndex}:${l.column}`;
        columnRights.set(key, [...(columnRights.get(key) ?? []), l.right]);
    }
    const columnRight = new Map(
        [...columnRights].map(
            ([key, rights]) => [key, percentile(rights.sort(numAsc), EDGE_PERCENTILE)] as const,
        ),
    );
    const wrapped = (l: TextLine): boolean =>
        l.right >= (columnRight.get(`${l.pageIndex}:${l.column}`) ?? 0) - WRAP_SLACK;
    /** A field value runs on when its line wraps before the value ends a sentence, or it ends mid-list. */
    const continues = (l: TextLine, value: string): boolean =>
        (wrapped(l) && !endsSentence(value)) || valueUnfinished(value);

    const entries: Entry[] = [];
    const stack: Heading[] = [];
    let current: Entry | null = null;
    let lastFieldWrapped = false;
    let bodyLines: string[] = [];
    let lastBody: TextLine | null = null;

    const close = (): void => {
        if (current !== null) {
            current.body = bodyLines
                .join(" ")
                .replace(/[^\S\n]+/gu, " ")
                .replace(/ ?\n\n ?/gu, PARAGRAPH_BREAK)
                .trim();
            entries.push(current);
        }
        current = null;
        bodyLines = [];
        lastBody = null;
    };
    /** A wider gap than line spacing above a body line opens a new paragraph. */
    const opensParagraph = (line: TextLine): boolean => {
        if (lastBody === null || lastBody.pageIndex !== line.pageIndex || lastBody.column !== line.column) {
            return false;
        }
        const size = Math.max(...line.runs.map((r) => r.size));
        return lastBody.y - line.y > PARAGRAPH_GAP_FACTOR * size;
    };

    const captions = captionLines(lines);
    let previous: TextLine | null = null;
    for (const line of lines) {
        // A table caption, however its text is laid out, labels a table.
        if (captions.has(line)) {
            previous = line;
            continue;
        }
        const heading = headingOf(line, body, marginal(line), headingFaces);
        const prevLine = previous;
        previous = line;
        if (heading !== null && current !== null && prevLine !== null) {
            const open: Entry = current;
            // A heading line straight under a heading line of the same style,
            // before any fields or body, is the same heading wrapped.
            const wrappedHeading =
                open.fields.length === 0 &&
                bodyLines.length === 0 &&
                open.heading.style === heading.style &&
                prevLine.pageIndex === line.pageIndex &&
                prevLine.column === line.column &&
                prevLine.y - line.y <= HEADING_WRAP_FACTOR * heading.size;
            if (wrappedHeading) {
                open.heading.text = `${open.heading.text} ${heading.text}`;
                continue;
            }
        }
        if (heading !== null) {
            close();
            while ((stack.at(-1)?.size ?? Number.POSITIVE_INFINITY) <= heading.size + LEVEL_STEP) {
                stack.pop();
            }
            current = { heading, sections: stack.map((h) => h.text), fields: [], body: "" };
            stack.push(heading);
            lastFieldWrapped = false;
            continue;
        }
        if (current === null) {
            continue;
        }
        const entry: Entry = current;
        const field = fieldOf(line);
        if (field !== null) {
            entry.fields.push(field);
            lastFieldWrapped = continues(line, field[1]);
            continue;
        }
        const last = entry.fields[entry.fields.length - 1];
        if (lastFieldWrapped && last !== undefined) {
            last[1] = `${last[1]} ${line.text}`.trim();
            lastFieldWrapped = continues(line, last[1]);
            continue;
        }
        lastFieldWrapped = false;
        if (opensParagraph(line)) {
            bodyLines.push(PARAGRAPH_BREAK);
        }
        bodyLines.push(line.text);
        lastBody = line;
    }
    close();
    return entries;
}
