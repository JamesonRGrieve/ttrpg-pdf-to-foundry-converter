// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FontWeight, RawTextRun } from "../types/ir.ts";
import { numAsc } from "../util/ordered.ts";
import type { OcrWord } from "./types.ts";

/**
 * Text runs for a scanned page — one with no text layer, whose every word comes
 * from OCR. Structural inference reads typography (size, weight) and lines, so
 * a scanned page must present the same: words regrouped into the lines
 * recognition found, each line set at one size, each word given a weight.
 *
 *  - SIZE comes from the line's row height, which wobbles from line to line in
 *    a scan. Heights are pooled over the whole document and snapped to their
 *    modes, so every line of one type size reads as one size, the way a text
 *    layer reports it.
 *  - WEIGHT comes from stroke width (see `strokeWidth`). A word is bold when
 *    its strokes are clearly heavier than the page's typical word of the same
 *    size — measured per page, so each scan's exposure is its own reference —
 *    and the phrase around it is too. A field label the document opens many
 *    lines with ("Label:") is bold, as a text layer would set it.
 *  - RUNS join a line's consecutive words of one weight, split at gaps wider
 *    than a word space (table cells, column gutters).
 *
 * Every rule is geometric or photometric, with no knowledge of the content.
 */

export const OCR_FONT_NAME = "ocr-recovered";

/** Minimum confidence for a scanned word with letters or digits. */
export const SCAN_WORD_CONFIDENCE = 40;
/** Minimum confidence for a scanned word of symbols only (specks read as marks). */
export const SCAN_SYMBOL_CONFIDENCE = 85;
/** Line heights are histogrammed in bins of this width on a log scale (≈2%). */
const LOG_BIN = 0.02;
/** Half-width, in bins, of the window that smooths the height histogram (≈±6%). */
const MODE_WINDOW = 3;
/** A size mode must hold at least this share of the document's letters. */
const MIN_MODE_SHARE = 0.02;
/**
 * A line snaps to a mode within this log distance (≈±8%); else it keeps its
 * own height. Sizes measured from the print vary by a few percent, while a
 * heading is set a fifth or more above its text.
 */
const SNAP_REACH = Math.log(1.08);
/** Unsnapped heights are rounded to this step (points). */
const SIZE_STEP = 0.25;
/** A word is bold when its stroke is at least this multiple of its reference. */
export const BOLD_RATIO = 1.18;
/** Words with fewer letters than this are too small to measure alone. */
const MIN_MEASURED_LETTERS = 4;
/** Most words a field label ("Label:", "Two Words:") runs to at a line's start. */
const MAX_LABEL_WORDS = 3;
/** Fewest lines a label must start for it to be one of the document's field labels. */
const MIN_LABEL_LINES = 3;
/** A page reference needs this many measurable words at a size; else the document's is used. */
const MIN_REFERENCE_WORDS = 8;
/** A gap wider than this multiple of the size ends a run (a word space is well under it). */
const RUN_GAP_FACTOR = 1;
/** A gap wider than this many of the document's word spaces at the size ends a run (a table's cells). */
const RUN_SPACE_FACTOR = 2.5;

/** A word's baseline may sit this share of its height outside its box before the line is taken to be another's. */
const BASELINE_SLACK = 0.25;
/** Line ordinals given to words split from the line recognition put them on. */
const OWN_LINE_BASE = 10_000_000;

const HAS_ALNUM = /[\p{L}\p{N}]/u;
/** A word of nothing but bar and bracket strokes: a box's ruled edge read as glyphs. */
const RULE_MARKS = /^[|[\]]+$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

function letters(text: string): number {
    return text.match(LETTER_OR_DIGIT)?.length ?? 0;
}

/** Fewest characters a word needs for its box's shape to tell its direction. */
const MIN_SIDEWAYS_CHARS = 3;
/** A word set on its side is at least this many times taller than wide. */
const SIDEWAYS_RATIO = 1.5;

/**
 * A word of several letters whose box is clearly taller than wide is set on its side
 * (a thumb tab running up a page edge): page furniture, as a text layer's
 * sideways runs are, never a line of the page's text. A word of two
 * characters is near square either way ("41" in a boxed cell), so on a page
 * read from its image alone it never is.
 */
export function setSideways(word: OcrWord): boolean {
    const [x0, y0, x1, y1] = word.box;
    return [...word.text].length >= MIN_SIDEWAYS_CHARS && y1 - y0 > SIDEWAYS_RATIO * (x1 - x0);
}

/**
 * Whether a word read from the image is anything but plainly upright: two
 * characters or more in a box taller than wide. A word added to a text layer
 * (`arbitrate`) must be upright beyond doubt: the layer already holds the
 * page's upright text, and a sideways tab read as a word ("IV:") would stand
 * in it as a giant heading.
 */
export function notPlainlyUpright(word: OcrWord): boolean {
    const [x0, y0, x1, y1] = word.box;
    return [...word.text].length > 1 && y1 - y0 > x1 - x0;
}

/** A word confident enough for what it is: a word with letters or digits, or a mark (specks read as marks need more). */
export function confidentWord(w: OcrWord): boolean {
    return HAS_ALNUM.test(w.text)
        ? w.confidence >= SCAN_WORD_CONFIDENCE
        : w.confidence >= SCAN_SYMBOL_CONFIDENCE;
}

/**
 * The words of a scanned page worth keeping: confident enough for what they
 * are, set across, and not a ruled edge. A word recognition put on a line whose
 * baseline misses the word's own box (a boxed cell read as part of the label
 * row above it) is given a line of its own, on its box's foot.
 */
export function keptWords(words: readonly OcrWord[]): OcrWord[] {
    return words
        .filter((w) => !setSideways(w) && !RULE_MARKS.test(w.text) && confidentWord(w))
        .map((w, i) => {
            const [, y0, , y1] = w.box;
            const slack = BASELINE_SLACK * (y1 - y0);
            return w.baseline < y0 - slack || w.baseline > y1 - slack
                ? { ...w, line: OWN_LINE_BASE + i, baseline: y0, lineHeight: y1 - y0 }
                : w;
        });
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort(numAsc);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** One recognized line: its words left to right, and its measured height. */
export interface ScanLine {
    words: OcrWord[];
    height: number;
}

function linesOf(words: readonly OcrWord[]): ScanLine[] {
    const byLine = new Map<number, OcrWord[]>();
    for (const w of words) {
        const list = byLine.get(w.line) ?? [];
        list.push(w);
        byLine.set(w.line, list);
    }
    return [...byLine]
        .sort((a, b) => numAsc(a[0], b[0]))
        .map(([, ws]) => {
            const sorted = [...ws].sort((a, b) => numAsc(a.box[0], b.box[0]));
            return { words: sorted, height: sorted[0]?.lineHeight ?? 0 };
        });
}

/**
 * The document's type sizes: modes of the letter-weighted line-height
 * histogram. A mode is a bin whose smoothed weight is highest within the
 * window (ties go to the leftmost), holding enough of the document's letters;
 * its value is the letter-weighted mean height around it.
 */
export function sizeModes(lines: readonly { height: number; letters: number }[]): number[] {
    const bins = new Map<number, { weight: number; sum: number }>();
    let total = 0;
    for (const l of lines) {
        if (l.height <= 0 || l.letters === 0) {
            continue;
        }
        const bin = Math.round(Math.log(l.height) / LOG_BIN);
        const b = bins.get(bin) ?? { weight: 0, sum: 0 };
        b.weight += l.letters;
        b.sum += l.letters * l.height;
        bins.set(bin, b);
        total += l.letters;
    }
    const weightAt = (bin: number): number => bins.get(bin)?.weight ?? 0;
    const smoothed = (bin: number): number => {
        let s = 0;
        for (let k = -MODE_WINDOW; k <= MODE_WINDOW; k++) {
            s += weightAt(bin + k) * (MODE_WINDOW + 1 - Math.abs(k));
        }
        return s;
    };
    const modes: number[] = [];
    for (const bin of [...bins.keys()].sort(numAsc)) {
        const here = smoothed(bin);
        let peak = true;
        for (let k = 1; k <= MODE_WINDOW && peak; k++) {
            peak = here > smoothed(bin - k) && here >= smoothed(bin + k);
        }
        if (!peak) {
            continue;
        }
        let weight = 0;
        let sum = 0;
        for (let k = -MODE_WINDOW; k <= MODE_WINDOW; k++) {
            const b = bins.get(bin + k);
            weight += b?.weight ?? 0;
            sum += b?.sum ?? 0;
        }
        if (weight >= MIN_MODE_SHARE * total) {
            modes.push(sum / weight);
        }
    }
    return modes;
}

/** The size a line of `height` is set at: its nearest mode when one is close, else itself. */
export function snapSize(modes: readonly number[], height: number): number {
    let best: number | null = null;
    let bestDistance = SNAP_REACH;
    for (const m of modes) {
        const d = Math.abs(Math.log(height / m));
        if (d <= bestDistance) {
            best = m;
            bestDistance = d;
        }
    }
    return Math.round((best ?? height) / SIZE_STEP) * SIZE_STEP;
}

/** Everything document-wide that scanned pages are read against. */
export interface ScanScale {
    modes: number[];
    /** Typical stroke of a measurable word at each snapped size, over the document. */
    strokes: Map<number, number>;
    /** Field labels the document opens lines with, lower-cased ("prerequisites:"). */
    labels: Set<string>;
    /** Typical gap between words of a line at each snapped size: the word space. */
    spaces: Map<number, number>;
    /**
     * Factor from a measured size to a type size: measured sizes rest on an
     * assumed x-height share, which varies by face, so they are scaled to make
     * the body text's line pitch its usual leading (see `sizeFactor`).
     */
    sizeFactor: number;
}

/** How many of a line's first words make a label ending in a colon (0 when none do). */
function labelLength(words: readonly OcrWord[]): number {
    const end = words.slice(0, MAX_LABEL_WORDS).findIndex((w) => w.text.endsWith(":"));
    return end + 1;
}

function labelKey(words: readonly OcrWord[], length: number): string {
    return words
        .slice(0, length)
        .map((w) => w.text.toLowerCase())
        .join(" ");
}

/**
 * The field labels of a document: colon-ended openings that start several
 * lines. A text layer sets such labels bold; a scan's own stroke measure is
 * too faint a signal for a lone word, so recurrence stands in for it.
 */
export function fieldLabels(lines: readonly (readonly OcrWord[])[]): Set<string> {
    const counts = new Map<string, number>();
    for (const words of lines) {
        const length = labelLength(words);
        if (length > 0) {
            const key = labelKey(words, length);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return new Set([...counts].filter(([, n]) => n >= MIN_LABEL_LINES).map(([key]) => key));
}

/** How many of a line's first words are one of the document's field labels. */
function labelOpening(words: readonly OcrWord[], labels: ReadonlySet<string>): number {
    const length = labelLength(words);
    return length > 0 && labels.has(labelKey(words, length)) ? length : 0;
}

function measurable(w: OcrWord): boolean {
    return letters(w.text) >= MIN_MEASURED_LETTERS && w.stroke > 0;
}

function strokesBySize(lines: readonly ScanLine[], modes: readonly number[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const line of lines) {
        const size = snapSize(modes, line.height);
        const list = out.get(size) ?? [];
        list.push(...line.words.filter(measurable).map((w) => w.stroke));
        out.set(size, list);
    }
    return out;
}

/** Build the document scale from every scanned page's words. */
export function scanScale(pages: readonly (readonly OcrWord[])[]): ScanScale {
    const pageLines = pages.map((words) => linesOf(keptWords(words)));
    const lines = pageLines.flat();
    const modes = sizeModes(
        lines.map((l) => ({ height: l.height, letters: l.words.reduce((n, w) => n + letters(w.text), 0) })),
    );
    const strokes = new Map<number, number>();
    for (const [size, values] of strokesBySize(lines, modes)) {
        if (values.length > 0) {
            strokes.set(size, median(values));
        }
    }
    const gaps = new Map<number, number[]>();
    for (const line of lines) {
        const size = snapSize(modes, line.height);
        const list = gaps.get(size) ?? [];
        line.words.slice(1).forEach((w, i) => {
            const prev = line.words[i];
            if (prev !== undefined) {
                list.push(w.box[0] - prev.box[2]);
            }
        });
        gaps.set(size, list);
    }
    const spaces = new Map<number, number>();
    for (const [size, values] of gaps) {
        if (values.length >= MIN_REFERENCE_WORDS) {
            spaces.set(size, median(values));
        }
    }
    return {
        modes,
        strokes,
        labels: fieldLabels(lines.map((l) => l.words)),
        spaces,
        sizeFactor: sizeFactor(pageLines, modes),
    };
}

/** Body text's usual leading: line pitch over type size. */
const BODY_LEADING = 1.2;
/** Calibration never scales measured sizes beyond these factors. */
const MIN_SIZE_FACTOR = 0.8;
const MAX_SIZE_FACTOR = 1.4;
/** Consecutive lines of a paragraph sit within this many sizes of each other. */
const MAX_PITCH_SIZES = 2.5;

/**
 * The factor that sets the body text (the size holding the most letters) at
 * its usual leading: its lines' median pitch — from each line to the next one
 * below it at that size, overlapping it across — over `BODY_LEADING` times
 * its measured size. 1 when there are too few lines to tell.
 */
export function sizeFactor(pages: readonly (readonly ScanLine[])[], modes: readonly number[]): number {
    const letterCount = new Map<number, number>();
    for (const line of pages.flat()) {
        const size = snapSize(modes, line.height);
        const count = line.words.reduce((n, w) => n + letters(w.text), 0);
        letterCount.set(size, (letterCount.get(size) ?? 0) + count);
    }
    const body = [...letterCount].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (body === undefined || body <= 0) {
        return 1;
    }
    const pitches: number[] = [];
    for (const lines of pages) {
        const atBody = lines
            .filter((l) => snapSize(modes, l.height) === body && l.words.length > 0)
            .map((l) => ({
                y: l.words[0]?.baseline ?? 0,
                x0: Math.min(...l.words.map((w) => w.box[0])),
                x1: Math.max(...l.words.map((w) => w.box[2])),
            }));
        for (const a of atBody) {
            const below = atBody
                .filter((b) => b.y < a.y && b.x0 < a.x1 && a.x0 < b.x1)
                .sort((p, q) => q.y - p.y)[0];
            if (below !== undefined && a.y - below.y <= MAX_PITCH_SIZES * body) {
                pitches.push(a.y - below.y);
            }
        }
    }
    if (pitches.length < MIN_REFERENCE_WORDS) {
        return 1;
    }
    const factor = median(pitches) / (BODY_LEADING * body);
    return Math.min(MAX_SIZE_FACTOR, Math.max(MIN_SIZE_FACTOR, factor));
}

/** The nearest measured verdicts either side of word `i` (null where a side has none). */
function measuredNeighbours(measured: readonly (boolean | null)[], i: number): (boolean | null)[] {
    const left = measured.slice(0, i).findLast((m) => m !== null) ?? null;
    const right = measured.slice(i + 1).find((m) => m !== null) ?? null;
    return [left, right];
}

/**
 * Each word's weight on one line. The first `labelWords` words are a field
 * label, and bold. A measurable word is bold when its stroke is clearly
 * heavier than the reference and so is the nearest measurable word beside it —
 * bold running text comes in phrases, and a lone heavy word is noise. A word
 * too short to measure is bold only when every neighbour it has is (it sits
 * inside a bold phrase).
 */
export function lineWeights(words: readonly OcrWord[], reference: number, labelWords = 0): FontWeight[] {
    const measured = words.map((w) => (measurable(w) ? w.stroke >= BOLD_RATIO * reference : null));
    const supported = measured.map((m, i) =>
        m === true ? measuredNeighbours(measured, i).some((n) => n === true) : m,
    );
    return supported.map((m, i) => {
        if (i < labelWords) {
            return "bold";
        }
        if (m !== null) {
            return m ? "bold" : "normal";
        }
        const neighbours = [supported[i - 1], supported[i + 1]].filter((n) => n !== undefined);
        const bold = neighbours.length > 0 && neighbours.every((n) => n === true);
        return bold ? "bold" : "normal";
    });
}

/** The text runs of one scanned page, from its words and its re-read grid cells (see `OcrPage.cells`). */
export function scanPageRuns(
    words: readonly OcrWord[],
    cells: readonly OcrWord[],
    pageIndex: number,
    scale: ScanScale,
    renderOrderBase: number,
): RawTextRun[] {
    const lines = linesOf([...keptWords(words), ...cells]);
    const pageStrokes = strokesBySize(lines, scale.modes);
    const columnStart = columnStarts(lines);
    const references = lines.map((line) => {
        const size = snapSize(scale.modes, line.height);
        const onPage = pageStrokes.get(size) ?? [];
        return onPage.length >= MIN_REFERENCE_WORDS ? median(onPage) : (scale.strokes.get(size) ?? 0);
    });
    const measured = lines.map((line, li) =>
        // Print set light on a dark ground is display setting: bold, as a text layer would set it.
        lineWeights(line.words, references[li] ?? 0, labelOpening(line.words, scale.labels)).map(
            (weight, i): FontWeight => (line.words[i]?.reversed === true ? "bold" : weight),
        ),
    );
    const allWeights = withAlignedLabels(lines, withBoldCellRows(lines, references, measured));
    const out: RawTextRun[] = [];
    for (const [li, line] of lines.entries()) {
        const size = snapSize(scale.modes, line.height);
        const weights = allWeights[li] ?? [];
        let current: { words: OcrWord[]; weight: FontWeight } | null = null;
        const flush = (): void => {
            if (current === null) {
                return;
            }
            const first = current.words[0];
            const last = current.words.at(-1);
            if (first !== undefined && last !== undefined) {
                out.push({
                    pageIndex,
                    x: first.box[0],
                    y: first.baseline,
                    width: last.box[2] - first.box[0],
                    height: size * scale.sizeFactor,
                    text: current.words.map((w) => w.text).join(" "),
                    fontName: OCR_FONT_NAME,
                    fontSize: size * scale.sizeFactor,
                    weight: current.weight,
                    italic: false,
                    renderOrder: renderOrderBase + out.length,
                });
            }
            current = null;
        };
        const space = scale.spaces.get(size);
        const widestGap = Math.min(
            RUN_GAP_FACTOR * size,
            space === undefined || space <= 0 ? Number.POSITIVE_INFINITY : RUN_SPACE_FACTOR * space,
        );
        line.words.forEach((w, i) => {
            const weight = weights[i] ?? "normal";
            const prev = current?.words.at(-1);
            const joins =
                current !== null &&
                prev !== undefined &&
                current.weight === weight &&
                w.box[0] - prev.box[2] <= widestGap &&
                !(w.box[0] - prev.box[2] > COLUMN_GAP_SPACES * (space ?? 0) && columnStart(w));
            if (!joins) {
                flush();
                current = { words: [], weight };
            }
            current?.words.push(w);
        });
        flush();
    }
    return withBoldRows(out);
}

/** Fewest measurable words a row needs for its weight to be judged as one. */
const MIN_ROW_MEASURES = 2;

/**
 * A row of cells (several recognized lines on one baseline: a table's
 * header) whose measurable words' median stroke is bold is bold throughout
 * (judged on two such words at least: one word's stroke is no row's).
 * A header's labels are short and each measures its weight unreliably, and a
 * lone cell has no neighbour to support it, but a row is set in one weight.
 */
export function withBoldCellRows(
    lines: readonly ScanLine[],
    references: readonly number[],
    weights: readonly (readonly FontWeight[])[],
): FontWeight[][] {
    const baselineOf = (line: ScanLine): number => line.words[0]?.baseline ?? 0;
    const bold = new Set<number>();
    lines.forEach((line, li) => {
        const row = lines
            .map((other, oi) => ({ other, oi }))
            .filter(
                ({ other }) =>
                    Math.abs(baselineOf(other) - baselineOf(line)) < ROW_BASELINE_SHARE * line.height,
            );
        if (row.length < MIN_ROW_CELLS) {
            return;
        }
        const ratios = row.flatMap(({ other, oi }) => {
            const reference = references[oi] ?? 0;
            return reference > 0 ? other.words.filter(measurable).map((w) => w.stroke / reference) : [];
        });
        if (ratios.length >= MIN_ROW_MEASURES && median(ratios) >= BOLD_RATIO) {
            bold.add(li);
        }
    });
    return weights.map((w, li) => (bold.has(li) ? w.map((): FontWeight => "bold") : [...w]));
}

/** A gap this many word spaces wide may part two columns, where their starts align. */
const COLUMN_GAP_SPACES = 1.5;
/** Word starts within this many points of each other are aligned. */
const ALIGN_REACH = 2;
/** A word start aligned with this many on other lines nearby starts a column. */
const MIN_ALIGNED = 2;
/** Lines within this many of their heights above or below are nearby. */
const NEARBY_LINES = 6;

/**
 * Whether a word starts a column: other lines nearby (a table's rows) have a
 * word starting at the same place after a gap, or opening the line. Running
 * prose lines its words up only by chance and seldom more than once.
 */
function columnStarts(lines: readonly ScanLine[]): (word: OcrWord) => boolean {
    const starts = lines.flatMap((line, li) =>
        line.words.map((w, i) => ({
            li,
            x: w.box[0],
            y: w.baseline,
            opens: i === 0 || w.box[0] - (line.words[i - 1]?.box[2] ?? 0) > 0,
        })),
    );
    return (word) => {
        const reach = NEARBY_LINES * word.lineHeight;
        const lineOf = lines.findIndex((l) => l.words.includes(word));
        const aligned = new Set(
            starts
                .filter(
                    (s) =>
                        s.li !== lineOf &&
                        s.opens &&
                        Math.abs(s.x - word.box[0]) <= ALIGN_REACH &&
                        Math.abs(s.y - word.baseline) <= reach,
                )
                .map((s) => s.li),
        );
        return aligned.size >= MIN_ALIGNED;
    };
}

/** Fewest other aligned label openings, mostly bold, that make a line's label bold. */
const MIN_ALIGNED_LABELS = 2;

/**
 * Lines whose openings are labels ("Name:") aligned at one place are one
 * list's entries, set alike: where most of the others' labels measured bold,
 * a label that measured regular is bold too (its few letters measured short).
 */
export function withAlignedLabels(
    lines: readonly ScanLine[],
    weights: readonly (readonly FontWeight[])[],
): FontWeight[][] {
    const openings = lines.map((line, li) => {
        const length = labelLength(line.words);
        const first = line.words[0];
        return length === 0 || first === undefined
            ? null
            : {
                  li,
                  length,
                  x: first.box[0],
                  bold: (weights[li] ?? []).slice(0, length).every((w) => w === "bold"),
              };
    });
    return weights.map((lineWeightsOf, li) => {
        const own = openings[li];
        if (own === null || own === undefined || own.bold) {
            return [...lineWeightsOf];
        }
        const aligned = openings.filter(
            (o) => o !== null && o.li !== li && Math.abs(o.x - own.x) <= ALIGN_REACH,
        );
        const bold = aligned.filter((o) => o?.bold === true).length;
        return bold >= MIN_ALIGNED_LABELS && bold * 2 > aligned.length
            ? lineWeightsOf.map((w, i) => (i < own.length ? "bold" : w))
            : [...lineWeightsOf];
    });
}

/** Fewest cells a row must have for its weights to be read as one row's. */
const MIN_ROW_CELLS = 3;
/** Runs on one baseline within this many sizes of each other are cells of one row. */
const ROW_CELL_REACH = 3;
/** Runs whose baselines differ by under this share of their size share a baseline. */
const ROW_BASELINE_SHARE = 0.3;

/**
 * A row of several cells set mostly bold is bold throughout, and so are
 * labels set in capitals over several columns (`capitalLabelRows`): a table
 * header's short labels measure their weight least reliably (too few
 * letters), and a header is set in one weight. Only ever promotes, so a bold
 * label before regular text is left as it is.
 */
export function withBoldRows(runs: readonly RawTextRun[]): RawTextRun[] {
    const promoted = new Set<RawTextRun>();
    const placed = new Set<RawTextRun>();
    const byX = [...runs].sort((a, b) => a.x - b.x || b.y - a.y);
    for (const start of byX) {
        if (placed.has(start)) {
            continue;
        }
        const row = [start];
        placed.add(start);
        for (const r of byX) {
            const last = row.at(-1);
            if (
                last !== undefined &&
                !placed.has(r) &&
                r.x >= last.x &&
                Math.abs(r.y - start.y) < ROW_BASELINE_SHARE * start.fontSize &&
                r.x - (last.x + last.width) <= ROW_CELL_REACH * start.fontSize
            ) {
                row.push(r);
                placed.add(r);
            }
        }
        const bold = row.filter((r) => r.weight === "bold").length;
        if (row.length >= MIN_ROW_CELLS && bold * 2 > row.length) {
            for (const r of row) {
                promoted.add(r);
            }
        }
    }
    for (const r of capitalLabelRows(runs)) {
        promoted.add(r);
    }
    return runs.map((r) => (promoted.has(r) && r.weight !== "bold" ? { ...r, weight: "bold" } : r));
}

/** Fewest consecutive cells set in capitals that make a row of column labels. */
const MIN_CAPITAL_LABELS = 2;

/** A cell set wholly in capitals: a capital letter, no lower-case, two characters or more ("D100", "AP"). */
function capitalLabel(r: RawTextRun): boolean {
    const text = r.text.trim();
    return /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text) && [...text].length >= 2;
}

/**
 * The runs of each baseline's sequences of consecutive cells set in
 * capitals, however far apart: the labels over a table's columns.
 */
function capitalLabelRows(runs: readonly RawTextRun[]): RawTextRun[] {
    const out: RawTextRun[] = [];
    const placed = new Set<RawTextRun>();
    for (const start of runs) {
        if (placed.has(start)) {
            continue;
        }
        const line = runs
            .filter((r) => !placed.has(r) && Math.abs(r.y - start.y) < ROW_BASELINE_SHARE * start.fontSize)
            .sort((a, b) => a.x - b.x);
        for (const r of line) {
            placed.add(r);
        }
        let sequence: RawTextRun[] = [];
        for (const r of [...line, null]) {
            if (r !== null && capitalLabel(r)) {
                sequence.push(r);
                continue;
            }
            if (sequence.length >= MIN_CAPITAL_LABELS) {
                out.push(...sequence);
            }
            sequence = [];
        }
    }
    return out;
}
