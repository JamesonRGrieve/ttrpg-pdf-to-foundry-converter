// SPDX-License-Identifier: AGPL-3.0-or-later
import { PINS } from "../pins.ts";
import { pixelBoxToPdf } from "./render.ts";
import type { OcrWord, RenderedPage } from "./types.ts";

/**
 * The embedded OCR configuration shared by the Node and in-browser engines.
 * Both run the same pinned tesseract.js build on the same pinned WASM core
 * (plain SIMD + LSTM — relaxed-SIMD arithmetic is implementation-defined and
 * would make results CPU-dependent) with the same model data and parameters,
 * so a page reads identically in either runtime. Everything that can change the
 * output is folded into the engine id.
 */

/** Core build, without extension (`.js` for Node, `.wasm.js` for browsers). */
export const CORE_BUILD = "tesseract-core-simd-lstm";
/** Integer-quantized "best" LSTM model: the accurate variant, still CPU-fast. */
export const MODEL_VARIANT = "4.0.0_best_int";
export const MODEL_PACKAGE = "@tesseract.js-data/eng";
export const LANGUAGE = "eng";
/** Tesseract page segmentation: fully automatic. */
export const PAGE_SEG_MODE = "3";

export function recognitionParams(dpi: number): Record<string, string> {
    return {
        tessedit_pageseg_mode: PAGE_SEG_MODE,
        preserve_interword_spaces: "0",
        user_defined_dpi: String(dpi),
    };
}

export function tesseractEngineId(dpi: number): string {
    return [
        `tesseract.js@${PINS["tesseract.js"]}`,
        `core@${PINS["tesseract.js-core"]}/simd-lstm`,
        `${MODEL_PACKAGE}@${PINS[MODEL_PACKAGE]}/${MODEL_VARIANT}`,
        `psm${PAGE_SEG_MODE}`,
        `dpi${dpi}`,
    ].join("+");
}

/** The subset of tesseract.js's result shape the engine reads. */
export interface TesseractBlocks {
    blocks:
        | {
              paragraphs: {
                  lines: {
                      words: {
                          text: string;
                          confidence: number;
                          bbox: { x0: number; y0: number; x1: number; y1: number };
                      }[];
                  }[];
              }[];
          }[]
        | null;
}

/** Recognized words → OCR words in PDF user space. */
export function wordsFromBlocks(data: TesseractBlocks, page: RenderedPage): OcrWord[] {
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
            for (const line of paragraph.lines) {
                for (const word of line.words) {
                    const text = word.text.trim();
                    if (text.length === 0) {
                        continue;
                    }
                    const { x0, y0, x1, y1 } = word.bbox;
                    words.push({
                        text,
                        confidence: word.confidence,
                        box: pixelBoxToPdf(page, x0, y0, x1, y1),
                    });
                }
            }
        }
    }
    return words;
}
