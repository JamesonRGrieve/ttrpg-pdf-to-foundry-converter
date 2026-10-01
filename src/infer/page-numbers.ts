// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";
import { numAsc } from "../util/ordered.ts";

/**
 * Printed page numbering, inferred from page furniture. Printed folios sit in
 * the top or bottom margin band as bare numbers that advance one per page, so
 * `folio − pageIndex` is constant across a run of pages. The most common such
 * offset (ties → smallest) numbers the book — the page citation compendium
 * entries carry — except where a PDF joins parts numbered apart (a body, an
 * appendix numbered anew): a region of at least MIN_REGION_PAGES pages whose
 * folios agree on another offset, each within CONFIRMING_REACH of the next,
 * numbers the pages it spans by its own.
 */

/** Share of the page height, from the top and from the bottom, searched for folios. */
const MARGIN_BAND = 0.08;
/** Pages that must agree on an offset before it is trusted. */
const MIN_AGREEING_PAGES = 3;
/** Pages apart two folios of one region may sit. */
const CONFIRMING_REACH = 3;
/** Fewest pages with agreeing folios that number a region of their own. */
const MIN_REGION_PAGES = 5;

/** A run of pages numbered by one offset. */
export interface NumberedRegion {
    first: number;
    last: number;
    offset: number;
    support: number;
}

export interface PageNumbering {
    offset: number;
    /** Pages whose folio agreed with `offset`. */
    support: number;
    /** Regions numbered by an offset of their own. */
    regions: readonly NumberedRegion[];
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
    let best = { offset: 1, support: 0 };
    for (const [offset, pages] of [...votes.entries()].sort((a, b) => numAsc(a[0], b[0]))) {
        const support = pages.size;
        if (support > best.support) {
            best = { offset, support };
        }
    }
    // Without consistent folios, fall back to 1-based PDF page numbers.
    if (best.support < MIN_AGREEING_PAGES) {
        return { offset: 1, support: 0, regions: [] };
    }
    const regions: NumberedRegion[] = [];
    for (const [offset, pages] of votes) {
        if (offset === best.offset) {
            continue;
        }
        let run: number[] = [];
        const close = (): void => {
            const [first] = run;
            const last = run.at(-1);
            if (run.length >= MIN_REGION_PAGES && first !== undefined && last !== undefined) {
                regions.push({ first, last, offset, support: run.length });
            }
            run = [];
        };
        for (const page of [...pages].sort(numAsc)) {
            const previous = run.at(-1);
            if (previous !== undefined && page - previous > CONFIRMING_REACH) {
                close();
            }
            run.push(page);
        }
        close();
    }
    return { ...best, regions: regions.sort((a, b) => numAsc(a.first, b.first)) };
}

export function printedPage(numbering: PageNumbering, pageIndex: number): string {
    // The largest region spanning the page numbers it; elsewhere the book's offset.
    const spanning = numbering.regions
        .filter((r) => r.first <= pageIndex && pageIndex <= r.last)
        .sort((a, b) => numAsc(b.support, a.support) || numAsc(a.first, b.first));
    return String(pageIndex + (spanning[0]?.offset ?? numbering.offset));
}
