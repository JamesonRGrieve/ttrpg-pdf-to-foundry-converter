// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readsAcross } from "../../src/stages/extract.ts";

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
