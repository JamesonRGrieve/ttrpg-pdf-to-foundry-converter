// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildRollTable, dieFor, parseRollRange, rollResults } from "../../src/infer/roll-tables.ts";

describe("roll ranges", () => {
    it("reads single results, ranges, percentile zeros and open-ended results", () => {
        expect(parseRollRange("7")).toEqual({ lo: 7, hi: 7, open: false });
        expect(parseRollRange("01–15")).toEqual({ lo: 1, hi: 15, open: false });
        expect(parseRollRange("96-00")).toEqual({ lo: 96, hi: 100, open: false });
        expect(parseRollRange("75+")).toEqual({ lo: 75, hi: 75, open: true });
        expect(parseRollRange("Roll")).toBeNull();
        expect(parseRollRange("20-10")).toBeNull();
    });

    it("rolls on the smallest standard die that covers a table", () => {
        expect(dieFor(10)).toBe(10);
        expect(dieFor(9)).toBe(10);
        expect(dieFor(75)).toBe(100);
        expect(dieFor(120)).toBeNull();
    });
});

describe("roll tables", () => {
    it("reads rows of die results as results, an open last result running to the die's top", () => {
        const roll = rollResults([
            ["1-3", "Faint breeze."],
            ["3-5", "Echoes."],
            ["6-40", "Frost."],
            ["41+", "Worse."],
        ]);
        expect(roll?.die).toBe(100);
        expect(roll?.results.map((r) => r.range)).toEqual([
            [1, 3],
            [3, 5],
            [6, 40],
            [41, 100],
        ]);
    });

    it("rejects tables that are not rolls", () => {
        expect(rollResults([["Lamp", "A light."]])).toBeNull();
        expect(rollResults([["2-5", "Starts late."]])).toBeNull();
        expect(
            rollResults([
                ["1-10", "First."],
                ["5", "Falls back."],
            ]),
        ).toBeNull();
        expect(
            rollResults([
                ["1", "Outcome."],
                ["2", ""],
            ]),
        ).toBeNull();
        expect(rollResults([["1", "Two", "Columns too many"]])).toBeNull();
    });

    it("builds a RollTable whose results carry range, weight and deterministic ids", () => {
        const input = { name: "Lamp Mishaps", line: "dh1" as const, book: "Lamp Book", page: "12", die: 10 };
        const doc = buildRollTable({
            ...input,
            results: [
                { range: [1, 4], text: "Flicker." },
                { range: [5, 10], text: "Out." },
            ],
        });
        expect(doc["formula"]).toBe("1d10");
        expect(doc["system"]).toEqual({
            source: { dh1: { provenance: "raw", book: "Lamp Book", page: "12" } },
        });
        const results = doc["results"] as { weight: number; range: number[]; _id: string }[];
        expect(results.map((r) => [r.weight, r.range])).toEqual([
            [4, [1, 4]],
            [6, [5, 10]],
        ]);
        expect(new Set(results.map((r) => r._id)).size).toBe(2);
        // The same table read again gives the same result ids.
        const again = buildRollTable({ ...input, results: [{ range: [1, 4], text: "Flicker." }] });
        expect(again["results"]).toEqual([results[0]]);
    });
});
