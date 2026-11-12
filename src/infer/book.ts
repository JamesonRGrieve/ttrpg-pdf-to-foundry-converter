// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";
import { slugify } from "../util/slug.ts";

/** Longest book segment (characters); pack and file names are built from it. */
export const MAX_BOOK_SLUG = 80;
/** Runs within this share of their size of one baseline are one line. */
const LINE_SHARE = 0.5;
/** Pages from the start a copyright notice naming the title is looked for on. */
const NOTICE_PAGES = 6;
/** Most words a title before a copyright sign runs to. */
const MAX_NOTICE_TITLE_WORDS = 10;
/** Shortest word checked against the document's own vocabulary. */
const CHECKED_WORD = 3;
/** Fewest such words a title read from the cover runs to. */
const MIN_COVER_TITLE_WORDS = 2;

/** A slug cut back to whole words within `MAX_BOOK_SLUG`. */
function bounded(slug: string): string {
    if (slug.length <= MAX_BOOK_SLUG) {
        return slug;
    }
    const cut = slug.slice(0, MAX_BOOK_SLUG + 1);
    const end = cut.lastIndexOf("-");
    return end > 0 ? cut.slice(0, end) : slug.slice(0, MAX_BOOK_SLUG);
}

/**
 * The book segment of pack names, taken from the PDF itself (see
 * `rawTitle`). This names the output after whatever the file calls itself;
 * it is not matched against anything. Bounded in length, so a long title
 * never makes a file name too long to write.
 */
export function inferBookSlug(ir: IR): string {
    const title = rawTitle(ir);
    return title === null ? "untitled" : bounded(slugify(title));
}

/** Longest book title (characters) written into a document's source record. */
export const MAX_BOOK_TITLE = 120;

/**
 * The book's title as the PDF gives it, for the source record a reader sees
 * ("Title, p.12"): the same title the slug is made from, with its whitespace
 * collapsed, cut back to whole words within `MAX_BOOK_TITLE`.
 */
export function inferBookTitle(ir: IR): string {
    const title = rawTitle(ir)?.replace(/\s+/gu, " ").trim();
    if (title === undefined || title.length === 0) {
        return "Untitled";
    }
    if (title.length <= MAX_BOOK_TITLE) {
        return title;
    }
    const cut = title.slice(0, MAX_BOOK_TITLE + 1);
    const end = cut.lastIndexOf(" ");
    return end > 0 ? cut.slice(0, end) : title.slice(0, MAX_BOOK_TITLE);
}

/**
 * A metadata title read as the document's name: a file name's stem, its
 * extension dropped ("Lamp Lore.indb" → "Lamp Lore"); null for an
 * application's default name ("Untitled-4"), which names nothing.
 */
export function metadataTitle(title: string): string | null {
    const stem = title
        .trim()
        .replace(/\.[a-z][a-z0-9]{1,4}$/iu, "")
        .trim();
    return /^untitled\b/iu.test(stem) || !/[\p{L}\p{N}]/u.test(stem) ? null : stem;
}

/**
 * The title a copyright notice names, where it opens with one: a line's
 * text up to a copyright sign ("Lamp Lore: The Wick © …"), in title case,
 * its series prefix before a colon dropped.
 */
export function noticeTitle(text: string): string | null {
    for (const m of text.matchAll(/^([^.!?©()\n]+?)\s*©/gmu)) {
        const phrase = (m[1] ?? "")
            .replace(/\bcopyright\b/giu, "")
            .replace(/\s+/gu, " ")
            .trim();
        const words = phrase.split(" ").filter((w) => /\p{L}/u.test(w));
        const titled = words.every((w, i) => /^\p{Lu}/u.test(w) || (i > 0 && /^\p{Ll}{1,4}$/u.test(w)));
        if (words.length === 0 || words.length > MAX_NOTICE_TITLE_WORDS || !titled || /\d{4}/u.test(phrase)) {
            continue;
        }
        const title = phrase.split(/:\s+/u).at(-1)?.trim() ?? phrase;
        return title.length > 0 ? title : null;
    }
    return null;
}

/** The words of a text, lower-cased. */
const wordsOf = (text: string): string[] => text.toLowerCase().match(/\p{L}+/gu) ?? [];

/**
 * Whether a cover line reads as words the document itself prints: each of its
 * longer words appears in the document's text off the cover. Display type
 * read from cover art gives fragments ("rusade", one or two letters) that
 * the rest of the document never prints.
 */
export function readsAsTitle(line: string, vocabulary: ReadonlySet<string>): boolean {
    const words = wordsOf(line).filter((w) => w.length >= CHECKED_WORD);
    return words.length > 0 && words.every((w) => vocabulary.has(w));
}

/** A page's text in reading order, one printed line to a line. */
function pageText(runs: readonly IRTextRun[]): string {
    const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
    return sorted
        .map((r, i) => {
            const prev = sorted[i - 1];
            const newLine = prev !== undefined && prev.y - r.y > LINE_SHARE * Math.max(prev.size, r.size);
            return `${newLine ? "\n" : i === 0 ? "" : " "}${r.text}`;
        })
        .join("");
}

/**
 * The document's title, from the most trusted source that reads: its
 * metadata title (a file name's stem; not an application's default name), else the title a copyright notice on
 * an early page names, else the topmost line of the first page's largest
 * text when its words are the document's own; null when none reads.
 */
function rawTitle(ir: IR): string | null {
    const meta = ir.meta.title === null ? null : metadataTitle(ir.meta.title);
    if (meta !== null) {
        return meta;
    }
    if (ir.runs.length === 0) {
        return null;
    }
    const pages = [...new Set(ir.runs.map((r) => r.pageIndex))].sort((a, b) => a - b);
    // A title the book prints elsewhere: the words of a logo or an address
    // set on the notice's line are printed nowhere else.
    const vocabularyOff = (page: number): Set<string> =>
        new Set(ir.runs.filter((r) => r.pageIndex !== page).flatMap((r) => wordsOf(r.text)));
    for (const p of pages.slice(0, NOTICE_PAGES)) {
        const title = noticeTitle(pageText(ir.runs.filter((r) => r.pageIndex === p)));
        if (title !== null && readsAsTitle(title, vocabularyOff(p))) {
            return title;
        }
    }
    const firstPage = pages[0] ?? 0;
    const pageRuns = ir.runs.filter((r) => r.pageIndex === firstPage);
    const largest = Math.max(...pageRuns.map((r) => r.size));
    const display = pageRuns.filter((r) => r.size === largest);
    const top = Math.max(...display.map((r) => r.y));
    const title = display
        .filter((r) => top - r.y <= LINE_SHARE * largest)
        .sort((a, b) => a.x - b.x)
        .map((r) => r.text)
        .join(" ");
    // A lone word from a cover ("ROLE") is a fragment of its art or banner, not a title.
    const named = wordsOf(title).filter((w) => w.length >= CHECKED_WORD).length >= MIN_COVER_TITLE_WORDS;
    return named && readsAsTitle(title, vocabularyOff(firstPage)) ? title : null;
}
