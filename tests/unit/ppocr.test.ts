// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { GrayImage } from "../../src/ocr/ink.ts";
import { DETECT_SCALE, detectionInput, textBoxes } from "../../src/ocr/ppocr/detect.ts";
import {
    decodeLine,
    LINE_HEIGHT,
    lineInput,
    lineWords,
    withoutRaisedMarks,
    withPrintedSpaces,
} from "../../src/ocr/ppocr/read-line.ts";
import { alphabetOf } from "../../src/ocr/ppocr/reader.ts";

function gray(width: number, height: number, value: (x: number, y: number) => number): GrayImage {
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            pixels[y * width + x] = value(x, y);
        }
    }
    return { pixels, width, height, stride: width };
}

describe("detectionInput", () => {
    it("halves the page by block means, pads to the stride with paper and normalizes per channel", () => {
        // A 4×2 page: a black 2×2 block, then a white one.
        const input = detectionInput(gray(4, 2, (x) => (x < 2 ? 0 : 255)));
        expect([input.width, input.height]).toEqual([32, 32]);
        const plane = input.width * input.height;
        expect(input.data[0]).toBeCloseTo((0 - 0.485) / 0.229);
        expect(input.data[1]).toBeCloseTo((1 - 0.485) / 0.229);
        expect(input.data[plane]).toBeCloseTo((0 - 0.456) / 0.224);
        // Padding reads as paper.
        expect(input.data[2 * plane + 31]).toBeCloseTo((1 - 0.406) / 0.225);
    });
});

describe("textBoxes", () => {
    it("boxes each confident region, grown and scaled back to the page, top to bottom", () => {
        const width = 40;
        const height = 20;
        const probability = new Float32Array(width * height);
        const fill = (x0: number, y0: number, x1: number, y1: number, p: number): void => {
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    probability[y * width + x] = p;
                }
            }
        };
        fill(2, 12, 30, 16, 0.9); // a line
        fill(5, 2, 25, 6, 0.9); // a line above it
        fill(32, 2, 36, 6, 0.4); // probable pixels, but an unsure region
        fill(34, 12, 36, 18, 0.9); // a speck too thin
        const boxes = textBoxes(probability, width, height, {
            width: width * DETECT_SCALE,
            height: height * DETECT_SCALE,
        });
        // 20×4 grows by 20·4·1.5/(2·24) = 2.5 on every side; 28×4 by 2.625.
        expect(boxes).toEqual([
            { x0: 5, y0: 0, x1: 55, y1: 17 },
            { x0: 0, y0: 18, x1: 66, y1: 38 },
        ]);
    });
});

describe("lineInput", () => {
    it("scales the line box to the input height keeping its aspect, normalized to [-1, 1]", () => {
        const image = gray(100, 24, (x) => (x < 50 ? 0 : 255));
        const input = lineInput(image, { x0: 0, y0: 0, x1: 100, y1: 24 });
        expect(input.width).toBe(200);
        const plane = LINE_HEIGHT * input.width;
        expect(input.data.length).toBe(3 * plane);
        expect(input.data[0]).toBe(-1);
        expect(input.data[199]).toBe(1);
        expect(input.data[plane + 199]).toBe(1);
    });
});

describe("decodeLine and lineWords", () => {
    const alphabet = alphabetOf("a\nb\n");
    // Classes: 0 blank, 1 "a", 2 "b", 3 " ".
    const steps = [
        [0.1, 0.8, 0.05, 0.05], // a
        [0.1, 0.7, 0.1, 0.1], // a (repeat, dropped)
        [0.9, 0.05, 0.03, 0.02], // blank
        [0.1, 0.6, 0.2, 0.1], // a (after a blank: kept)
        [0.1, 0.1, 0.1, 0.7], // space
        [0.2, 0.1, 0.6, 0.1], // b
        [0.9, 0.05, 0.03, 0.02], // blank
        [0.9, 0.05, 0.03, 0.02], // blank
    ];
    const probabilities = new Float32Array(steps.flat());

    it("reads the most probable class at each step, dropping repeats and blanks", () => {
        const symbols = decodeLine(probabilities, steps.length, 4, alphabet);
        expect(symbols.map((s) => [s.text, s.step])).toEqual([
            ["a", 0],
            ["a", 3],
            [" ", 4],
            ["b", 5],
        ]);
    });

    it("splits words at separators and boxes each to its own print, between its neighbours", () => {
        const symbols = decodeLine(probabilities, steps.length, 4, alphabet);
        // Print at x 102–128 ("aa") and 152–158 ("b") on a 200×30 page.
        const image = gray(200, 30, (x, y) =>
            y >= 10 && y < 20 && ((x >= 102 && x <= 128) || (x >= 152 && x <= 158)) ? 0 : 255,
        );
        const words = lineWords(symbols, steps.length, { x0: 100, y0: 10, x1: 180, y1: 20 }, image);
        expect(words.map((w) => [w.text, w.box.x0, w.box.x1, w.box.y0, w.box.y1])).toEqual([
            ["aa", 102, 129, 10, 20],
            ["b", 152, 159, 10, 20],
        ]);
        expect(words[0]?.confidence).toBeCloseTo(70);
    });
});

describe("withoutRaisedMarks", () => {
    // A 100×20 line: letters inked full height at x 10–19 and 30–39, two
    // raised marks (ink in the top quarter only) at x 50–53 and 56–59, and
    // a word after a space whose last letter is full height.
    const image = gray(100, 20, (x, y) => {
        const letter = (x >= 10 && x < 20) || (x >= 30 && x < 40) || (x >= 80 && x < 90);
        const mark = ((x >= 50 && x < 54) || (x >= 56 && x < 60)) && y < 5;
        return letter || mark ? 0 : 255;
    });
    const box = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const symbol = (text: string, step: number) => ({ text, step, confidence: 0.9 });
    const textOf = (symbols: readonly { text: string }[]): string => symbols.map((s) => s.text).join("");

    it("takes raised marks read as letters off a word's end, one by one", () => {
        // 10 steps of 10 pixels: symbols at the steps their glyphs sit in.
        const symbols = [
            symbol("a", 1),
            symbol("b", 3),
            symbol("t", 5),
            symbol("t", 5),
            symbol(" ", 7),
            symbol("c", 8),
        ];
        expect(textOf(withoutRaisedMarks(symbols, 10, box, image))).toBe("ab c");
    });

    it("keeps a word's full-height last letter and a lone raised symbol", () => {
        const symbols = [symbol("t", 5), symbol(" ", 7), symbol("c", 8)];
        expect(textOf(withoutRaisedMarks(symbols, 10, box, image))).toBe("t c");
    });
});

describe("withPrintedSpaces", () => {
    // Glyphs 6 wide with 2-column gaps; a 14-column blank after the third glyph
    // (a word space the recognizer passed over), and a hyphen at glyph 5.
    const glyphs = [0, 8, 16, 38, 46, 54];
    const image = gray(100, 20, (x, y) =>
        glyphs.some((g) => x >= g && x < g + 6) && y >= 4 && y < 16 ? 0 : 255,
    );
    const box = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const symbol = (text: string, step: number) => ({ text, step, confidence: 0.9 });
    const textOf = (symbols: readonly { text: string }[]): string => symbols.map((s) => s.text).join("");

    it("puts a space where the print shows a word gap and none was read", () => {
        // 25 steps of 4 columns: each symbol at its glyph's centre.
        const at = (i: number): number => Math.floor(((glyphs[i] ?? 0) + 3) / 4);
        const symbols = ["A", "B", "C", "D", "E", "F"].map((c, i) => symbol(c, at(i)));
        expect(textOf(withPrintedSpaces(symbols, 25, box, image))).toBe("ABC DEF");
    });

    it("adds none where a space was read, nor beside a hyphen", () => {
        const read = [symbol("A", 0), symbol("B", 2), symbol("C", 4), symbol(" ", 7), symbol("D", 10)];
        expect(textOf(withPrintedSpaces(read, 25, box, image))).toBe("ABC D");
        const hyphen = [symbol("A", 0), symbol("B", 2), symbol("-", 4), symbol("D", 10)];
        expect(textOf(withPrintedSpaces(hyphen, 25, box, image))).toBe("AB-D");
    });
});
