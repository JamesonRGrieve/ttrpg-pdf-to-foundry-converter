// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    align,
    arbitrate,
    normalizedDistance,
    resolveGroup,
    smallCapsFonts,
} from "../../src/ocr/arbitrate.ts";
import type { OcrWord } from "../../src/ocr/types.ts";
import type { RawDoc, RawTextRun } from "../../src/types/ir.ts";

const word = (text: string, confidence = 95, box: OcrWord["box"] = [0, 0, 1, 1]): OcrWord => ({
    text,
    confidence,
    box,
    line: 0,
    baseline: box[1],
    lineHeight: box[3] - box[1],
    stroke: 1,
});

function run(text: string, x: number, width: number, extra: Partial<RawTextRun> = {}): RawTextRun {
    return {
        pageIndex: 0,
        x,
        y: 700,
        width,
        height: 10,
        text,
        fontName: "body",
        fontSize: 10,
        weight: "normal",
        italic: false,
        renderOrder: x,
        ...extra,
    };
}

function doc(runs: RawTextRun[]): RawDoc {
    return {
        encrypted: false,
        extractor: "test",
        pages: [
            { pageIndex: 0, width: 600, height: 800, rotation: 0, viewBox: [0, 0, 600, 800], edgeText: [] },
        ],
        textRuns: runs,
        images: [],
        placements: [],
        meta: { title: null, author: null, producer: null, creator: null, creationDate: null },
    };
}

describe("normalizedDistance", () => {
    it("is 0 for equal strings, 1 for disjoint, and scales by the longer string", () => {
        expect(normalizedDistance("abc", "abc")).toBe(0);
        expect(normalizedDistance("abc", "")).toBe(1);
        expect(normalizedDistance("abcd", "abce")).toBeCloseTo(0.25);
    });
});

describe("align", () => {
    it("pairs tokens one-to-one when they agree", () => {
        expect(align(["one", "two"], ["one", "two"])).toEqual([
            { tokens: [0], words: [0] },
            { tokens: [1], words: [1] },
        ]);
    });

    it("merges letter-spaced tokens into the single printed word", () => {
        expect(align(["s", "a", "m", "p", "l", "e"], ["sample"])).toEqual([
            { tokens: [0, 1, 2, 3, 4, 5], words: [0] },
        ]);
    });

    it("leaves unrelated tokens unaligned", () => {
        expect(align(["alpha"], ["zzzzz"])).toEqual([]);
    });
});

describe("resolveGroup", () => {
    it("keeps an intact single word untouched", () => {
        expect(resolveGroup(["hello"], [word("hello")], false)).toBeNull();
        expect(resolveGroup(["hello"], [word("hallo")], false)).toBeNull();
    });

    it("joins a split initial with the rest of its word", () => {
        expect(resolveGroup(["T", "here"], [word("There")], false)).toBe("There");
    });

    it("takes OCR casing when the text layer's casing is anomalous", () => {
        expect(resolveGroup(["saMPle"], [word("SAMPLE")], false)).toBe("SAMPLE");
    });

    it("never fuses two full words that OCR read as one", () => {
        expect(resolveGroup(["Full", "18kg"], [word("Full18kg")], false)).toBeNull();
    });

    it("replaces corrupted text-layer letters with a confident OCR read", () => {
        expect(resolveGroup(["ab\u0003cd"], [word("abcd")], false)).toBe("abcd");
        expect(resolveGroup(["ab\u0003cd"], [word("abcd", 20)], false)).toBeNull();
    });

    it("restores a ligature the text layer mapped to fewer letters", () => {
        expect(resolveGroup(["ofers"], [word("offers")], false)).toBe("offers");
        expect(resolveGroup(["eld"], [word("field")], false)).toBe("field");
        expect(resolveGroup(["ofers"], [word("offers", 20)], false)).toBeNull();
        // Any other disagreement keeps the text layer.
        expect(resolveGroup(["offers"], [word("ofers")], false)).toBeNull();
        expect(resolveGroup(["cart"], [word("craft")], false)).toBeNull();
    });

    it("unifies a single word split across touching runs", () => {
        expect(resolveGroup(["suffer"], [word("sutter")], true)).toBe("suffer");
    });
});

describe("smallCapsFonts", () => {
    it("flags a face whose tokens start lowercase and turn uppercase, not one with mixed-case abbreviations", () => {
        const runs: RawTextRun[] = [];
        for (let i = 0; i < 25; i += 1) {
            runs.push(run("xaMPlE", i * 10, 8, { fontName: "ABCDEF+Display-SC" }));
            runs.push(run("AgB DoS", i * 10, 8, { fontName: "Body" }));
        }
        runs.push(run("plain words", 0, 8, { fontName: "GHIJKL+Display-SC" }));
        expect([...smallCapsFonts(runs)]).toEqual(["Display-SC"]);
    });
});

describe("arbitrate", () => {
    it("joins a letter-spaced run with its split initial into the printed word", () => {
        const raw = doc([run("S", 100, 8), run("a m p l e", 108, 40)]);
        const ocr = [{ pageIndex: 0, words: [word("Sample", 95, [100, 698, 148, 708])] }];
        const texts = arbitrate(raw, ocr).textRuns.map((r) => r.text);
        expect(texts).toEqual(["Sample"]);
    });

    it("gives a word joined from a larger initial the full extent and the size of its letters", () => {
        const raw = doc([run("S", 100, 8, { fontSize: 16 }), run("a m p l e", 108, 40, { fontSize: 11 })]);
        const ocr = [{ pageIndex: 0, words: [word("Sample", 95, [100, 698, 148, 708])] }];
        const [joined] = arbitrate(raw, ocr).textRuns;
        expect([joined?.text, joined?.x, joined?.width, joined?.fontSize]).toEqual(["Sample", 100, 48, 11]);
    });

    it("reads an initial printed twice over itself once in the word it begins", () => {
        const initial = run("S", 100, 8, { fontSize: 16 });
        const raw = doc([initial, { ...initial }, run("AMPLE", 108, 40, { fontSize: 11 })]);
        const ocr = [{ pageIndex: 0, words: [word("SAMPLE", 34, [100, 698, 148, 708])] }];
        expect(arbitrate(raw, ocr).textRuns.map((r) => r.text)).toEqual(["SAMPLE"]);
    });

    it("reads every line of a face OCR never reads as written from OCR, however short", () => {
        // Forty cells in a face whose glyphs encode other letters, one per row,
        // with OCR reading "Lamp" over each; and a short body word OCR agrees with.
        const cells = Array.from({ length: 40 }, (_, i) => ({
            ...run('I"3"', 100, 20, { fontName: "ABCDEF+Cells" }),
            y: 700 - i * 12,
        }));
        const words = cells.map((c) => word("Lamp", 95, [100, c.y - 2, 120, c.y + 8]));
        const body = { ...run("Wick", 300, 20), y: 700 };
        const out = arbitrate(doc([...cells, body]), [
            { pageIndex: 0, words: [...words, word("Wick", 95, [300, 698, 320, 708])] },
        ]).textRuns;
        expect(new Set(out.filter((r) => r.fontName.endsWith("Cells")).map((r) => r.text))).toEqual(
            new Set(["Lamp"]),
        );
        expect(out.find((r) => r.x === 300)?.text).toBe("Wick");
        // A line of that face holding only a space is left as it is.
        const blank = { ...run(" ", 100, 5, { fontName: "ABCDEF+Cells" }), y: 100 };
        const withBlank = arbitrate(doc([...cells, blank]), [
            { pageIndex: 0, words: [...words, word("Lamp", 95, [100, 98, 105, 108])] },
        ]).textRuns;
        expect(withBlank.find((r) => r.y === 100)?.text).toBe(" ");
    });

    it("reads a cell whose font maps letters to marks from OCR, but keeps a printed dash value", () => {
        const raw = doc([run('C0%-)D/"33&', 100, 42), run("S/–/–", 300, 20)]);
        const words = [
            word("Acid", 95, [100, 698, 117, 708]),
            word("Shells", 95, [121, 698, 142, 708]),
            word("S/-/-", 95, [300, 698, 320, 708]),
        ];
        expect(arbitrate(raw, [{ pageIndex: 0, words }]).textRuns.map((r) => r.text)).toEqual([
            "Acid Shells",
            "S/–/–",
        ]);
    });

    it("reads a row drawn over and over in overlapping pieces from OCR", () => {
        // Each piece drawn three times; what survives still overlaps.
        const pieces = [run("La", 100, 10), run("L mp", 100, 20), run("mp", 110, 10)];
        const raw = doc(pieces.flatMap((p) => [p, { ...p }, { ...p }]));
        const ocr = [{ pageIndex: 0, words: [word("Lamp", 90, [100, 698, 120, 708])] }];
        expect(arbitrate(raw, ocr).textRuns.map((r) => r.text)).toEqual(["Lamp"]);
        // A cell of several words keeps them as one spaced text.
        const two = [run("Ol", 100, 10), run("X d", 104, 12), run("Lamp", 118, 20)];
        const words = [word("Old", 90, [100, 698, 114, 708]), word("Lamp", 90, [118, 698, 138, 708])];
        const read = arbitrate(doc(two.flatMap((p) => [p, { ...p }, { ...p }])), [{ pageIndex: 0, words }]);
        expect(read.textRuns.map((r) => r.text)).toEqual(["Old Lamp"]);
    });

    it("keeps the layer of a row drawn over and over whose pieces come apart cleanly", () => {
        const pieces = [run("La", 100, 10), run("mp", 110, 10)];
        const raw = doc(pieces.flatMap((p) => [p, { ...p }, { ...p }]));
        const ocr = [{ pageIndex: 0, words: [word("Larnp", 90, [100, 698, 120, 708])] }];
        expect(arbitrate(raw, ocr).textRuns.map((r) => r.text)).toEqual(["La", "mp"]);
    });

    it("sets a word of one-letter runs after a larger initial in its letters' size", () => {
        const letters = ["S", "a", "m", "p", "l", "e"].map((ch, i) =>
            run(ch, 100 + i * 8, 8, { fontSize: i === 0 ? 16 : 11 }),
        );
        const ocr = [{ pageIndex: 0, words: [word("Sample", 95, [100, 698, 148, 708])] }];
        const [joined] = arbitrate(doc(letters), ocr).textRuns;
        expect([joined?.text, joined?.x, joined?.width, joined?.fontSize]).toEqual(["Sample", 100, 48, 11]);
    });

    it("inserts a confident OCR word that sits on no text-layer line", () => {
        const raw = doc([run("heading", 100, 40)]);
        const ocr = [{ pageIndex: 0, words: [word("Caption", 95, [100, 400, 150, 410])] }];
        const out = arbitrate(raw, ocr).textRuns;
        expect(out.map((r) => r.text)).toEqual(["heading", "Caption"]);
    });

    it("replaces a token garbled beyond alignment by the OCR words printed over it", () => {
        // A shifted font encoding: every glyph offset, the space a control character.
        const rest = "burns low beside the quiet reeds";
        const raw = doc([run("2OG\u0003/DPS\u001d", 100, 60), run(rest, 170, 160)]);
        const restWords = rest.split(" ").map((w, i) => word(w, 95, [170 + i * 27, 698, 194 + i * 27, 708]));
        const ocr = [
            {
                pageIndex: 0,
                words: [
                    word("Old", 95, [100, 698, 120, 708]),
                    word("Lamp:", 95, [124, 698, 158, 708]),
                    ...restWords,
                ],
            },
        ];
        expect(arbitrate(raw, ocr).textRuns.map((r) => r.text)).toEqual(["Old Lamp:", rest]);
    });

    it("keeps clean text that a garbled word runs into without a real space", () => {
        const rest = "burns low beside the quiet reeds tonight";
        // The garbled run's trailing word break is itself a garbled character.
        const raw = doc([
            run("2OG\u0003/DPS\u001d\u0003", 100, 62),
            run("The", 162, 18),
            run(rest, 184, 170),
        ]);
        const restWords = rest.split(" ").map((w, i) => word(w, 95, [184 + i * 24, 698, 204 + i * 24, 708]));
        const ocr = [
            {
                pageIndex: 0,
                words: [
                    word("Old", 95, [100, 698, 120, 708]),
                    word("Lamp:", 95, [124, 698, 158, 708]),
                    word("The", 95, [162, 698, 180, 708]),
                    ...restWords,
                ],
            },
        ];
        const texts = arbitrate(raw, ocr).textRuns.map((r) => r.text);
        expect(texts[0]).toBe("Old Lamp:");
        expect(texts).toContain("The");
    });

    it("rewrites a wholly corrupt line run by run, each taking the words printed over it", () => {
        // Two columns a narrow gutter apart share a baseline; both are custom-encoded.
        const raw = doc([
            run("\u0001\u0002\u0003\u0004\u0005", 100, 60),
            run("\u0006\u0007\u0010\u0011", 170, 60),
        ]);
        const ocr = [
            {
                pageIndex: 0,
                words: [
                    word("Old", 95, [100, 698, 120, 708]),
                    word("Lamp", 95, [124, 698, 158, 708]),
                    word("Wick", 95, [172, 698, 200, 708]),
                ],
            },
        ];
        expect(arbitrate(raw, ocr).textRuns.map((r) => [r.text, r.x])).toEqual([
            ["Old Lamp", 100],
            ["Wick", 170],
        ]);
    });

    it("replaces a line OCR reads none of, where OCR reads as much text confidently", () => {
        // A display font encoding letters as other ordinary letters.
        const raw = doc([run("9Lgpq0V:hAamh", 100, 90)]);
        const ocr = [
            {
                pageIndex: 0,
                words: [
                    word("TABLE", 96, [100, 698, 130, 708]),
                    word("5-4:", 96, [134, 698, 152, 708]),
                    word("LAMPS", 95, [156, 698, 190, 708]),
                ],
            },
        ];
        expect(arbitrate(raw, ocr).textRuns.map((r) => r.text)).toEqual(["TABLE 5-4: LAMPS"]);
        // A line OCR reads part of keeps its text layer.
        const kept = doc([run("Lantern oil burns", 100, 90)]);
        const partial = [{ pageIndex: 0, words: [word("Lantern", 96, [100, 698, 140, 708])] }];
        expect(arbitrate(kept, partial).textRuns.map((r) => r.text)).toEqual(["Lantern oil burns"]);
    });

    it("leaves pages without OCR unchanged", () => {
        const raw = doc([run("untouched", 100, 40)]);
        expect(arbitrate(raw, []).textRuns).toEqual(raw.textRuns);
    });

    it("reads a page with no text layer from its OCR lines alone", () => {
        const raw = doc([]);
        const line = (text: string, x: number, lineIndex: number, y: number): OcrWord => ({
            ...word(text, 70, [x, y - 2, x + 30, y + 8]),
            line: lineIndex,
            baseline: y,
            lineHeight: 10,
            stroke: 1,
        });
        const ocr = [
            {
                pageIndex: 0,
                words: [line("first", 100, 0, 700), line("line", 135, 0, 700), line("second", 100, 1, 688)],
            },
        ];
        const out = arbitrate(raw, ocr).textRuns;
        expect(out.map((r) => [r.text, r.y, r.fontSize])).toEqual([
            ["first line", 700, 10],
            ["second", 688, 10],
        ]);
    });
});
