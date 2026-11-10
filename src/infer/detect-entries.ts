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
import type { ItemType } from "./schema.ts";
import { isLabelRow } from "./stat-labels.ts";

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
/** Lines either side of a line whose right ends give its block's measure. */
const WRAP_WINDOW = 3;
/** Right ends within this many points of each other are one justified measure. */
const JUSTIFIED_TOLERANCE = 1;
/** Neighbours ending with a line that make it a full line of a justified block. */
const MIN_JUSTIFIED_NEIGHBOURS = 2;
/** Least share of its column's width a panel's measure spans. */
const PANEL_MEASURE_SHARE = 0.85;
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
/** A line at this many times the body size is a display title, even when it breaks off mid-phrase. */
const BROKEN_TITLE_FACTOR = 2;
/** A heading line within this many heading-sizes below another continues it. */
const HEADING_WRAP_FACTOR = 1.6;
/** A heading broken off inside an open bracket continues on a heading line within this many sizes below. */
const OPEN_HEADING_WRAP_FACTOR = 2;
/** A gap above a body line wider than this many font-sizes opens a paragraph. */
const PARAGRAPH_GAP_FACTOR = 1.5;
/** A paragraph's first line is indented at most this many font sizes. */
const MAX_PARAGRAPH_INDENT = 3;
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
    /**
     * The kind a list heading names its run-in entries as ("… Talents" over
     * `Name: rules` lines): an entry read out of such a list is one of them.
     */
    listedAs?: ItemType;
    /** A heading over a list read out into entries of their own: it heads them and is none of them. */
    listHead?: boolean;
    /**
     * The discipline a heading printed earlier in the power catalogue names
     * as such ("The Lampcraft Discipline"), when one is in force here.
     */
    discipline?: string;
}

/** A capital set this much larger than the small letters before it opens a word of its own. */
const SMALL_CAPS_INITIAL = 1.2;

export function joinRuns(runs: readonly IRTextRun[]): string {
    let text = "";
    let prevEnd = Number.NEGATIVE_INFINITY;
    let prevSize = 0;
    for (const r of runs) {
        if (r.text.length === 0) {
            continue;
        }
        // Adjacent runs without a gap continue one word — unless the next opens
        // on a capital set larger than the letters before it: the initial of
        // the next word in small capitals, whose space the text layer left out.
        const gap = r.x - prevEnd;
        const initial =
            r.size > SMALL_CAPS_INITIAL * prevSize && /^\p{Lu}/u.test(r.text) && /\p{Ll}$/u.test(text);
        text +=
            text.length > 0 && (initial || wordBreakBetween(text, r.text, gap, wordSpace(prevSize, r.size)))
                ? ` ${r.text}`
                : r.text;
        prevEnd = r.x + r.width;
        prevSize = r.size;
    }
    return text.replace(/\s+/gu, " ").trim();
}

/** Share of the narrower run two runs of one text must overlap by to be one printed text. */
const SHADOW_OVERLAP = 0.5;

/**
 * A line's runs without the copies a page sets of its own text over it — a
 * display heading printed twice for an outline or shadow ("TITLE" over
 * "TITLE"): a run of the same text overlapping a kept run by half its width.
 */
export function withoutShadows(runs: readonly IRTextRun[]): IRTextRun[] {
    const kept: IRTextRun[] = [];
    for (const r of runs) {
        const text = r.text.trim();
        const shadow = kept.some((k) => {
            const overlap = Math.min(k.x + k.width, r.x + r.width) - Math.max(k.x, r.x);
            return (
                text.length > 0 &&
                k.text.trim() === text &&
                overlap >= SHADOW_OVERLAP * Math.min(k.width, r.width)
            );
        });
        if (!shadow) {
            kept.push(r);
        }
    }
    return kept;
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
            const runs = withoutShadows([...group.runs].sort((a, b) => numAsc(a.x, b.x)));
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
    // Margin bands hold running heads, feet and folios — never a heading; a
    // table caption heads its table, not a section of the text; and a row
    // of characteristic labels, however boldly set, heads only its values.
    if (inMargin || isTableCaption(line.text) || isLabelRow(line.text)) {
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
    // A title set at display size may wrap on a connecting word ("Rules of
    // the" / "Road"); running text is never set that large.
    const brokenOff =
        (/,$/u.test(line.text.trim()) || FUNCTION_WORDS.has(lastWord)) &&
        size < BROKEN_TITLE_FACTOR * body.size;
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
        // (A line with no capitals at all is display type whose case was lost;
        // so is one in scrambled case, or with words in capitals and none in
        // title case: small capitals wrapping their bracketed tags.)
        (brokenOff &&
            /\p{Ll}/u.test(line.text) &&
            /\p{Lu}/u.test(line.text) &&
            !scrambledCase(line.text) &&
            !(CAPITALS_WORD.test(line.text) && !TITLE_CASED_WORD.test(line.text))) ||
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
 * apart.) `textKey` sets what counts as the same text (e.g. a foot with the
 * folio in it, its digits ignored).
 */
export function withoutRunningFurniture<T extends TextLine>(
    lines: readonly T[],
    marginal: (line: TextLine) => boolean,
    textKey: (text: string) => string = (text) => text,
): T[] {
    const place = (l: TextLine): string => `${textKey(l.text)}\u0000${Math.round(l.y / FURNITURE_Y_BUCKET)}`;
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

/** A gap after a field's label wider than this many font sizes sets its value apart, in a column of its own. */
const SET_APART_GAP_FACTOR = 2.5;
/** A line starting this many points left of a set-apart value does not continue it. */
const SET_APART_SLACK = 4;
/** Fewest set-apart fields in an entry for them to be read as a block of aligned values. */
const MIN_SET_APART_FIELDS = 2;

/**
 * Where a field line's value starts when a wide gap sets it apart from its
 * bold label (the value aligned in a column of its own, as in a block of
 * `Label:    value` lines); null when the value follows the label as running text.
 */
export function setApartValueX(line: TextLine): number | null {
    const runs = visibleRuns(line);
    const valueAt = runs.findIndex((r) => r.weight !== "bold");
    const label = runs[valueAt - 1];
    const value = runs[valueAt];
    if (valueAt < 1 || label === undefined || value === undefined) {
        return null;
    }
    return value.x - (label.x + label.width) > SET_APART_GAP_FACTOR * value.size ? value.x : null;
}

/**
 * A field value ending mid-list — on a separator or conjunction — or
 * mid-phrase, on an article or preposition ("the Navigator makes an"),
 * continues on the next line.
 */
export function valueUnfinished(value: string): boolean {
    const lastWord = /(?<!\p{L})\p{L}+\s*$/u.exec(value)?.[0].trim() ?? "";
    return /(?:[,;&–-]|\b(?:and|or))\s*$/iu.test(value) || FUNCTION_WORDS.has(lastWord);
}

/** A value ending on a full stop (or other sentence end) is complete, whatever the line's length. */
export function endsSentence(value: string): boolean {
    return /[.!?]["”’)]*\s*$/u.test(value);
}

/** Words this long or longer are content words: in a list of names they are capitalised. */
const MIN_CONTENT_WORD = 4;

/**
 * A value that reads as a finished list of names: no sentence, no trailing
 * separator, and every content word outside brackets capitalised ("Psy
 * Rating, Strong Minded, Willpower 40"). Prose ("may re-roll Willpower") and
 * a value broken mid-phrase ("Rank 2 in") are not.
 */
export function nameListValue(value: string): boolean {
    if (value === "" || endsSentence(value) || valueUnfinished(value) || /[.!?]\s/u.test(value)) {
        return false;
    }
    // A bracket left open ("Lore (Glow") breaks the value mid-name.
    if ((value.match(/[([]/gu) ?? []).length > (value.match(/[)\]]/gu) ?? []).length) {
        return false;
    }
    const outside = value.replace(/\([^)]*\)|\[[^\]]*\]/gu, " ");
    const words = outside.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
    return words.every((w) => w.length < MIN_CONTENT_WORD || /^\p{Lu}/u.test(w));
}

/** Text holding a sentence end: a full stop (or other) at its end or before a space. */
function holdsSentence(text: string): boolean {
    return /[.!?]["”’)]*(?:\s|$)/u.test(text);
}

/** Most words an italic lead label carries; longer italic leads are emphasis in running text. */
const MAX_ITALIC_LABEL_WORDS = 2;

/**
 * A `Label: value` line: its label is the lead set apart from the text — in
 * bold, or in italics as a short capitalised label ("Mass: 6 megatonnes").
 */
function fieldOf(line: TextLine, boldLabels: ReadonlySet<string>): [string, string] | null {
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
    // A line whose weights were lost (read from the page image) still opens
    // with a label the document sets in bold elsewhere.
    if (first.weight !== "bold" && boldLabels.has(label) && value.length > 0) {
        return [label, value];
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
export function marginalIn(ir: IR): (line: TextLine) => boolean {
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

/** Fewest lines of text on each side of a table for it to be an inset between columns. */
const MIN_BESIDE_LINES = 3;
/** Lines of leading above and below a table within which text sits beside it. */
const BESIDE_REACH_LINES = 2;
/** Ordinary leading, in type sizes. */
const LINE_LEADING = 1.2;
/** Points within which a column of the page above starts where the text beside a table does. */
const BESIDE_EDGE_TOLERANCE = 4;

/**
 * A table set between two columns of running text: the text on each side of
 * it is no single column, though the page's column detection may give the
 * whole band one (the table bridges the gutter). Each side is read as the
 * column it carries on — the page's column above it starting at its edge —
 * or, with none, the text right of the table as a column of its own after
 * the left's.
 */
export function besideInsetTables(ir: IR, tableRuns: ReadonlySet<IRTextRun>): IR {
    const visible = ir.runs.filter((r) => r.text.trim().length > 0);
    const byColumn = new Map<string, IRTextRun[]>();
    for (const r of visible) {
        const key = `${r.pageIndex}:${r.column}`;
        byColumn.set(key, [...(byColumn.get(key) ?? []), r]);
    }
    const moved = new Map<IRTextRun, IRTextRun>();
    for (const group of byColumn.values()) {
        const table = group.filter((r) => tableRuns.has(r));
        const [first] = group;
        if (table.length === 0 || first === undefined) {
            continue;
        }
        const left = Math.min(...table.map((r) => r.x));
        const right = Math.max(...table.map((r) => r.x + r.width));
        const sizes = group.map((r) => r.size).sort(numAsc);
        const reach = BESIDE_REACH_LINES * LINE_LEADING * percentile(sizes, 0.5);
        const top = Math.max(...table.map((r) => r.y)) + reach;
        const bottom = Math.min(...table.map((r) => r.y)) - reach;
        const near = group.filter((r) => !tableRuns.has(r) && r.y <= top && r.y >= bottom);
        const before = near.filter((r) => r.x + r.width <= left);
        const after = near.filter((r) => r.x >= right);
        const lineCount = (runs: readonly IRTextRun[]): number =>
            new Set(runs.map((r) => Math.round(r.y))).size;
        if (lineCount(before) < MIN_BESIDE_LINES || lineCount(after) < MIN_BESIDE_LINES) {
            continue;
        }
        const continued = (side: readonly IRTextRun[], fallback: number): number => {
            const edge = Math.min(...side.map((r) => r.x));
            const counts = new Map<number, number>();
            for (const r of visible) {
                if (
                    r.pageIndex === first.pageIndex &&
                    r.column !== first.column &&
                    r.y > top &&
                    Math.abs(r.x - edge) <= BESIDE_EDGE_TOLERANCE
                ) {
                    counts.set(r.column, (counts.get(r.column) ?? 0) + 1);
                }
            }
            const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
            return best?.[0] ?? fallback;
        };
        for (const [side, column] of [
            [before, continued(before, first.column)],
            [after, continued(after, first.column + 0.5)],
        ] as const) {
            for (const r of side) {
                moved.set(r, { ...r, column });
            }
        }
    }
    return moved.size === 0 ? ir : { ...ir, runs: ir.runs.map((r) => moved.get(r) ?? r) };
}

export function detectEntries(read: IR, tableRuns: ReadonlySet<IRTextRun>): Entry[] {
    const ir = besideInsetTables(read, tableRuns);
    const body = bodyStyle(ir);
    const marginal = marginalIn(ir);
    // A table's runs are no text: a line sharing a baseline with a table's
    // (a heading beside a header's second line, a field beside a caption) is
    // read without them, its other runs grouped by baseline again (a table's
    // run may have bridged two baselines into one line).
    const lines = withoutFigures(withoutRunningFurniture(buildLines(ir), marginal)).flatMap((l) => {
        const runs = l.runs.filter((r) => !tableRuns.has(r));
        if (runs.length === l.runs.length) {
            return [l];
        }
        return buildLines({ ...ir, runs }).filter((own) => own.runs.some((r) => r.text.trim().length > 0));
    });
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
    const columnLefts = new Map<string, number[]>();
    for (const l of lines) {
        const key = `${l.pageIndex}:${l.column}`;
        columnLefts.set(key, [...(columnLefts.get(key) ?? []), visibleRuns(l)[0]?.x ?? l.right]);
    }
    const columnLeft = new Map(
        [...columnLefts].map(
            ([key, lefts]) => [key, percentile(lefts.sort(numAsc), 1 - EDGE_PERCENTILE)] as const,
        ),
    );
    // A panel inset within a column sets its lines to a narrower measure:
    // there a line is full when neighbours of its own end where it does
    // (justified lines end together) at nearly the column's width — not a
    // few short lines that happen to end alike.
    const justified = new Set<TextLine>();
    lines.forEach((l, i) => {
        const key = `${l.pageIndex}:${l.column}`;
        const left = columnLeft.get(key) ?? 0;
        if (l.right - left < PANEL_MEASURE_SHARE * ((columnRight.get(key) ?? 0) - left)) {
            return;
        }
        const together = lines
            .slice(Math.max(0, i - WRAP_WINDOW), i + WRAP_WINDOW + 1)
            .filter(
                (n) =>
                    n !== l &&
                    n.pageIndex === l.pageIndex &&
                    n.column === l.column &&
                    Math.abs(n.right - l.right) <= JUSTIFIED_TOLERANCE,
            );
        if (together.length >= MIN_JUSTIFIED_NEIGHBOURS) {
            justified.add(l);
        }
    });
    // Text set to a narrower measure than its column (an inset block of
    // fields): a line is full when it ends near where the widest of its
    // neighbours starting at its own left edge ends.
    const insetFull = new Set<TextLine>();
    lines.forEach((l, i) => {
        const left = visibleRuns(l)[0]?.x;
        if (left === undefined) {
            return;
        }
        const aligned = lines
            .slice(Math.max(0, i - WRAP_WINDOW), i + WRAP_WINDOW + 1)
            .filter(
                (n) =>
                    n !== l &&
                    n.pageIndex === l.pageIndex &&
                    n.column === l.column &&
                    Math.abs((visibleRuns(n)[0]?.x ?? Number.NaN) - left) <= JUSTIFIED_TOLERANCE,
            );
        const widest = Math.max(...aligned.map((n) => n.right));
        if (aligned.length >= MIN_JUSTIFIED_NEIGHBOURS && l.right >= widest - WRAP_SLACK) {
            insetFull.add(l);
        }
    });
    const wrapped = (l: TextLine): boolean =>
        justified.has(l) ||
        insetFull.has(l) ||
        l.right >= (columnRight.get(`${l.pageIndex}:${l.column}`) ?? 0) - WRAP_SLACK;
    /** A field value runs on when its line wraps before the value ends a sentence, or it ends mid-list. */
    const continues = (l: TextLine, value: string): boolean =>
        (wrapped(l) && !endsSentence(value)) || valueUnfinished(value);

    const entries: Entry[] = [];
    const stack: Heading[] = [];
    let current: Entry | null = null;
    /** The open entry's (last) heading line. */
    let headingLine: TextLine | null = null;
    /** The last line read that is no table caption. */
    let lastText: TextLine | null = null;
    let lastFieldWrapped = false;
    /** The line a field value last ended on, while nothing else has followed it. */
    let lastFieldLine: TextLine | null = null;
    let lastValueX: number | null = null;
    let setApartFields = 0;
    let bodyLines: string[] = [];
    let lastBody: TextLine | null = null;
    /**
     * A finished list of names whose line wrapped, then ran on into a line
     * opening on a capital: held until the run-on ends, when, if what ran on
     * holds a sentence, it was the entry's text set at the field's own left
     * edge, not more of the list.
     */
    let held: { field: [string, string]; before: string; lines: TextLine[] } | null = null;
    /** `next` is the line after the run-on, when one follows in the entry. */
    const settle = (next?: TextLine): void => {
        if (held === null) {
            return;
        }
        const { field, before, lines: ranOn } = held;
        held = null;
        const text = ranOn.map((l) => l.text).join(" ");
        // More names closed by a full stop ("Strong Minded, Willpower 40.") stay the field's.
        if (!holdsSentence(text) || nameListValue(text.replace(/[.!?]["”’)]*\s*$/u, ""))) {
            return;
        }
        // The entry's text opens with a paragraph indent where it has one: a
        // run-on at the margin followed, at line spacing, by a line indented
        // from it was the value's own end ("Basic" / "Weapon Training in at
        // least two groups of weapons."), the indented line the text.
        const [firstRan] = ranOn;
        const lastRan = ranOn.at(-1);
        const ranLeft = firstRan === undefined ? undefined : visibleRuns(firstRan)[0]?.x;
        const nextLeft = next === undefined ? undefined : visibleRuns(next)[0]?.x;
        if (
            next !== undefined &&
            lastRan !== undefined &&
            ranLeft !== undefined &&
            nextLeft !== undefined &&
            followsInColumn(lastRan, next) &&
            nextLeft - ranLeft > JUSTIFIED_TOLERANCE &&
            nextLeft - ranLeft <= MAX_PARAGRAPH_INDENT * Math.max(...next.runs.map((r) => r.size))
        ) {
            return;
        }
        field[1] = before;
        bodyLines.push(...ranOn.map((l) => l.text));
        lastBody = ranOn.at(-1) ?? lastBody;
    };

    const close = (): void => {
        settle();
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
    /** `line` follows `above` at line spacing, in its column and at its left edge. */
    /** The line follows the one above in its column at line spacing. */
    const followsInColumn = (above: TextLine, line: TextLine): boolean => {
        if (above.pageIndex !== line.pageIndex || above.column !== line.column) {
            return false;
        }
        const size = Math.max(...line.runs.map((r) => r.size));
        const gap = above.y - line.y;
        return gap > 0 && gap <= PARAGRAPH_GAP_FACTOR * size;
    };
    /** …and starts where it starts. */
    const closesUp = (above: TextLine, line: TextLine): boolean =>
        followsInColumn(above, line) &&
        Math.abs((visibleRuns(line)[0]?.x ?? Number.NaN) - (visibleRuns(above)[0]?.x ?? Number.NaN)) <=
            JUSTIFIED_TOLERANCE;
    /** A wider gap than line spacing above a body line opens a new paragraph. */
    const opensParagraph = (line: TextLine): boolean => {
        if (lastBody === null || lastBody.pageIndex !== line.pageIndex || lastBody.column !== line.column) {
            return false;
        }
        const size = Math.max(...line.runs.map((r) => r.size));
        return lastBody.y - line.y > PARAGRAPH_GAP_FACTOR * size;
    };

    const noLabels = new Set<string>();
    const boldLabels = new Set(
        lines
            .filter((l) => visibleRuns(l)[0]?.weight === "bold")
            .map((l) => fieldOf(l, noLabels)?.[0])
            .filter((label) => label !== undefined),
    );
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
        const prevText = lastText;
        previous = line;
        if (!marginal(line)) {
            lastText = line;
        }
        if (heading !== null && current !== null && prevLine !== null) {
            const open: Entry = current;
            // A heading line straight under a heading line of the same style,
            // before any fields or body, is the same heading wrapped. One broken
            // off inside an open bracket ("Name (Advanced,") is set a little
            // further from its closing line.
            const bracketOpen = /\([^)]*$/u.test(open.heading.text);
            const wrappedHeading =
                open.fields.length === 0 &&
                bodyLines.length === 0 &&
                open.heading.style === heading.style &&
                prevLine.pageIndex === line.pageIndex &&
                prevLine.column === line.column &&
                prevLine.y - line.y <=
                    (bracketOpen ? OPEN_HEADING_WRAP_FACTOR : HEADING_WRAP_FACTOR) * heading.size;
            // A heading line opening the next column on the page, set like a
            // heading line that closed the column before with nothing after it
            // but a table (its runs no text), a caption or the page's margin
            // (a folio), is that heading wrapped across the columns under its
            // table.
            const wrappedAcross =
                open.fields.length === 0 &&
                open.heading.style === heading.style &&
                prevText !== null &&
                headingLine === prevText &&
                prevText.pageIndex === line.pageIndex &&
                prevText.column + 1 === line.column;
            if (wrappedHeading || wrappedAcross) {
                open.heading.text = `${open.heading.text} ${heading.text}`;
                headingLine = line;
                continue;
            }
        }
        if (heading !== null) {
            close();
            while ((stack.at(-1)?.size ?? Number.POSITIVE_INFINITY) <= heading.size + LEVEL_STEP) {
                stack.pop();
            }
            current = { heading, sections: stack.map((h) => h.text), fields: [], body: "" };
            headingLine = line;
            stack.push(heading);
            lastFieldWrapped = false;
            lastFieldLine = null;
            lastValueX = null;
            setApartFields = 0;
            continue;
        }
        if (current === null) {
            continue;
        }
        const entry: Entry = current;
        const field = fieldOf(line, boldLabels);
        if (field !== null) {
            settle();
            entry.fields.push(field);
            lastFieldWrapped = continues(line, field[1]);
            lastFieldLine = line;
            lastValueX = setApartValueX(line);
            setApartFields += lastValueX === null ? 0 : 1;
            continue;
        }
        const last = entry.fields[entry.fields.length - 1];
        // In a block of fields whose values are set apart in a column of their
        // own, a value runs on only in that column: a line back at the margin
        // is the entry's text.
        const atMargin =
            lastValueX !== null &&
            setApartFields >= MIN_SET_APART_FIELDS &&
            (visibleRuns(line)[0]?.x ?? 0) < lastValueX - SET_APART_SLACK;
        // A value whose sentence ends just at the line's end may still run on:
        // the next line follows at line spacing in the same column and within
        // the value's own measure (text set wider is the entry's own).
        const runsOn =
            lastFieldLine !== null &&
            last !== undefined &&
            wrapped(lastFieldLine) &&
            endsSentence(last[1]) &&
            closesUp(lastFieldLine, line) &&
            line.right <= lastFieldLine.right + WRAP_SLACK;
        // A value left mid-sentence runs on into the line beneath it that opens
        // in lower case — no paragraph does — wherever that line starts (a
        // text layer may under-report the value line's width). A finished
        // list of names ("Toughness 40") is no sentence left open, and small
        // capitals whose case was lost ("lA S c A n n o n") open no sentence.
        const lowerRunsOn =
            lastFieldLine !== null &&
            last !== undefined &&
            !endsSentence(last[1]) &&
            !nameListValue(last[1]) &&
            /^\p{Ll}/u.test(line.text) &&
            !scrambledCase(line.text) &&
            followsInColumn(lastFieldLine, line);
        if ((lastFieldWrapped || runsOn || lowerRunsOn) && last !== undefined && !atMargin) {
            if (held !== null && held.field === last) {
                held.lines.push(line);
            } else if (lastFieldWrapped && nameListValue(last[1]) && /^\p{Lu}/u.test(line.text)) {
                held = { field: last, before: last[1], lines: [line] };
            }
            last[1] = `${last[1]} ${line.text}`.trim();
            lastFieldWrapped = continues(line, last[1]);
            lastFieldLine = line;
            continue;
        }
        settle(line);
        lastFieldWrapped = false;
        lastFieldLine = null;
        if (opensParagraph(line)) {
            bodyLines.push(PARAGRAPH_BREAK);
        }
        bodyLines.push(line.text);
        lastBody = line;
    }
    close();
    return entries;
}
