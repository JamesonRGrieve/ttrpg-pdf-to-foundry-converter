// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isExcluded, matchesSelector } from "../../src/dsl/selectors.ts";
import type { IRTextRun } from "../../src/types/ir.ts";

function run(overrides: Partial<IRTextRun> = {}): IRTextRun {
    return {
        pageIndex: 0,
        band: 10,
        x: 54,
        y: 700,
        width: 100,
        height: 9,
        text: "sample",
        font: "libertinusserif-regular",
        weight: "normal",
        italic: false,
        size: 9,
        sizeBucket: 1,
        column: 0,
        indent: 0,
        renderOrder: 0,
        ...overrides,
    };
}

describe("matchesSelector", () => {
    it("matches on weight, italic, font, and column", () => {
        expect(matchesSelector({ weight: "bold" }, run({ weight: "bold" }))).toBe(true);
        expect(matchesSelector({ weight: "bold" }, run({ weight: "normal" }))).toBe(false);
        expect(matchesSelector({ italic: true }, run({ italic: false }))).toBe(false);
        expect(matchesSelector({ font: "libertinusserif-bold" }, run())).toBe(false);
        expect(matchesSelector({ column: 1 }, run({ column: 1 }))).toBe(true);
    });
    it("compares size with an epsilon, never strict equality", () => {
        expect(matchesSelector({ size: 9.0 }, run({ size: 9.02 }))).toBe(true);
        expect(matchesSelector({ size: 9.0 }, run({ size: 9.5 }))).toBe(false);
    });
    it("honors the indent range", () => {
        expect(matchesSelector({ indent: { min: 10, max: 14 } }, run({ indent: 12 }))).toBe(true);
        expect(matchesSelector({ indent: { min: 10, max: 14 } }, run({ indent: 9 }))).toBe(false);
    });
    it("requires ALL specified criteria", () => {
        expect(matchesSelector({ weight: "bold", size: 9 }, run({ weight: "bold", size: 9 }))).toBe(true);
        expect(matchesSelector({ weight: "bold", size: 9 }, run({ weight: "bold", size: 10 }))).toBe(false);
    });
});

describe("isExcluded", () => {
    it("excludes on a y-only region", () => {
        expect(isExcluded(run({ y: 20 }), [{ region: { y_min: 0, y_max: 45 } }])).toBe(true);
        expect(isExcluded(run({ y: 700 }), [{ region: { y_min: 0, y_max: 45 } }])).toBe(false);
    });
    it("excludes on a combined x+y region", () => {
        const region = [{ region: { y_min: 0, y_max: 800, x_min: 40, x_max: 60 } }];
        expect(isExcluded(run({ x: 54, y: 20 }), region)).toBe(true);
        expect(isExcluded(run({ x: 300, y: 20 }), region)).toBe(false);
    });
});
