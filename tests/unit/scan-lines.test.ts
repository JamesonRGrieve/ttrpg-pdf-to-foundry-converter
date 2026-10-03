// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type GrayImage, otsuThreshold, printStrokeWidth, strokeWidth } from "../../src/ocr/ink.ts";
import {
    fieldLabels,
    keptWords,
    notPlainlyUpright,
    lineWeights,
    OCR_FONT_NAME,
    scanPageRuns,
    scanScale,
    setSideways,
    sizeModes,
    snapSize,
    sizeFactor,
    withAlignedLabels,
    withBoldCellRows,
    withBoldRows,
} from "../../src/ocr/scan-lines.ts";
import type { OcrWord } from "../../src/ocr/types.ts";
import type { FontWeight, RawTextRun } from "../../src/types/ir.ts";

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

    it("measures light print on a dark ground as it measures dark print on a light one", () => {
        const box = { x0: 0, y0: 0, x1: 40, y1: 100 };
        const dark = image(40, 100, [[10, 5, 16, 95]]);
        const light = image(40, 100, [[0, 0, 40, 100]]);
        // A light bar 6 wide, cut out of the dark ground.
        for (let y = 5; y < 95; y++) {
            for (let x = 10; x < 16; x++) {
                light.pixels[y * 40 + x] = 255;
            }
        }
        expect(printStrokeWidth(light, box)).toBeCloseTo(printStrokeWidth(dark, box));
        expect(printStrokeWidth(dark, box)).toBeCloseTo(strokeWidth(dark, box, 128));
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
        expect(snapSize([40, 62], 42)).toBe(40);
        expect(snapSize([40, 62], 59)).toBe(62);
        // A heading a fifth above its text keeps its own size.
        expect(snapSize([40, 62], 48)).toBe(48);
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
        const runs = scanPageRuns(words, [], 3, scale, 1000);
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
        const runs = scanPageRuns(words, [], 0, scale, 0);
        expect(runs.map((r) => [r.text, r.weight])).toEqual([
            ["Heavy words", "bold"],
            ["value", "normal"],
            ["cell", "normal"],
        ]);
    });

    it("keeps separate recognized lines apart and drops unconfident marks", () => {
        const words = [
            word("first", 0, { stroke: 4 }),
            word("second", 0, { line: 1, baseline: 90, box: [0, 88, 30, 98], stroke: 4 }),
            word("~", 40, { confidence: 60 }),
        ];
        expect(keptWords(words).map((w) => w.text)).toEqual(["first", "second"]);
        // A word set on its side up a page edge is page furniture.
        const tab = word("APPENDICES", 560, { box: [560, 100, 595, 258] });
        expect(setSideways(tab)).toBe(true);
        expect(setSideways(word("I", 560, { box: [560, 100, 563, 110] }))).toBe(false);
        expect(setSideways(word("41", 200, { box: [199, 314, 213, 330] }))).toBe(false);
        // A word added to a text layer must be upright beyond doubt: a short tab word is not.
        expect(notPlainlyUpright(word("IV:", 560, { box: [560, 400, 575, 440] }))).toBe(true);
        expect(notPlainlyUpright(word("41", 200, { box: [199, 314, 213, 330] }))).toBe(true);
        expect(notPlainlyUpright(word("Lamp", 100, { box: [100, 100, 130, 110] }))).toBe(false);
        expect(keptWords([tab]).map((w) => w.text)).toEqual([]);
        // Print set light on a dark ground reads as bold.
        const header = word("NAME", 0, { line: 4, reversed: true, stroke: 1 });
        expect(scanPageRuns([header], [], 0, scale, 0).map((r) => r.weight)).toEqual(["bold"]);
        // A re-read grid cell stands as read, a low-confidence dash included.
        const dash = word("——", 40, { confidence: 41, line: 3_000_000 });
        expect(scanPageRuns([], [dash], 0, scale, 0).map((r) => r.text)).toEqual(["——"]);
        // A ruled box edge read as a glyph is dropped; a cell put on the label
        // row's line above it is set on its own box's foot.
        const cell = word("41", 0, { box: [0, 70, 12, 86], baseline: 86, line: 2 });
        expect(keptWords([word("|", 20, { confidence: 90 }), cell]).map((w) => [w.text, w.baseline])).toEqual(
            [["41", 70]],
        );
        expect(scanPageRuns(words, [], 0, scale, 0).map((r) => [r.text, r.y])).toEqual([
            ["first", 102],
            ["second", 90],
        ]);
    });
});

describe("withBoldRows", () => {
    const cell = (text: string, x: number, y: number, weight: "bold" | "normal"): RawTextRun => ({
        pageIndex: 0,
        x,
        y,
        width: 6 * text.length,
        height: 10,
        text,
        fontName: OCR_FONT_NAME,
        fontSize: 10,
        weight,
        italic: false,
        renderOrder: 0,
    });

    it("sets a row of cells mostly bold in bold throughout, and leaves other rows alone", () => {
        const runs = [
            cell("NAME", 50, 500, "normal"),
            cell("CLASS", 100, 500, "bold"),
            cell("DAM", 150, 500, "bold"),
            // A bold label before regular text: too few cells to judge as a row.
            cell("Gear:", 50, 480, "bold"),
            cell("a lamp", 85, 480, "normal"),
            // Mostly regular cells stay as they are.
            cell("Lamp", 50, 460, "normal"),
            cell("Melee", 100, 460, "normal"),
            cell("2", 150, 460, "bold"),
            // A row of capital labels is a header, however its weights measured.
            cell("WT", 50, 440, "normal"),
            cell("AP", 75, 440, "normal"),
            cell("AVAILABILITY", 100, 440, "normal"),
        ];
        expect(withBoldRows(runs).map((r) => r.weight)).toEqual([
            "bold",
            "bold",
            "bold",
            "bold",
            "normal",
            "normal",
            "normal",
            "bold",
            "bold",
            "bold",
            "bold",
        ]);
    });
});

describe("sizeFactor", () => {
    /** A body line of words at `size`, its baseline at `y`, spanning x 50–250. */
    const line = (y: number, size: number) => ({
        height: size,
        words: [word("words", 50, { baseline: y, box: [50, y, 250, y + size], lineHeight: size })],
    });

    it("scales measured sizes so the body text's line pitch is its usual leading", () => {
        // Measured 8, set 12 apart: a 10-point body at 1.2 leading.
        const lines = Array.from({ length: 10 }, (_, i) => line(700 - 12 * i, 8));
        expect(sizeFactor([lines], [8])).toBeCloseTo(1.25);
    });

    it("is 1 with too few lines to tell, and keeps within its bounds", () => {
        expect(sizeFactor([[line(700, 8), line(688, 8)]], [8])).toBe(1);
        const loose = Array.from({ length: 10 }, (_, i) => line(700 - 19 * i, 8));
        expect(sizeFactor([loose], [8])).toBe(1.4);
    });
});

describe("withAlignedLabels", () => {
    const labelled = (label: string, x: number, y: number) => ({
        height: 10,
        words: [word(label, x, { baseline: y }), word("text", x + 40, { baseline: y })],
    });

    it("sets a regular label bold where the labels aligned with it are mostly bold", () => {
        const lines = [
            labelled("Skin:", 100, 600),
            labelled("Eyes:", 100, 580),
            labelled("Voice:", 100, 560),
        ];
        const weights = withAlignedLabels(lines, [
            ["bold", "normal"],
            ["normal", "normal"],
            ["bold", "normal"],
        ]);
        expect(weights[1]).toEqual(["bold", "normal"]);
    });

    it("leaves a label alone among regular ones or with no aligned labels", () => {
        const lines = [
            labelled("Skin:", 100, 600),
            labelled("Eyes:", 300, 580),
            labelled("Voice:", 100, 560),
        ];
        const weights = withAlignedLabels(lines, [
            ["normal", "normal"],
            ["normal", "normal"],
            ["normal", "normal"],
        ]);
        expect(weights).toEqual([
            ["normal", "normal"],
            ["normal", "normal"],
            ["normal", "normal"],
        ]);
    });
});

describe("withBoldCellRows", () => {
    const cellLine = (text: string, x: number, y: number, stroke: number) => ({
        height: 10,
        words: [word(text, x, { baseline: y, stroke })],
    });

    it("sets a row of cells bold when their median stroke is bold, whatever each measured", () => {
        const lines = [
            cellLine("Name", 50, 500, 1.15),
            cellLine("Class", 100, 500, 1.25),
            cellLine("Special", 150, 500, 1.3),
            cellLine("Pistol", 50, 480, 1.0),
            cellLine("Basic", 100, 480, 1.05),
            cellLine("Tearing", 150, 480, 0.95),
        ];
        const references = lines.map(() => 1);
        const measured = lines.map((): FontWeight[] => ["normal"]);
        const weights = withBoldCellRows(lines, references, measured);
        expect(weights.map((w) => w[0])).toEqual(["bold", "bold", "bold", "normal", "normal", "normal"]);
    });

    it("leaves a row with a single measurable word as measured", () => {
        const lines = [
            cellLine("1kg", 50, 500, 1.4),
            cellLine("Rare", 100, 500, 1.4),
            cellLine("OF", 150, 500, 1.4),
        ];
        const measured = lines.map((): FontWeight[] => ["normal"]);
        const weights = withBoldCellRows(lines, [1, 1, 1], measured).map((w) => w[0]);
        expect(weights).toEqual(["normal", "normal", "normal"]);
    });

    it("leaves a line on its own baseline as measured", () => {
        const lines = [cellLine("Heading", 50, 500, 1.4)];
        expect(withBoldCellRows(lines, [1], [["normal"]])).toEqual([["normal"]]);
    });
});
