// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { scanPageSummary } from "../../src/ocr/recognize.ts";
import type { OcrWord } from "../../src/ocr/types.ts";

const word = (confidence: number): OcrWord => ({
    text: "lamp",
    confidence,
    box: [0, 0, 10, 10],
    line: 0,
    baseline: 0,
    lineHeight: 10,
    stroke: 1,
});

describe("the log line for a scanned page", () => {
    it("names each pass by what it reads, what it added, and the kept words' mean confidence", () => {
        expect(scanPageSummary(4, 120, [3, 0, 2, 1], [word(90), word(80), word(70)])).toBe(
            "scanned page p5: PP-OCRv4 (Latin and Chinese script) read 120 words; Tesseract +3, Tesseract sparse +0, " +
                "Tesseract sparse on a binarized copy +2, Tesseract on an inverted copy +1; 3 kept, mean confidence 80",
        );
    });

    it("reports a page nothing could read as such", () => {
        expect(scanPageSummary(0, 0, [0, 0, 0, 0], [])).toContain("0 kept, mean confidence 0");
    });
});
