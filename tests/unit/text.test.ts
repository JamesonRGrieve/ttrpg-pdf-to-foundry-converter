// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalizeText, stripSubsetPrefix, wordBreakBetween, wordSpace } from "../../src/util/text.ts";

// All non-ASCII / invisible characters are written as \u escape sequences so
// the exact codepoint under test is unambiguous in the source.

describe("canonicalizeText — ligature expansion", () => {
    it("expands U+FB00–U+FB04 to their ASCII components", () => {
        expect(canonicalizeText("ﬀ")).toBe("ff");
        expect(canonicalizeText("ﬁ")).toBe("fi");
        expect(canonicalizeText("ﬂ")).toBe("fl");
        expect(canonicalizeText("ﬃ")).toBe("ffi");
        expect(canonicalizeText("ﬄ")).toBe("ffl");
    });

    it("expands ligatures embedded in words", () => {
        expect(canonicalizeText("oﬃce")).toBe("office");
        expect(canonicalizeText("ﬂask")).toBe("flask");
    });
});

describe("canonicalizeText — soft hyphen", () => {
    it("strips the discretionary soft hyphen U+00AD", () => {
        expect(canonicalizeText("cooper­ate")).toBe("cooperate");
        expect(canonicalizeText("­lead")).toBe("lead");
    });
});

describe("canonicalizeText — dash folding", () => {
    it("folds every U+2010–U+2015 dash and U+2212 minus to ASCII hyphen-minus", () => {
        const dashes = ["‐", "‑", "‒", "–", "—", "―", "−"];
        for (const d of dashes) {
            expect(canonicalizeText(`a${d}b`)).toBe("a-b");
        }
    });

    it("leaves an ASCII hyphen untouched", () => {
        expect(canonicalizeText("a-b")).toBe("a-b");
    });
});

describe("canonicalizeText — whitespace collapse", () => {
    it("collapses runs of ordinary whitespace to a single space", () => {
        expect(canonicalizeText("a   b")).toBe("a b");
        expect(canonicalizeText("a\t\n b")).toBe("a b");
    });

    it("collapses NBSP (U+00A0), figure space (U+2007), narrow NBSP (U+202F)", () => {
        expect(canonicalizeText("a b")).toBe("a b");
        expect(canonicalizeText("a b")).toBe("a b");
        expect(canonicalizeText("a b")).toBe("a b");
        expect(canonicalizeText("a   b")).toBe("a b");
    });

    it("reduces an all-whitespace string to empty after trim", () => {
        expect(canonicalizeText("     ")).toBe("");
    });
});

describe("canonicalizeText — NFC normalization and trim", () => {
    it("composes decomposed sequences via NFC", () => {
        expect(canonicalizeText("é")).toBe("é");
        expect(canonicalizeText("café")).toBe("café");
    });

    it("trims leading and trailing whitespace last", () => {
        expect(canonicalizeText("  hi  ")).toBe("hi");
    });
});

describe("canonicalizeText — the ordered pipeline does work NFC alone cannot", () => {
    it("expands a ligature that NFC would preserve", () => {
        // NFC does not decompose the fi ligature — the explicit expansion step must.
        expect("ﬁ".normalize("NFC")).not.toBe("fi");
        expect(canonicalizeText("ﬁ")).toBe("fi");
    });

    it("strips a soft hyphen that NFC would preserve", () => {
        expect("a­b".normalize("NFC")).toBe("a­b");
        expect(canonicalizeText("a­b")).toBe("ab");
    });

    it("folds a minus sign that NFC would preserve", () => {
        expect("a−b".normalize("NFC")).toBe("a−b");
        expect(canonicalizeText("a−b")).toBe("a-b");
    });

    it("applies ligature, soft-hyphen, dash, whitespace, NFC and trim together", () => {
        const input = "  ﬀ­ice — café  ";
        expect(canonicalizeText(input)).toBe("ffice - café");
    });
});

describe("stripSubsetPrefix", () => {
    it("removes a canonical 6-uppercase subset prefix", () => {
        expect(stripSubsetPrefix("ABCDEF+Helvetica")).toBe("Helvetica");
        expect(stripSubsetPrefix("ABCDEF+Times-Roman")).toBe("Times-Roman");
    });

    it("leaves non-prefixed font names alone", () => {
        expect(stripSubsetPrefix("Helvetica")).toBe("Helvetica");
        expect(stripSubsetPrefix("Times-Roman")).toBe("Times-Roman");
    });

    it("rejects malformed prefixes (wrong length, lowercase, empty tail)", () => {
        expect(stripSubsetPrefix("ABCDE+Foo")).toBe("ABCDE+Foo"); // only 5 uppercase
        expect(stripSubsetPrefix("ABCDEFG+Foo")).toBe("ABCDEFG+Foo"); // 7 chars before +
        expect(stripSubsetPrefix("abcdef+Foo")).toBe("abcdef+Foo"); // lowercase
        expect(stripSubsetPrefix("ABCDEF+")).toBe("ABCDEF+"); // empty tail
    });
});

describe("wordBreakBetween", () => {
    it("breaks at a visible gap, or after sentence punctuation before a letter", () => {
        expect(wordBreakBetween("lamp", "oil", 4, 1.5)).toBe(true);
        expect(wordBreakBetween("lan", "tern", 0.2, 1.5)).toBe(false);
        expect(wordBreakBetween("Glow:", "The", 0.5, 1.5)).toBe(true);
        expect(wordBreakBetween("ratio 3:", "1", 0.5, 1.5)).toBe(false);
    });
});

describe("wordSpace", () => {
    it("scales with the larger neighbour, so a large initial's letters stay one word", () => {
        // A word space beside a larger numeral is still a space.
        expect(wordBreakBetween("rank", "2:", 3, wordSpace(11.25, 16))).toBe(true);
        expect(wordBreakBetween("herald of", "khorne", 2.2, wordSpace(11, 11))).toBe(true);
        // A small-capitals initial and its letters, letter-spaced.
        expect(wordBreakBetween("g", "r e a t", 1.43, wordSpace(13, 9.1))).toBe(false);
        expect(wordBreakBetween("(e", "lite", 0.13, wordSpace(13, 9.1))).toBe(false);
    });
});
