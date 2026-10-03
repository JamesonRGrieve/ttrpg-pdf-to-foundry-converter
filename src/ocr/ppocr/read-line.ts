// SPDX-License-Identifier: AGPL-3.0-or-later
import { type GrayImage, type PixelBox, printTest, trimToInk } from "../ink.ts";

/**
 * Line recognition for the PP-OCR reader (a CTC network). A detected line is
 * cut from the page, scaled to the network's input height and read as a
 * sequence of time steps, each a probability over the alphabet plus a blank;
 * the text is the run of most probable symbols with repeats and blanks
 * dropped. Each kept symbol's step places it along the line, which gives every
 * word its own box. Pre- and post-processing only: plain arithmetic, identical
 * in every runtime.
 */

/** The recognizer's input height (pixels). */
export const LINE_HEIGHT = 48;
/** Widest input read in one go (pixels); a longer line is squeezed to it. */
const MAX_LINE_WIDTH = 3840;
const CHANNELS = 3;
const PAPER = 255;
/** Index of the CTC blank in the network's output. */
const BLANK = 0;
/** The alphabet's word separator. */
const SPACE = " ";

export interface LineInput {
    /** Planar RGB in [-1, 1], `[1, 3, LINE_HEIGHT, width]`. */
    data: Float32Array;
    width: number;
}

/** The gray value at fractional pixel `(x, y)`, interpolated between its four neighbours. */
function sample(image: GrayImage, x: number, y: number): number {
    const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, x - x0));
    const fy = Math.max(0, Math.min(1, y - y0));
    const at = (px: number, py: number): number => image.pixels[py * image.stride + px] ?? PAPER;
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    return top * (1 - fy) + bottom * fy;
}

/** The recognizer's input for one line: `box` cut from `image`, scaled to `LINE_HEIGHT`, normalized. */
export function lineInput(image: GrayImage, box: PixelBox): LineInput {
    const boxWidth = box.x1 - box.x0;
    const boxHeight = box.y1 - box.y0;
    const width = Math.max(1, Math.min(MAX_LINE_WIDTH, Math.round((LINE_HEIGHT * boxWidth) / boxHeight)));
    const plane = LINE_HEIGHT * width;
    const data = new Float32Array(CHANNELS * plane);
    for (let y = 0; y < LINE_HEIGHT; y++) {
        // Pixel centres map to pixel centres.
        const sy = box.y0 + ((y + 0.5) * boxHeight) / LINE_HEIGHT - 0.5;
        for (let x = 0; x < width; x++) {
            const sx = box.x0 + ((x + 0.5) * boxWidth) / width - 0.5;
            const v = (sample(image, sx, sy) / PAPER - 0.5) / 0.5;
            for (let c = 0; c < CHANNELS; c++) {
                data[c * plane + y * width + x] = v;
            }
        }
    }
    return { data, width };
}

export interface DecodedSymbol {
    text: string;
    /** The time step it was read at. */
    step: number;
    /** Its probability there, 0–1. */
    confidence: number;
}

/**
 * Greedy CTC decoding of a `steps` × `classes` probability matrix: at each
 * step the most probable class (the first on a tie), a repeat of the previous
 * step's class or a blank dropped. Class `i > 0` is `alphabet[i - 1]`.
 */
export function decodeLine(
    probabilities: Float32Array,
    steps: number,
    classes: number,
    alphabet: readonly string[],
): DecodedSymbol[] {
    const out: DecodedSymbol[] = [];
    let previous = BLANK;
    for (let t = 0; t < steps; t++) {
        let best = 0;
        let bestP = Number.NEGATIVE_INFINITY;
        for (let c = 0; c < classes; c++) {
            const p = probabilities[t * classes + c] ?? 0;
            if (p > bestP) {
                best = c;
                bestP = p;
            }
        }
        if (best !== BLANK && best !== previous) {
            out.push({ text: alphabet[best - 1] ?? "", step: t, confidence: bestP });
        }
        previous = best;
    }
    return out;
}

/** A raised mark's ink ends above this share of its line's height (from the top). */
const RAISED_SHARE = 0.55;
/** Time steps either side of a symbol's own that its glyph's ink may lie in. */
const SYMBOL_REACH = 1;

/**
 * The symbols without the reference marks raised after a word (a dagger, a
 * note number): a word's last symbol read as a letter or digit whose ink in
 * its stretch of the line lies wholly in the line's upper part. The
 * recognizer has no such marks in its alphabet and reads them as letters
 * ("Lamp†" as "Lampt"); a text layer sets them as superscripts, read apart.
 */
export function withoutRaisedMarks(
    symbols: readonly DecodedSymbol[],
    steps: number,
    box: PixelBox,
    image: GrayImage,
): DecodedSymbol[] {
    const stepWidth = (box.x1 - box.x0) / Math.max(1, steps);
    const ink = printTest(image, box).ink;
    // A column's lowest ink row in the line, or -1 when it holds none.
    const lowestInk = (x: number): number => {
        for (let y = box.y1 - 1; y >= box.y0; y--) {
            if (ink(image.pixels[y * image.stride + x] ?? PAPER)) {
                return y;
            }
        }
        return -1;
    };
    // The last glyph is the rightmost run of inked columns in the symbol's
    // stretch, left of `limit` (where a mark already taken off began). Its
    // first column, when it is a raised mark; else null.
    const raisedMarkAt = (s: DecodedSymbol, limit: number): number | null => {
        const x0 = Math.max(box.x0, Math.floor(box.x0 + (s.step - SYMBOL_REACH) * stepWidth));
        const x1 = Math.min(limit, Math.ceil(box.x0 + (s.step + 1 + SYMBOL_REACH) * stepWidth));
        let x = x1 - 1;
        while (x >= x0 && lowestInk(x) < 0) {
            x--;
        }
        if (x < x0) {
            return null;
        }
        let lowest = -1;
        while (x >= x0 && lowestInk(x) >= 0) {
            lowest = Math.max(lowest, lowestInk(x));
            x--;
        }
        return lowest < box.y0 + RAISED_SHARE * (box.y1 - box.y0) ? x + 1 : null;
    };
    const out: DecodedSymbol[] = [];
    // A word's raised marks come off its end one by one ("††" read as "tt").
    const endWord = (): void => {
        let limit = box.x1;
        for (;;) {
            const last = out.at(-1);
            const before = out.at(-2);
            const inWord = before !== undefined && before.text !== SPACE;
            const mark =
                last !== undefined && inWord && /^[\p{L}\p{N}]$/u.test(last.text)
                    ? raisedMarkAt(last, limit)
                    : null;
            if (mark === null) {
                return;
            }
            out.pop();
            limit = mark;
        }
    };
    for (const s of symbols) {
        if (s.text === SPACE) {
            endWord();
        }
        out.push(s);
    }
    endWord();
    return out;
}

/** Hyphens and dashes, which join the words either side. */
const HYPHENS = /^[-‐‑‒–—]$/u;
/** A blank gap this many times the line's typical gap between glyphs is a word space… */
const SPACE_GAP_FACTOR = 2.5;
/** …and at least this share of the line's height. */
const MIN_SPACE_SHARE = 0.25;

/**
 * The symbols with a word space wherever the print shows one the recognizer
 * passed over ("TABLE3-1:WAYFARERGEAR"): a run of blank columns much wider than
 * the line's typical gap between glyphs, with no separator read near it,
 * gets one between the symbols either side.
 */
export function withPrintedSpaces(
    symbols: readonly DecodedSymbol[],
    steps: number,
    box: PixelBox,
    image: GrayImage,
): DecodedSymbol[] {
    const ink = printTest(image, box).ink;
    const inked: boolean[] = [];
    for (let x = box.x0; x < box.x1; x++) {
        let any = false;
        for (let y = box.y0; y < box.y1 && !any; y++) {
            any = ink(image.pixels[y * image.stride + x] ?? PAPER);
        }
        inked.push(any);
    }
    // Blank runs between ink, as [start, end) column offsets.
    const gaps: [number, number][] = [];
    const first = inked.indexOf(true);
    const last = inked.lastIndexOf(true);
    for (let x = first; x >= 0 && x < last; x++) {
        if (!inked[x]) {
            const start = x;
            while (x < last && !inked[x]) {
                x++;
            }
            gaps.push([start, x]);
        }
    }
    if (gaps.length === 0) {
        return [...symbols];
    }
    const widths = gaps.map(([a, b]) => b - a).sort((a, b) => a - b);
    const typical = widths[Math.floor(widths.length / 2)] ?? 0;
    const minimum = Math.max(SPACE_GAP_FACTOR * typical, MIN_SPACE_SHARE * (box.y1 - box.y0));
    const stepWidth = (box.x1 - box.x0) / Math.max(1, steps);
    const centre = (s: DecodedSymbol): number => (s.step + 0.5) * stepWidth;
    const out = [...symbols];
    for (const [a, b] of gaps.filter(([a, b]) => b - a >= minimum)) {
        const middle = (a + b) / 2;
        const after = out.findIndex((s) => centre(s) > middle);
        const before = out[after - 1];
        const next = out[after];
        if (after <= 0 || before === undefined || next === undefined) {
            continue;
        }
        // A hyphen is short: the blank beside it is wide, but it joins its word.
        if (
            before.text === SPACE ||
            next.text === SPACE ||
            HYPHENS.test(before.text) ||
            HYPHENS.test(next.text)
        ) {
            continue;
        }
        // Only where the gap lies between the two symbols' places on the line.
        if (centre(before) < b && centre(next) > a) {
            out.splice(after, 0, {
                text: SPACE,
                step: Math.floor(middle / stepWidth),
                confidence: next.confidence,
            });
        }
    }
    return out;
}

export interface LineWord {
    text: string;
    /** Mean symbol probability, 0–100. */
    confidence: number;
    /** The word's extent along the line, in page pixels (the line's own top and bottom). */
    box: PixelBox;
}

/**
 * The words of a decoded line: symbols between separators. Each word's
 * stretch of the line runs from midway between its first symbol's step and
 * the previous word's last, to midway between its last and the next word's
 * first (the line's ends for the first and last word), trimmed to the columns
 * its print fills — so gaps between words are the printed gaps.
 */
export function lineWords(
    symbols: readonly DecodedSymbol[],
    steps: number,
    box: PixelBox,
    image: GrayImage,
): LineWord[] {
    const stepWidth = (box.x1 - box.x0) / Math.max(1, steps);
    const groups: DecodedSymbol[][] = [[]];
    for (const s of symbols) {
        if (s.text === SPACE) {
            groups.push([]);
        } else {
            groups.at(-1)?.push(s);
        }
    }
    const words = groups.filter((w) => w.length > 0);
    const at = (step: number): number => box.x0 + step * stepWidth;
    return words.map((w, i) => {
        const first = w[0]?.step ?? 0;
        const last = w.at(-1)?.step ?? 0;
        const before = words[i - 1]?.at(-1)?.step;
        const after = words[i + 1]?.[0]?.step;
        const stretch = {
            x0: before === undefined ? box.x0 : Math.floor(at((before + 1 + first) / 2)),
            y0: box.y0,
            x1: after === undefined ? box.x1 : Math.ceil(at((last + 1 + after) / 2)),
            y1: box.y1,
        };
        return {
            text: w.map((s) => s.text).join(""),
            confidence: (100 * w.reduce((sum, s) => sum + s.confidence, 0)) / w.length,
            box: trimToInk(image, stretch, box),
        };
    });
}
