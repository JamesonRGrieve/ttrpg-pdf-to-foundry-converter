// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildLexicon, vouch } from "../../src/ocr/lexicon.ts";
import type { RawTextRun } from "../../src/types/ir.ts";

function run(text: string, pageIndex = 0): RawTextRun {
    return {
        pageIndex,
        x: 0,
        y: 0,
        width: 100,
        height: 10,
        text,
        fontName: "body",
        fontSize: 10,
        weight: "normal",
        italic: false,
        renderOrder: 0,
    };
}

const all = (): boolean => true;

describe("vouch", () => {
    const lexicon = buildLexicon(
        [
            run("The lamp is lit; the lamp burns. A lamp, a lamp."),
            run("A wick is a wick; the wick and the lamp and a lump."),
            run("Tallow and tallow, the oil of the lamp.", 1),
        ],
        all,
    );

    it("knows a word the document prints, whatever its case or marks", () => {
        expect(vouch("LAMP,", 0, lexicon)).toEqual({ text: "LAMP,", known: true });
        expect(vouch("Wick", 1, lexicon)).toEqual({ text: "Wick", known: true });
    });

    it("corrects a word one letter from the word its page prints most, in its own case", () => {
        expect(vouch("LAMR", 0, lexicon)).toEqual({ text: "LAMP", known: true });
        expect(vouch("Wicl.", 0, lexicon)).toEqual({ text: "Wick.", known: true });
    });

    it("falls back to the document when the page has no such word", () => {
        expect(vouch("TALLOV", 0, lexicon)).toEqual({ text: "TALLOW", known: true });
    });

    it("does not correct where two candidates are printed about as often", () => {
        // "lamp" (6) and "lump" (1) both lie one letter from "limp": lamp dominates.
        expect(vouch("limp", 0, lexicon).text).toBe("lamp");
        const even = buildLexicon([run("bat bat cat cat")], all);
        expect(vouch("hat", 0, even)).toEqual({ text: "hat", known: false });
    });

    it("never vouches for short words, words with digits, or words printed once", () => {
        expect(vouch("is", 0, lexicon).known).toBe(false);
        expect(vouch("L4MP", 0, lexicon).known).toBe(false);
        // "lumps" is printed nowhere, and no word one letter from it is printed twice.
        expect(vouch("lumps", 0, lexicon)).toEqual({ text: "lumps", known: false });
    });

    it("builds only from the runs it is told are soundly encoded", () => {
        const lex = buildLexicon([run("lamp lamp"), run("wick wick")], (r) => !r.text.startsWith("wick"));
        expect(vouch("wick", 0, lex).known).toBe(false);
        expect(vouch("lamp", 0, lex).known).toBe(true);
    });
});
