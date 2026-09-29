// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";
import { numAsc } from "../util/ordered.ts";

/**
 * Printed page numbering, inferred from page furniture. Printed folios sit in
 * the top or bottom margin band as bare numbers that advance one per page, so
 * `folio − pageIndex` is constant across the body of the book. The most common
 * such offset (ties → smallest) maps any PDF page to its printed number — the
 * page citation compendium entries carry.
 */

/** Share of the page height, from the top and from the bottom, searched for folios. */
const MARGIN_BAND = 0.08;
/** Pages that must agree on an offset before it is trusted. */
const MIN_AGREEING_PAGES = 3;

export interface PageNumbering {
    offset: number;
    /** Pages whose folio agreed with `offset`. */
    support: number;
}

export function inferPageNumbering(ir: IR): PageNumbering {
    const heights = new Map(ir.pages.map((p) => [p.pageIndex, p.height] as const));
    const votes = new Map<number, Set<number>>();
    for (const run of ir.runs) {
        if (!/^\d{1,4}$/u.test(run.text)) {
            continue;
        }
        const height = heights.get(run.pageIndex) ?? 0;
        const inBand = run.y < height * MARGIN_BAND || run.y > height * (1 - MARGIN_BAND);
        if (!inBand) {
            continue;
        }
        const offset = Number(run.text) - run.pageIndex;
        const pages = votes.get(offset) ?? new Set<number>();
        pages.add(run.pageIndex);
        votes.set(offset, pages);
    }
    let best: PageNumbering = { offset: 1, support: 0 };
    for (const [offset, pages] of [...votes.entries()].sort((a, b) => numAsc(a[0], b[0]))) {
        const support = pages.size;
        if (support > best.support) {
            best = { offset, support };
        }
    }
    // Without consistent folios, fall back to 1-based PDF page numbers.
    return best.support >= MIN_AGREEING_PAGES ? best : { offset: 1, support: 0 };
}

export function printedPage(numbering: PageNumbering, pageIndex: number): string {
    return String(pageIndex + numbering.offset);
}
