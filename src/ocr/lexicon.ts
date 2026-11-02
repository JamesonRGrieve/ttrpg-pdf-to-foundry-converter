// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RawTextRun } from "../types/ir.ts";
import { byteCompare, numAsc } from "../util/ordered.ts";

/**
 * The document's own vocabulary, read from its text layer: how often each word
 * is printed in the whole document and on each page. It vouches for OCR words
 * read where the text layer cannot spell its own line (a display face with a
 * custom encoding), and corrects a misread letter there by the word the
 * document itself prints most around it ("ARI" over a table of arm wounds is
 * "ARM"). Nothing here knows any document's words: the lexicon is built from
 * the PDF being read.
 */
export interface Lexicon {
    document: ReadonlyMap<string, number>;
    pages: ReadonlyMap<number, ReadonlyMap<string, number>>;
}

/** A word the document prints at least this often is one it knows (once could be a garbled run's chance letters). */
const MIN_KNOWN = 2;
/** Words shorter than this are too easily formed by chance to vouch for or correct. */
const MIN_LETTERS = 3;
/** A correction must be printed at least this many times more often than the next candidate. */
const DOMINANCE = 3;
const WORD = /\p{L}+/gu;
const LETTERS_ONLY = /^\p{L}+$/u;
const ALL_UPPER = /^\p{Lu}+$/u;
const LEADING_UPPER = /^\p{Lu}/u;

function counted(map: Map<string, number>, word: string): void {
    map.set(word, (map.get(word) ?? 0) + 1);
}

/** Count the words of the runs `clean` admits (a sound encoding), document-wide and per page. */
export function buildLexicon(runs: readonly RawTextRun[], clean: (run: RawTextRun) => boolean): Lexicon {
    const document = new Map<string, number>();
    const pages = new Map<number, Map<string, number>>();
    for (const run of runs) {
        if (!clean(run)) {
            continue;
        }
        const page = pages.get(run.pageIndex) ?? new Map<string, number>();
        pages.set(run.pageIndex, page);
        for (const word of run.text.toLowerCase().match(WORD) ?? []) {
            counted(document, word);
            counted(page, word);
        }
    }
    return { document, pages };
}

/** Whether `a` and `b` (same length) differ in exactly one letter. */
function oneLetterApart(a: string, b: string): boolean {
    const x = [...a];
    const y = [...b];
    return x.length === y.length && x.filter((ch, i) => ch !== y[i]).length === 1;
}

/** The one candidate printed at least `MIN_KNOWN` times and `DOMINANCE` times as often as any other, if any. */
function dominant(word: string, counts: ReadonlyMap<string, number> | undefined): string | null {
    if (counts === undefined) {
        return null;
    }
    const candidates = [...counts]
        .filter(([known]) => oneLetterApart(word, known))
        .sort((a, b) => numAsc(b[1], a[1]) || byteCompare(a[0], b[0]));
    const [best, next] = candidates;
    if (best === undefined || best[1] < MIN_KNOWN) {
        return null;
    }
    return next === undefined || best[1] >= DOMINANCE * next[1] ? best[0] : null;
}

/** `word` set in the case pattern of `like` (all capitals, a leading capital, or lower case). */
function inCaseOf(word: string, like: string): string {
    if (ALL_UPPER.test(like)) {
        return word.toUpperCase();
    }
    return LEADING_UPPER.test(like) ? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}` : word;
}

export type Vouched = { text: string; known: true } | { text: string; known: false };

/**
 * What the document says of an OCR word read on `pageIndex`: `known` with the
 * word itself when the document prints it; `known` with the correction when it
 * does not but one word a single letter away dominates — on the page first,
 * else in the whole document; otherwise not known, the word unchanged. Only
 * the letters between any leading and trailing marks are judged ("ARI," keeps
 * its comma); words of fewer than `MIN_LETTERS` letters, or with digits or
 * marks inside, are never known.
 */
export function vouch(text: string, pageIndex: number, lexicon: Lexicon): Vouched {
    const match = /^(\P{L}*)(.*?)(\P{L}*)$/u.exec(text);
    const [, lead = "", core = "", trail = ""] = match ?? [];
    if ([...core].length < MIN_LETTERS || !LETTERS_ONLY.test(core)) {
        return { text, known: false };
    }
    const lower = core.toLowerCase();
    if ((lexicon.document.get(lower) ?? 0) >= MIN_KNOWN) {
        return { text, known: true };
    }
    const correction = dominant(lower, lexicon.pages.get(pageIndex)) ?? dominant(lower, lexicon.document);
    return correction === null
        ? { text, known: false }
        : { text: `${lead}${inCaseOf(correction, core)}${trail}`, known: true };
}
