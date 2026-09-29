// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { addScores, f1, markdownToText, scoreBag, tokens } from "../../scripts/lib/bag-score.ts";

describe("tokens", () => {
    it("splits on whitespace, strips edge punctuation, keeps inner punctuation", () => {
        expect(tokens('"Half-Action," 41st (Rare).', true)).toEqual(["Half-Action", "41st", "Rare"]);
    });

    it("folds case when case-insensitive", () => {
        expect(tokens("Lantern LANTERN", false)).toEqual(["lantern", "lantern"]);
    });

    it("canonicalizes ligatures and dashes before splitting", () => {
        expect(tokens("ﬁre — 2d10", true)).toEqual(["fire", "2d10"]);
    });
});

describe("scoreBag / f1", () => {
    it("counts multiset overlap, not set overlap", () => {
        const s = scoreBag(["a", "a", "b"], ["a", "b", "b", "c"]);
        expect(s).toEqual({ matched: 2, candidate: 3, reference: 4 });
        expect(f1(s).precision).toBeCloseTo(2 / 3);
        expect(f1(s).recall).toBeCloseTo(0.5);
    });

    it("returns zeros instead of NaN on empty inputs", () => {
        expect(f1(scoreBag([], []))).toEqual({ precision: 0, recall: 0, f1: 0 });
    });

    it("sums scores field by field", () => {
        expect(
            addScores({ matched: 1, candidate: 2, reference: 3 }, { matched: 4, candidate: 5, reference: 6 }),
        ).toEqual({
            matched: 5,
            candidate: 7,
            reference: 9,
        });
    });
});

describe("markdownToText", () => {
    it("drops frontmatter, comments, tags and markdown markers but keeps cell text", () => {
        const md =
            "---\nk: v\n---\n# Title\n<!-- note -->\n<table><tr><td>Dam</td><td>1d10</td></tr></table>\n**Bold** _it_ [link](x)";
        expect(tokens(markdownToText(md), true)).toEqual(["Title", "Dam", "1d10", "Bold", "it", "link"]);
    });
});
