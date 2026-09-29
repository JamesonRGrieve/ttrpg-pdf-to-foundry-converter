// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { percentile } from "../../src/util/stats.ts";

describe("percentile", () => {
    it("picks the value at a fraction of an ascending list", () => {
        const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        expect(percentile(values, 0)).toBe(1);
        expect(percentile(values, 0.5)).toBe(6);
        expect(percentile(values, 0.9)).toBe(10);
        expect(percentile(values, 1)).toBe(10);
    });

    it("is 0 for an empty list", () => {
        expect(percentile([], 0.5)).toBe(0);
    });
});
