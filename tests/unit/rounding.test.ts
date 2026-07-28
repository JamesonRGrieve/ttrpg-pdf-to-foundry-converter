// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    BAND_HEIGHT,
    COORD_STEP,
    SIZE_EPSILON,
    SIZE_STEP,
    WIDTH_STEP,
    quantize,
    quantizeCoord,
    quantizeSize,
    quantizeWidth,
    roundHalfEven,
    sizeEquals,
} from "../../src/util/rounding.ts";

describe("rounding constants", () => {
    it("pins the quantization grid steps and band height", () => {
        expect(COORD_STEP).toBe(0.1);
        expect(SIZE_STEP).toBe(0.25);
        expect(WIDTH_STEP).toBe(0.1);
        expect(SIZE_EPSILON).toBe(0.05);
        expect(BAND_HEIGHT).toBe(2.0);
    });
});

describe("roundHalfEven", () => {
    it("rounds exact ties toward the even neighbour (positive)", () => {
        expect(roundHalfEven(0.5)).toBe(0);
        expect(roundHalfEven(1.5)).toBe(2);
        expect(roundHalfEven(2.5)).toBe(2);
        expect(roundHalfEven(3.5)).toBe(4);
        expect(roundHalfEven(4.5)).toBe(4);
    });

    it("rounds exact ties toward the even neighbour (negative)", () => {
        expect(roundHalfEven(-0.5)).toBe(0);
        expect(roundHalfEven(-1.5)).toBe(-2);
        expect(roundHalfEven(-2.5)).toBe(-2);
        expect(roundHalfEven(-3.5)).toBe(-4);
    });

    it("rounds non-ties to the nearer integer", () => {
        expect(roundHalfEven(0.4)).toBe(0);
        expect(roundHalfEven(0.6)).toBe(1);
        expect(roundHalfEven(2.4)).toBe(2);
        expect(roundHalfEven(2.6)).toBe(3);
        expect(roundHalfEven(-2.4)).toBe(-2);
        expect(roundHalfEven(-2.6)).toBe(-3);
        expect(roundHalfEven(-0.4)).toBe(0);
        expect(roundHalfEven(-0.6)).toBe(-1);
    });

    it("returns integers unchanged", () => {
        expect(roundHalfEven(0)).toBe(0);
        expect(roundHalfEven(7)).toBe(7);
        expect(roundHalfEven(-7)).toBe(-7);
    });
});

describe("quantize", () => {
    it("snaps a value to the nearest multiple of the step", () => {
        expect(quantize(0.14, 0.1)).toBe(0.1);
        expect(quantize(0.16, 0.1)).toBe(0.2);
        expect(quantize(0.03, 0.1)).toBe(0);
        expect(quantize(0.17, 0.1)).toBe(0.2);
        expect(quantize(0.12, 0.25)).toBe(0);
        expect(quantize(0.13, 0.25)).toBe(0.25);
        expect(quantize(0.3, 0.25)).toBe(0.25);
    });

    it("produces grid-clean numbers with no float representation noise", () => {
        const noisy = [0.1 + 0.2, 0.7, 0.3, 1.1, 2.2, 0.15, 0.16, 0.14];
        for (const v of noisy) {
            const q = quantize(v, 0.1);
            expect(String(q)).toMatch(/^-?\d+(\.\d)?$/);
        }
        // The canonical float-noise input snaps to an exact tenth.
        expect(quantize(0.1 + 0.2, 0.1)).toBe(0.3);
        expect(String(quantize(0.1 + 0.2, 0.1))).toBe("0.3");
    });

    it("uses banker's rounding on exact half-steps", () => {
        // 0.125 / 0.25 = 0.5 exactly → rounds to even (0).
        expect(quantize(0.125, 0.25)).toBe(0);
        // 0.375 / 0.25 = 1.5 exactly → rounds to even (2 → 0.5).
        expect(quantize(0.375, 0.25)).toBe(0.5);
    });

    it("handles negatives symmetrically", () => {
        expect(quantize(-0.14, 0.1)).toBe(-0.1);
        expect(quantize(-0.16, 0.1)).toBe(-0.2);
    });
});

describe("quantizeCoord / quantizeSize / quantizeWidth", () => {
    it("quantizeCoord snaps to the 0.1 coordinate grid", () => {
        expect(quantizeCoord(0.14)).toBe(0.1);
        expect(quantizeCoord(0.16)).toBe(0.2);
        expect(quantizeCoord(0.1 + 0.2)).toBe(0.3);
    });

    it("quantizeSize snaps to the 0.25 size grid", () => {
        expect(quantizeSize(0.12)).toBe(0);
        expect(quantizeSize(0.13)).toBe(0.25);
        expect(quantizeSize(10.2)).toBe(10.25);
        expect(quantizeSize(10.1)).toBe(10.0);
    });

    it("quantizeWidth snaps to the 0.1 width grid", () => {
        expect(quantizeWidth(0.14)).toBe(0.1);
        expect(quantizeWidth(0.16)).toBe(0.2);
    });
});

describe("sizeEquals", () => {
    it("is true within the default epsilon and strictly less-than", () => {
        expect(sizeEquals(10, 10.04)).toBe(true);
        expect(sizeEquals(10, 9.96)).toBe(true);
        expect(sizeEquals(12, 12)).toBe(true);
    });

    it("is false at or beyond the epsilon boundary (strict <)", () => {
        expect(sizeEquals(10, 10.05)).toBe(false);
        expect(sizeEquals(10, 10.06)).toBe(false);
        expect(sizeEquals(10, 9.95)).toBe(false);
    });

    it("honours a custom epsilon", () => {
        expect(sizeEquals(10, 10.01, 0.02)).toBe(true);
        expect(sizeEquals(10, 10.03, 0.02)).toBe(false);
    });
});
