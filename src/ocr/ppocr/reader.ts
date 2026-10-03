// SPDX-License-Identifier: AGPL-3.0-or-later
import { PINS } from "../../pins.ts";
import { CAP_QUANTILE, coreBand, type PixelBox, printPolarity, printStrokeWidth } from "../ink.ts";
import { pixelBoxToPdf } from "../render.ts";
import type { OcrWord, RenderedPage } from "../types.ts";
import { DETECT_SCALE, detectionInput, textBoxes } from "./detect.ts";
import {
    type DecodedSymbol,
    decodeLine,
    LINE_HEIGHT,
    lineInput,
    lineWords,
    withoutRaisedMarks,
    withPrintedSpaces,
} from "./read-line.ts";

/**
 * The PP-OCR page reader: a text-line detector and a line recognizer, two
 * ONNX networks run in an injected session (the same WebAssembly runtime,
 * one thread, in the CLI and the browser, so both read alike). It reads
 * print set over art, on tinted grounds and in display faces far better
 * than the Tesseract passes, so it is the first reading of a page with no
 * text layer.
 */

/** A float tensor: its values, row-major, and its shape. */
export interface FloatTensor {
    data: Float32Array;
    dims: readonly number[];
}

/** One network, run on one float tensor. */
export interface TensorSession {
    run(input: Float32Array, dims: readonly number[]): Promise<FloatTensor>;
}

/** A recognizer that reads a whole rendered page into words. */
export interface PageReader {
    /** Changes whenever anything that can change its output changes; keys its cache. */
    readonly id: string;
    read(page: RenderedPage): Promise<OcrWord[]>;
}

/** The model files (in the pinned models package) and how they are read. */
export const PPOCR_MODELS = {
    detector: "ch_PP-OCRv4_det_infer.onnx",
    recognizer: "ch_PP-OCRv4_rec_infer.onnx",
    alphabet: "ppocr_keys_v1.txt",
} as const;

/** Bump when the reader's own pre- or post-processing changes. */
const READER_REVISION = 19;

export const PPOCR_READER_ID = [
    `ppocr@${PINS["@gutenye/ocr-models"]}/${PPOCR_MODELS.detector}+${PPOCR_MODELS.recognizer}`,
    `ort@${PINS["onnxruntime-web"]}/wasm1`,
    `det/${DETECT_SCALE}`,
    `rec${LINE_HEIGHT}`,
    `r${READER_REVISION}`,
].join("+");

/** The x-height as a share of the type size (an em), across common text faces. */
const X_HEIGHT_EM = 0.48;
/** The cap height (and digit height) as a share of the type size. */
const CAP_HEIGHT_EM = 0.7;
/** A detected line box's height as a share of the type size (the detector pads the print). */
const BOX_EM = 1.45;
/** Fewest letters or digits a line needs for its print to measure its size. */
const MIN_MEASURED_SYMBOLS = 3;
/** Letters with no ascender or descender: their tops are the x-height. */
const X_HEIGHT_LETTERS = /[acemnorsuvwxz]/u;
/** Letters reaching the cap line: capitals, digits, ascenders. */
const TALL_LETTERS = /[\p{Lu}\p{N}bdfhklt]/gu;
/** Quantile of column tops that is the cap line of text read wholly in capitals (see `coreBand`). */
const SMALL_CAPS_CAP_QUANTILE = 0.03;
/** Fewest tall letters that mark a line's cap line (see `coreBand`'s quantile). */
const MIN_TALL_LETTERS = 2;

/** The recognizer's alphabet from its key file: one symbol per line, then the word separator. */
export function alphabetOf(keys: string): string[] {
    return [...keys.split("\n").filter((line) => line.length > 0), " "];
}

/** A line's type size and baseline (page pixels), from its print. */
interface PrintSize {
    em: number;
    baseline: number;
}

interface ReadLine {
    box: PixelBox;
    steps: number;
    symbols: DecodedSymbol[];
    /** Null when the line has too few letters or digits to measure. */
    print: PrintSize | null;
}

/**
 * Size and baseline from the print itself (the line box's height follows the
 * detector's padding, which varies with line length): the x-height of
 * lower-case text, else the cap height. Null for a line too short to measure.
 */
function printSize(page: RenderedPage, box: PixelBox, symbols: readonly DecodedSymbol[]): PrintSize | null {
    const text = symbols.map((s) => s.text).join("");
    if ((text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < MIN_MEASURED_SYMBOLS) {
        return null;
    }
    // Text read wholly in capitals may be set in small capitals: its few full
    // capitals, not the small ones, mark the cap line.
    const capitalsOnly = !/\p{Ll}/u.test(text);
    const band = coreBand(page.image, box, capitalsOnly ? SMALL_CAPS_CAP_QUANTILE : CAP_QUANTILE);
    if (band === null) {
        return null;
    }
    // The cap line (capitals, digits, ascenders all reach it) where the text
    // has tall letters enough to mark it; else the x-height, where the print
    // shows one.
    const tall = text.match(TALL_LETTERS)?.length ?? 0;
    const em =
        tall < MIN_TALL_LETTERS && X_HEIGHT_LETTERS.test(text) && band.xTop !== null
            ? (band.baseline - band.xTop) / X_HEIGHT_EM
            : (band.baseline - band.capTop) / CAP_HEIGHT_EM;
    return { em, baseline: band.baseline };
}

/** Fewest lines on one baseline that make a row of cells sized alike. */
const MIN_ROW_LINES = 3;

/** Whether two line boxes share a row: each spans the other's middle. */
function sameRow(a: PixelBox, b: PixelBox): boolean {
    const middle = (box: PixelBox): number => (box.y0 + box.y1) / 2;
    return a.y0 <= middle(b) && middle(b) < a.y1 && b.y0 <= middle(a) && middle(a) < b.y1;
}

/**
 * Each measured line's size as its row's median: the cells of a table row
 * are set alike, and a short cell's few letters measure least reliably.
 */
function rowSizes(lines: readonly ReadLine[]): ReadLine[] {
    return lines.map((line) => {
        if (line.print === null) {
            return line;
        }
        const ems = lines
            .filter((l) => l.print !== null && sameRow(l.box, line.box))
            .map((l) => l.print?.em ?? 0)
            .sort((a, b) => a - b);
        // Two lines on one baseline are as likely a page's two columns as a row's cells.
        if (ems.length < MIN_ROW_LINES) {
            return line;
        }
        return { ...line, print: { ...line.print, em: ems[Math.floor(ems.length / 2)] ?? line.print.em } };
    });
}

/** The print size of the nearest measured line whose box spans this line's middle. */
function beside(line: ReadLine, lines: readonly ReadLine[]): PrintSize | null {
    const middle = (line.box.y0 + line.box.y1) / 2;
    const near = lines
        .filter((l) => l.print !== null && l.box.y0 <= middle && middle < l.box.y1)
        .sort(
            (a, b) =>
                Math.abs(a.box.x0 - line.box.x0) - Math.abs(b.box.x0 - line.box.x0) || a.box.y0 - b.box.y0,
        )[0];
    return near?.print ?? null;
}

/** A size and baseline from the line box alone, centred in its padding. */
function fallbackSize(box: PixelBox): PrintSize {
    const em = (box.y1 - box.y0) / BOX_EM;
    return { em, baseline: Math.round(box.y1 - (box.y1 - box.y0 - em) / 2) };
}

export class PpOcrReader implements PageReader {
    readonly id = PPOCR_READER_ID;
    readonly #detector: TensorSession;
    readonly #recognizer: TensorSession;
    readonly #alphabet: readonly string[];
    /** The read in progress: a session runs one call at a time, so reads queue behind it. */
    #queue: Promise<unknown> = Promise.resolve();

    constructor(detector: TensorSession, recognizer: TensorSession, alphabet: readonly string[]) {
        this.#detector = detector;
        this.#recognizer = recognizer;
        this.#alphabet = alphabet;
    }

    read(page: RenderedPage): Promise<OcrWord[]> {
        const next = this.#queue.then(() => this.#read(page));
        this.#queue = next.catch(() => undefined);
        return next;
    }

    async #read(page: RenderedPage): Promise<OcrWord[]> {
        const input = detectionInput(page.image);
        const detected = await this.#detector.run(input.data, [1, 3, input.height, input.width]);
        const boxes = textBoxes(detected.data, input.width, input.height, {
            width: page.widthPx,
            height: page.heightPx,
        });
        const lines: ReadLine[] = [];
        for (const box of boxes) {
            const lineIn = lineInput(page.image, box);
            const read = await this.#recognizer.run(lineIn.data, [1, 3, LINE_HEIGHT, lineIn.width]);
            const [, steps = 0, classes = 0] = read.dims;
            const symbols = withPrintedSpaces(
                withoutRaisedMarks(
                    decodeLine(read.data, steps, classes, this.#alphabet),
                    steps,
                    box,
                    page.image,
                ),
                steps,
                box,
                page.image,
            );
            lines.push({ box, steps, symbols, print: printSize(page, box, symbols) });
        }
        const [, , , top] = page.viewBox;
        const words: OcrWord[] = [];
        const sized = rowSizes(lines);
        for (const [line, read] of sized.entries()) {
            const { box } = read;
            // A line too short to measure (a dash, a lone digit) takes the
            // size and baseline of a measured line beside it on its row.
            const print = read.print ?? beside(read, sized) ?? fallbackSize(box);
            for (const w of lineWords(read.symbols, read.steps, box, page.image)) {
                const pdfBox = pixelBoxToPdf(page, w.box.x0, w.box.y0, w.box.x1, w.box.y1);
                words.push({
                    text: w.text,
                    confidence: w.confidence,
                    box: pdfBox,
                    line,
                    baseline: top - print.baseline / page.scale,
                    lineHeight: print.em / page.scale,
                    stroke: printStrokeWidth(page.image, w.box) / page.scale,
                    ...(printPolarity(page.image, w.box) === "light" ? { reversed: true as const } : {}),
                });
            }
        }
        return words;
    }
}
