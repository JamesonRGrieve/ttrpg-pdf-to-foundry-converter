// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readsAcross, withoutOverprint } from "../../src/stages/extract.ts";
import type { RawTextRun } from "../../src/types/ir.ts";

describe("readsAcross", () => {
    it("keeps text set across the page, however it is scaled or slanted", () => {
        expect(readsAcross([10, 0, 0, 10, 50, 700])).toBe(true);
        expect(readsAcross([10, 0, 2, 10, 50, 700])).toBe(true);
        expect(readsAcross([-10, 0, 0, -10, 50, 700])).toBe(true);
    });

    it("drops text turned on its side up or down a page edge", () => {
        expect(readsAcross([0, 28, -28, 0, 20, 30])).toBe(false);
        expect(readsAcross([0, -12, 12, 0, 580, 400])).toBe(false);
    });
});

function run(text: string, x: number, width: number, y = 500, fontSize = 10): RawTextRun {
    return {
        pageIndex: 0,
        x,
        y,
        width,
        height: fontSize,
        text,
        fontName: "f",
        fontSize,
        weight: "normal",
        italic: false,
        renderOrder: 0,
    };
}

describe("withoutOverprint", () => {
    it("merges text drawn in overlapping pieces into the letters it shows once", () => {
        const pieces = [
            run("Quick, Fo", 100, 43.8),
            run("Fo", 135.2, 8.6),
            run("Fo", 135.2, 8.6),
            run("Fold", 135.2, 13.2),
            run("ld", 143.6, 4.8),
            run("ldin", 143.6, 11.8),
            run("n", 150.5, 4.9),
            run("ng", 150.5, 9.7),
        ];
        const merged = withoutOverprint(pieces);
        expect(merged.map((r) => r.text)).toEqual(["Quick, Folding"]);
        expect(merged[0]?.x).toBe(100);
        expect(merged[0]?.width).toBeCloseTo(60.2);
    });

    it("drops pieces repeating letters from the start of the run they lie over", () => {
        const pieces = [
            run("Ta", 40.9, 12.9, 579, 11),
            run("Ta", 40.9, 12.9, 579, 11),
            run("T", 40.9, 6.9, 579, 11),
            run("a", 47.1, 6.7, 579, 11),
            run("bl", 53.9, 11.2, 579, 11),
            run("b", 53.9, 6.3, 579, 11),
            run(" ", 60.2, 0.4, 579, 11),
            run("e", 65.1, 5.2, 579, 11),
        ];
        expect(withoutOverprint(pieces).map((r) => r.text)).toEqual(["Ta", "bl", "e"]);
    });

    it("keeps runs merely kerned into each other, and runs on other lines or sizes", () => {
        const kerned = [run("The", 100, 15), run("equal", 114.8, 22)];
        expect(withoutOverprint(kerned).map((r) => r.text)).toEqual(["The", "equal"]);
        const apart = [run("Fo", 100, 8.6), run("Fo", 100, 8.6, 488)];
        expect(withoutOverprint(apart)).toHaveLength(2);
        const sized = [run("Fo", 100, 8.6), run("Fo", 100, 7, 500, 8)];
        expect(withoutOverprint(sized)).toHaveLength(2);
    });

    it("leaves every piece as drawn when any piece disagrees with the letters it lies over", () => {
        const pieces = [
            run("Lo", 43.8, 8.4, 683.5, 9),
            run("Lant", 43.8, 14.6, 683.5, 9),
            run("ante", 52.2, 11.6, 683.5, 9),
            run("t rn", 58.4, 12.1, 683.5, 9),
        ];
        expect(withoutOverprint(pieces).map((r) => r.text)).toEqual(["Lo", "Lant", "ante", "t rn"]);
    });

    it("leaves the whole line as drawn when one stretch of it disagrees", () => {
        const pieces = [
            run("Fi", 103, 6.5, 649.5, 9),
            run("Fist", 103, 12.1, 649.5, 9),
            run("s o", 109.5, 12.3, 649.5, 9),
            run("of", 117.4, 6.9, 649.5, 9),
            run("f", 121.8, 2.5, 649.5, 9),
        ];
        expect(withoutOverprint(pieces).map((r) => r.text)).toEqual(["Fi", "Fist", "s o", "of", "f"]);
    });

    it("keeps a run over the last whose letters do not repeat it", () => {
        const pieces = [run("Shield", 100, 25), run("ward", 110, 18)];
        expect(withoutOverprint(pieces).map((r) => r.text)).toEqual(["Shield", "ward"]);
    });
});
