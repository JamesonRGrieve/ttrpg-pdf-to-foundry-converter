// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GrayImage } from "./ink.ts";

/**
 * The OCR layer's contracts. OCR exists because PDF text layers carry errors
 * (custom glyph encodings, letter-spaced display faces, split drop caps, text
 * painted as outlines or images); the engine renders each page and reads it back
 * so arbitration can correct the text layer from what is actually printed.
 */

/** Axis-aligned box in PDF user space, origin bottom-left: `[x0, y0, x1, y1]`. */
export type PdfBox = readonly [number, number, number, number];

/** One recognized word, already mapped from image pixels into PDF user space. */
export interface OcrWord {
    text: string;
    /** Engine confidence, 0–100. */
    confidence: number;
    box: PdfBox;
    /** Page-unique ordinal of the recognized line holding the word. */
    line: number;
    /** That line's baseline (PDF y) under the word's centre. */
    baseline: number;
    /** That line's row height as recognition measured it (PDF units). */
    lineHeight: number;
    /** Stroke width of the word's ink (PDF units); see `strokeWidth`. */
    stroke: number;
}

export interface OcrPage {
    pageIndex: number;
    words: OcrWord[];
}

/** A rendered page ready for recognition. */
export interface RenderedPage {
    pageIndex: number;
    /** Encoded PNG of the page (8-bit grayscale). */
    png: Uint8Array;
    /** The same pixels, decoded, for ink measurements. */
    image: GrayImage;
    widthPx: number;
    heightPx: number;
    /** Pixels per PDF point. */
    scale: number;
    /** Page view box in PDF user space — the render origin. */
    viewBox: PdfBox;
}

/**
 * A pluggable recognizer. `id` must change whenever anything that can change
 * its output changes (engine build, model data, recognition parameters): it
 * keys the OCR cache and is recorded in pack provenance.
 */
export interface OcrEngine {
    readonly id: string;
    recognize(page: RenderedPage): Promise<OcrWord[]>;
    close(): Promise<void>;
}
