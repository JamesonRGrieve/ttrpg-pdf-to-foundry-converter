// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";
import { slugify } from "../util/slug.ts";

/** Longest book segment (characters); pack and file names are built from it. */
export const MAX_BOOK_SLUG = 80;
/** Runs within this share of their size of one baseline are one line. */
const LINE_SHARE = 0.5;

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
 * The book segment of pack names, taken from the PDF itself: its metadata
 * title, slugged, falling back to the topmost line of the largest text on the
 * first page with text. This names the output after whatever the file calls
 * itself; it is not matched against anything. Bounded in length, so a long
 * title never makes a file name too long to write.
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

/** The PDF's metadata title, else the topmost line of the first page's largest text; null when neither reads. */
function rawTitle(ir: IR): string | null {
    if (ir.meta.title !== null && /[\p{L}\p{N}]/u.test(ir.meta.title)) {
        return ir.meta.title;
    }
    if (ir.runs.length === 0) {
        return null;
    }
    const firstPage = Math.min(...ir.runs.map((r) => r.pageIndex));
    const pageRuns = ir.runs.filter((r) => r.pageIndex === firstPage);
    const largest = Math.max(...pageRuns.map((r) => r.size));
    const display = pageRuns.filter((r) => r.size === largest);
    const top = Math.max(...display.map((r) => r.y));
    const title = display
        .filter((r) => top - r.y <= LINE_SHARE * largest)
        .sort((a, b) => a.x - b.x)
        .map((r) => r.text)
        .join(" ");
    return /[\p{L}\p{N}]/u.test(title) ? title : null;
}
