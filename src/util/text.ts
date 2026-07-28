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

/** Strip a PDF font subset prefix such as `ABCDEF+Helvetica` → `Helvetica`. */
export function stripSubsetPrefix(fontName: string): string {
    const m = /^[A-Z]{6}\+(.+)$/.exec(fontName);
    return m ? m[1]! : fontName;
}
