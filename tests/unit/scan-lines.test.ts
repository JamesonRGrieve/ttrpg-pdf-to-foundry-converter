// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type GrayImage, otsuThreshold, strokeWidth } from "../../src/ocr/ink.ts";
import {
    fieldLabels,
    keptWords,
    lineWeights,
    OCR_FONT_NAME,
    scanPageRuns,
    scanScale,
    setSideways,
    sizeModes,
    snapSize,
} from "../../src/ocr/scan-lines.ts";
import type { OcrWord } from "../../src/ocr/types.ts";

/** A white image with black rectangles painted on it. */
function image(width: number, height: number, bars: [number, number, number, number][]): GrayImage {
    const pixels = new Uint8Array(width * height).fill(255);
    for (const [x0, y0, x1, y1] of bars) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                pixels[y * width + x] = 0;
            }
        }
    }
    return { pixels, width, height, stride: width };
}

function word(text: string, x: number, extra: Partial<OcrWord> = {}): OcrWord {
    const width = text.length * 5;
    return {
        text,
        confidence: 95,
        box: [x, 100, x + width, 110],
        line: 0,
        baseline: 102,
        lineHeight: 10,
        stroke: 1,
        ...extra,
    };
}

describe("ink", () => {
    it("puts the threshold between ink and paper", () => {
        const img = image(20, 20, [[0, 0, 10, 20]]);
        const t = otsuThreshold(img, { x0: 0, y0: 0, x1: 20, y1: 20 });
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(255);
    });

    it("measures a long bar's stroke as about its width", () => {
        const thin = image(40, 100, [[10, 5, 14, 95]]);
        const thick = image(40, 100, [[10, 5, 18, 95]]);
        const box = { x0: 0, y0: 0, x1: 40, y1: 100 };
        const w4 = strokeWidth(thin, box, 128);
        const w8 = strokeWidth(thick, box, 128);
        expect(w4).toBeGreaterThan(3.4);
        expect(w4).toBeLessThanOrEqual(4);
        expect(w8).toBeGreaterThan(6.8);
        expect(w8 / w4).toBeGreaterThan(1.7);
    });

    it("reads no stroke in an empty box and clips boxes to the image", () => {
        const img = image(10, 10, [[0, 0, 2, 10]]);
        expect(strokeWidth(img, { x0: 5, y0: 0, x1: 10, y1: 10 }, 128)).toBe(0);
        expect(strokeWidth(img, { x0: -5, y0: -5, x1: 50, y1: 50 }, 128)).toBeGreaterThan(0);
    });
});

describe("scan sizes", () => {
    it("finds one mode per type size despite line-to-line wobble", () => {
        const lines = [
            ...[36, 38, 40, 41, 41, 42, 44, 46].map((height) => ({ height, letters: 60 })),
            ...[61, 62, 64].map((height) => ({ height, letters: 12 })),
        ];
        const modes = sizeModes(lines);
        expect(modes).toHaveLength(2);
        expect(modes[0]).toBeGreaterThan(38);
        expect(modes[0]).toBeLessThan(44);
        expect(modes[1]).toBeGreaterThan(60);
    });

    it("snaps a line to its nearest mode and leaves far lines their own size", () => {
        expect(snapSize([40, 62], 45)).toBe(40);
        expect(snapSize([40, 62], 58)).toBe(62);
        expect(snapSize([40, 62], 100.1)).toBe(100);
    });
});

describe("scan weights", () => {
    it("marks words with clearly heavier strokes bold", () => {
        const words = [
            word("plain", 0, { stroke: 3.8 }),
            word("heavy", 40, { stroke: 5 }),
            word("strokes", 80, { stroke: 4.9 }),
            word("again", 130, { stroke: 3.7 }),
        ];
        expect(lineWeights(words, 3.8)).toEqual(["normal", "bold", "bold", "normal"]);
    });

    it("gives a word too short to measure the weight of the phrase around it", () => {
        const words = [
            word("heavy", 0, { stroke: 5 }),
            word("of", 40, { stroke: 2 }),
            word("strokes", 60, { stroke: 5 }),
            word("to", 110, { stroke: 5 }),
            word("light", 130, { stroke: 3.8 }),
        ];
        expect(lineWeights(words, 3.8)).toEqual(["bold", "bold", "bold", "normal", "normal"]);
    });

    it("leaves a lone heavy word regular, and sets a field label bold", () => {
        const words = [
            word("Label:", 0, { stroke: 3.8 }),
            word("plain", 40, { stroke: 3.8 }),
            word("heavy", 80, { stroke: 5 }),
            word("again", 120, { stroke: 3.7 }),
        ];
        expect(lineWeights(words, 3.8)).toEqual(["normal", "normal", "normal", "normal"]);
        expect(lineWeights(words, 3.8, 1)).toEqual(["bold", "normal", "normal", "normal"]);
    });

    it("finds the field labels that open several lines", () => {
        const opening = (first: string, second: string): OcrWord[] => [word(first, 0), word(second, 40)];
        const labels = fieldLabels([
            opening("Wick:", "short"),
            opening("Wick:", "long"),
            opening("wick:", "none"),
            opening("Once:", "only"),
            [word("Lamp", 0), word("Oil:", 30), word("some", 60)],
            [word("Lamp", 0), word("Oil:", 30), word("more", 60)],
            [word("Lamp", 0), word("Oil:", 30), word("none", 60)],
        ]);
        expect([...labels].sort()).toEqual(["lamp oil:", "wick:"]);
    });
});

describe("scanPageRuns", () => {
    const scale = scanScale([[word("body", 0, { stroke: 4 })]]);

    it("joins a line's words into runs at the line's snapped size", () => {
        const words = [word("one", 0, { stroke: 4 }), word("two", 18, { stroke: 4 })];
        const runs = scanPageRuns(words, 3, scale, 1000);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            pageIndex: 3,
            text: "one two",
            x: 0,
            y: 102,
            width: 33,
            fontSize: 10,
            fontName: OCR_FONT_NAME,
            weight: "normal",
            renderOrder: 1000,
        });
    });

    it("splits runs at wide gaps and at weight changes", () => {
        const words = [
            word("Heavy", 0, { stroke: 6 }),
            word("words", 30, { stroke: 6 }),
            word("value", 60, { stroke: 4 }),
            word("cell", 130, { stroke: 4 }),
        ];
        const runs = scanPageRuns(words, 0, scale, 0);
        expect(runs.map((r) => [r.text, r.weight])).toEqual([
            ["Heavy words", "bold"],
            ["value", "normal"],
            ["cell", "normal"],
        ]);
    });

    it("keeps separate recognized lines apart and drops unconfident marks", () => {
        const words = [
            word("first", 0, { stroke: 4 }),
            word("second", 0, { line: 1, baseline: 90, stroke: 4 }),
            word("~", 40, { confidence: 60 }),
        ];
        expect(keptWords(words).map((w) => w.text)).toEqual(["first", "second"]);
        // A word set on its side up a page edge is page furniture.
        const tab = word("APPENDICES", 560, { box: [560, 100, 595, 258] });
        expect(setSideways(tab)).toBe(true);
        expect(setSideways(word("I", 560, { box: [560, 100, 563, 110] }))).toBe(false);
        expect(keptWords([tab]).map((w) => w.text)).toEqual([]);
        expect(scanPageRuns(words, 0, scale, 0).map((r) => [r.text, r.y])).toEqual([
            ["first", 102],
            ["second", 90],
        ]);
    });
});
