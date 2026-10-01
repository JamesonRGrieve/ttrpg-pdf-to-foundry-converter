// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { RawTextRun } from "../../src/types/ir.ts";
import { readReprints } from "../../src/util/reprints.ts";

function run(text: string, extra: Partial<RawTextRun> = {}): RawTextRun {
    return {
        pageIndex: 0,
        x: 100,
        y: 700,
        width: 20,
        height: 10,
        text,
        fontName: "body",
        fontSize: 10,
        weight: "normal",
        italic: false,
        renderOrder: 0,
        ...extra,
    };
}

const withoutReprints = (runs: RawTextRun[]): RawTextRun[] => readReprints(runs).runs;

describe("readReprints", () => {
    it("keeps one of two runs printed over each other", () => {
        expect(withoutReprints([run("Fel"), run("Fel", { renderOrder: 1 })]).map((r) => r.text)).toEqual([
            "Fel",
        ]);
    });

    it("drops a drop cap set again over the start of its word, keeping the word", () => {
        const word = run("GET", { width: 24 });
        expect(withoutReprints([word, run("G", { width: 11 })])).toEqual([word]);
        // Whichever the layer lists first.
        expect(withoutReprints([run("G", { width: 11 }), word])).toEqual([word]);
    });

    it("drops a glyph set a hair left of the value it repeats", () => {
        const value = run("55", { x: 410.02, width: 14.2 });
        expect(withoutReprints([value, run("5", { x: 409.97, width: 7.1 })])).toEqual([value]);
    });

    it("drops a copy that leaves a letter out or sets it as a space", () => {
        const word = run("Tabl", { width: 24 });
        expect(withoutReprints([word, run("T bl", { width: 24, renderOrder: 1 })])).toEqual([word]);
        // Letters out of order are no copy.
        expect(withoutReprints([word, run("lb", { width: 10 })])).toHaveLength(2);
    });

    it("drops glyphs set one by one over a whole display line", () => {
        const whole = run("WICK HULLS", { width: 120, fontSize: 18 });
        const glyphs = [
            run("WI", { width: 24, fontSize: 18 }),
            run("CK", { x: 124, width: 26, fontSize: 18 }),
        ];
        expect(withoutReprints([whole, ...glyphs])).toEqual([whole]);
        // Neighbouring text is no copy.
        const beside = run("GLOW", { x: 230, width: 50, fontSize: 18 });
        expect(withoutReprints([whole, beside])).toEqual([whole, beside]);
    });

    it("joins a line set in overlapping pieces without the letters each piece repeats", () => {
        const pieces = [
            run("be Lu", { x: 102.6, width: 21.5 }),
            run("Luck", { x: 114.3, width: 18.6 }),
            run("cky", { x: 124.0, width: 13.2 }),
            run("y", { x: 132.6, width: 4.6 }),
        ];
        expect(withoutReprints(pieces).map((r) => r.text)).toEqual(["be Lu", "ck", "y"]);
        // A repeated letter the layer set as a space still repeats.
        const spaced = [run(" 3–", { x: 70.1, width: 15 }), run("3 2:", { x: 74.3, width: 19.9 })];
        expect(withoutReprints(spaced).map((r) => r.text)).toEqual([" 3–", "2:"]);
        // Touching pieces, or an overlap narrower than half a letter, keep every letter.
        const touching = [run("lamp", { width: 20 }), run("post", { x: 120.4, width: 20 })];
        expect(withoutReprints(touching).map((r) => r.text)).toEqual(["lamp", "post"]);
        // Overlapping letters that differ are no repeat.
        const different = [run("lamp", { width: 20 }), run("stop", { x: 115, width: 20 })];
        expect(withoutReprints(different).map((r) => r.text)).toEqual(["lamp", "stop"]);
    });

    it("drops a word space set inside a run's own letters, not one between runs", () => {
        const word = run("Na", { width: 12 });
        const inside = run(" ", { x: 107.4, width: 0.5 });
        expect(withoutReprints([word, inside]).map((r) => r.text)).toEqual(["Na"]);
        const between = run(" ", { x: 112, width: 2 });
        expect(withoutReprints([word, between]).map((r) => r.text)).toEqual(["Na", " "]);
    });

    it("returns the exact copies it drops, not the glyphs of a fuller run", () => {
        const word = run("GET", { width: 24 });
        const copy = run("GET", { width: 24, renderOrder: 1 });
        expect(readReprints([word, copy, run("G", { width: 11 })]).copies).toEqual([copy]);
    });

    it("treats subsets of one face as the same face", () => {
        const word = run("GET", { width: 24, fontName: "ABCDEF+Display" });
        expect(withoutReprints([word, run("G", { width: 11, fontName: "GHIJKL+Display" })])).toEqual([word]);
    });

    it("keeps the same text printed at another place, on another page, or in another face", () => {
        const runs = [
            run("Fel"),
            run("Fel", { x: 140 }),
            run("Fel", { pageIndex: 1 }),
            run("Fel", { weight: "bold" }),
            run("Fel", { fontSize: 12 }),
        ];
        expect(withoutReprints(runs)).toHaveLength(runs.length);
    });

    it("keeps repeated space runs, which carry no letters to double", () => {
        expect(withoutReprints([run(" "), run(" ")])).toHaveLength(2);
    });
});
