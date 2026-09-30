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
/** Half-width, in bins, of the window that smooths the height histogram (≈±10%). */
const MODE_WINDOW = 5;
/** A size mode must hold at least this share of the document's letters. */
const MIN_MODE_SHARE = 0.02;
/** A line snaps to a mode within this log distance (≈±20%); else it keeps its own height. */
const SNAP_REACH = Math.log(1.2);
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

const HAS_ALNUM = /[\p{L}\p{N}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

function letters(text: string): number {
    return text.match(LETTER_OR_DIGIT)?.length ?? 0;
}

/**
 * A word of several letters whose box is taller than wide is set on its side
 * (a thumb tab running up a page edge): page furniture, as a text layer's
 * sideways runs are, never a line of the page's text.
 */
export function setSideways(word: OcrWord): boolean {
    const [x0, y0, x1, y1] = word.box;
    return word.text.length > 1 && y1 - y0 > x1 - x0;
}

/** The words of a scanned page worth keeping: confident enough for what they are, and set across. */
export function keptWords(words: readonly OcrWord[]): OcrWord[] {
    return words.filter(
        (w) =>
            !setSideways(w) &&
            (HAS_ALNUM.test(w.text)
                ? w.confidence >= SCAN_WORD_CONFIDENCE
                : w.confidence >= SCAN_SYMBOL_CONFIDENCE),
    );
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort(numAsc);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** One recognized line: its words left to right, and its measured height. */
interface ScanLine {
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
    const lines = pages.flatMap((words) => linesOf(keptWords(words)));
    const modes = sizeModes(
        lines.map((l) => ({ height: l.height, letters: l.words.reduce((n, w) => n + letters(w.text), 0) })),
    );
    const strokes = new Map<number, number>();
    for (const [size, values] of strokesBySize(lines, modes)) {
        if (values.length > 0) {
            strokes.set(size, median(values));
        }
    }
    return { modes, strokes, labels: fieldLabels(lines.map((l) => l.words)) };
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

/** The text runs of one scanned page. */
export function scanPageRuns(
    words: readonly OcrWord[],
    pageIndex: number,
    scale: ScanScale,
    renderOrderBase: number,
): RawTextRun[] {
    const lines = linesOf(keptWords(words));
    const pageStrokes = strokesBySize(lines, scale.modes);
    const out: RawTextRun[] = [];
    for (const line of lines) {
        const size = snapSize(scale.modes, line.height);
        const onPage = pageStrokes.get(size) ?? [];
        const reference =
            onPage.length >= MIN_REFERENCE_WORDS ? median(onPage) : (scale.strokes.get(size) ?? 0);
        const weights = lineWeights(line.words, reference, labelOpening(line.words, scale.labels));
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
                    height: size,
                    text: current.words.map((w) => w.text).join(" "),
                    fontName: OCR_FONT_NAME,
                    fontSize: size,
                    weight: current.weight,
                    italic: false,
                    renderOrder: renderOrderBase + out.length,
                });
            }
            current = null;
        };
        line.words.forEach((w, i) => {
            const weight = weights[i] ?? "normal";
            const prev = current?.words.at(-1);
            const joins =
                current !== null &&
                prev !== undefined &&
                current.weight === weight &&
                w.box[0] - prev.box[2] <= RUN_GAP_FACTOR * size;
            if (!joins) {
                flush();
                current = { words: [], weight };
            }
            current?.words.push(w);
        });
        flush();
    }
    return out;
}
