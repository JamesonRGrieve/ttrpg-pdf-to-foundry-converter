// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Text canonicalization (spec §5.2). The order of operations is mandatory: it
 * erases extractor-dependent spellings (ligatures, soft hyphens, dash variants,
 * exotic whitespace) so that two runs — or two platforms — reduce identical
 * glyphs to identical code points before any matching or hashing happens.
 */

/** U+FB00–U+FB06 ligature expansions to their component ASCII letters. */
const LIGATURES: Readonly<Record<string, string>> = {
    ﬀ: "ff",
    ﬁ: "fi",
    ﬂ: "fl",
    ﬃ: "ffi",
    ﬄ: "ffl",
    ﬅ: "st",
    ﬆ: "st",
};

const SOFT_HYPHEN = "­";

/** U+2010–U+2015 dashes and U+2212 minus all fold to ASCII hyphen-minus. */
const DASH_RE = /[‐‑‒–—―−]/g;

/** Whitespace runs, including NBSP / figure space / narrow NBSP, collapse to one space. */
const WS_RUN_RE = /[\s   ]+/g;

function expandLigatures(input: string): string {
    let out = "";
    for (const ch of input) {
        out += LIGATURES[ch] ?? ch;
    }
    return out;
}

/**
 * Canonicalize a text run through the fixed §5.2 pipeline:
 * 1. expand ligatures  2. strip soft hyphen  3. fold dashes to `-`
 * 4. collapse whitespace  5. Unicode NFC  6. trim.
 */
export function canonicalizeText(input: string): string {
    let s = expandLigatures(input);
    s = s.split(SOFT_HYPHEN).join("");
    s = s.replace(DASH_RE, "-");
    s = s.replace(WS_RUN_RE, " ");
    s = s.normalize("NFC");
    return s.trim();
}

/** Escape text for inclusion in HTML element content. */
/**
 * Whether two adjacent text fragments are separate words: they sit further
 * apart than `wordGap`, or the first ends on sentence punctuation and the next
 * begins with a letter (a word space an extractor dropped).
 */
export function wordBreakBetween(prev: string, next: string, gap: number, wordGap: number): boolean {
    return gap > wordGap || (/[,.:;!?]$/u.test(prev) && /^\p{L}/u.test(next));
}

/** Printed note markers (footnote daggers etc.) that annotate a value, never part of it. */
export const NOTE_MARKERS = /[†‡*§¶]+/gu;

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip a PDF font subset prefix such as `ABCDEF+Helvetica` → `Helvetica`. */
export function stripSubsetPrefix(fontName: string): string {
    return /^[A-Z]{6}\+(.+)$/.exec(fontName)?.[1] ?? fontName;
}
