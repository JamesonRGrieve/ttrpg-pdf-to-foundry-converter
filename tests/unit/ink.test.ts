// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { coreBand, type GrayImage, printPolarity, trimToInk } from "../../src/ocr/ink.ts";

/** A `width`×`height` image, paper except where `ink(x, y)`. */
function page(width: number, height: number, ink: (x: number, y: number) => boolean): GrayImage {
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            pixels[y * width + x] = ink(x, y) ? 0 : 255;
        }
    }
    return { pixels, width, height, stride: width };
}

describe("printPolarity", () => {
    it("tells dark print on paper from light print on a dark bar", () => {
        const box = { x0: 0, y0: 0, x1: 40, y1: 20 };
        const darkPrint = page(40, 20, (x) => x % 10 < 2);
        const lightPrint = page(40, 20, (x) => x % 10 >= 2);
        expect(printPolarity(darkPrint, box)).toBe("dark");
        expect(printPolarity(lightPrint, box)).toBe("light");
    });
});

describe("coreBand", () => {
    // Lower-case glyphs: bodies on rows 10–19, an ascender (rows 4–19) every
    // fourth glyph, a descender below one.
    const line = page(80, 30, (x, y) => {
        const glyph = Math.floor(x / 5);
        if (x % 5 === 4) {
            return false;
        }
        const top = glyph % 4 === 0 ? 4 : 10;
        const bottom = glyph === 7 ? 25 : 19;
        return y >= top && y <= bottom;
    });
    const box = { x0: 0, y0: 0, x1: 80, y1: 30 };

    it("puts the baseline under most columns' ink, descenders aside", () => {
        expect(coreBand(line, box)?.baseline).toBe(20);
    });

    it("finds the cap line, and the x-height where the ink thickens", () => {
        expect(coreBand(line, box)?.capTop).toBe(4);
        expect(coreBand(line, box)?.xTop).toBe(10);
    });

    it("finds no x-height in capitals, which do not thicken part-way", () => {
        const capitals = page(80, 30, (x, y) => x % 5 !== 4 && y >= 4 && y <= 19);
        expect(coreBand(capitals, box)).toEqual({ capTop: 4, xTop: null, baseline: 20 });
    });

    it("measures only the line's own band, not a neighbour's descenders in its padding", () => {
        // The same line, with the line above's few descenders in rows 0–1.
        const crowded = page(80, 30, (x, y) => {
            const glyph = Math.floor(x / 5);
            if (x % 5 === 4) {
                return false;
            }
            if (y <= 1) {
                return x % 20 === 0;
            }
            const top = glyph % 4 === 0 ? 4 : 10;
            return y >= top && y <= 19;
        });
        expect(coreBand(crowded, box)).toEqual({ capTop: 4, xTop: 10, baseline: 20 });
    });

    it("takes the cap line at a lower quantile where few full capitals stand among small ones", () => {
        // Small capitals (rows 8–19) with full capitals (rows 4–19) in one column in twenty.
        const smallCaps = page(80, 30, (x, y) => x % 5 !== 4 && y >= (x < 4 ? 4 : 8) && y <= 19);
        expect(coreBand(smallCaps, box)?.capTop).toBe(8);
        expect(coreBand(smallCaps, box, 0.03)?.capTop).toBe(4);
    });

    it("is null for a box with no ink", () => {
        const blank = page(10, 10, () => false);
        expect(coreBand(blank, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBeNull();
    });
});

describe("trimToInk", () => {
    // A word's print at x 20–39; a neighbour's glyph runs into the box at 10–13.
    const image = page(60, 10, (x) => (x >= 10 && x <= 13) || (x >= 20 && x <= 39));
    const line = { x0: 0, y0: 0, x1: 60, y1: 10 };

    it("narrows a box to its print, skipping a neighbour's glyph at its edge", () => {
        const trimmed = trimToInk(image, { x0: 12, y0: 0, x1: 50, y1: 10 }, line);
        expect(trimmed).toEqual({ x0: 20, y0: 0, x1: 40, y1: 10 });
    });

    it("leaves a box with no print of its own as it is", () => {
        const empty = { x0: 42, y0: 0, x1: 55, y1: 10 };
        expect(trimToInk(image, empty, line)).toEqual(empty);
    });
});
