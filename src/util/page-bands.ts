// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";

/**
 * Share of the page height, top and bottom, treated as margin when finding
 * column gutters: a coarse bound, generous enough to hold any running head,
 * footer or folio.
 */
export const FURNITURE_BAND = 0.06;

/** Whether a baseline at `y` (PDF points, origin bottom-left) lies in a coarse top or bottom margin band. */
export function inFurnitureBand(y: number, pageHeight: number): boolean {
    return y < pageHeight * FURNITURE_BAND || y > pageHeight * (1 - FURNITURE_BAND);
}

/** Measured margin bands as shares of page height: furniture lies below `bottom` or above `top`. */
export interface MarginBands {
    bottom: number;
    top: number;
}

/** Histogram bin width, as a share of page height. */
const BIN = 0.005;
/** A bin with fewer runs than this share of the edge cluster's peak separates furniture from body. */
const GAP_SHARE = 0.02;
/** An edge cluster needs at least this many runs per page to be running furniture. */
const MIN_RUNS_PER_PAGE = 0.5;

/**
 * Where a document's running heads, feet and folios sit, measured from the
 * text itself: at each page edge (within the coarse band), the densest bin
 * marks a furniture cluster when it recurs on most pages; the band ends at the
 * first near-empty bin between that cluster and the body. An edge with no such
 * cluster has no band.
 */
export function measureMarginBands(
    baselines: readonly { y: number; pageHeight: number }[],
    pages: number,
): MarginBands {
    const bins = new Map<number, number>();
    for (const { y, pageHeight } of baselines) {
        if (pageHeight > 0) {
            const bin = Math.floor(y / pageHeight / BIN);
            bins.set(bin, (bins.get(bin) ?? 0) + 1);
        }
    }
    const reach = Math.ceil(FURNITURE_BAND / BIN);
    const last = Math.floor(1 / BIN) - 1;
    const count = (b: number): number => bins.get(b) ?? 0;
    /** Scan inward from the edge bin `from` (step ±1); return the first body bin, or null for no band. */
    const edge = (from: number, step: 1 | -1): number | null => {
        const zone = Array.from({ length: reach }, (_, i) => from + i * step);
        const peak = zone.reduce((best, b) => (count(b) > count(best) ? b : best), from);
        if (count(peak) < MIN_RUNS_PER_PAGE * pages) {
            return null;
        }
        for (let b = peak; step === 1 ? b <= from + reach * step : b >= from + reach * step; b += step) {
            if (count(b) < GAP_SHARE * count(peak)) {
                return b;
            }
        }
        return null;
    };
    const bottomGap = edge(0, 1);
    const topGap = edge(last, -1);
    return {
        bottom: bottomGap === null ? 0 : bottomGap * BIN,
        top: topGap === null ? 1 : (topGap + 1) * BIN,
    };
}

/** The measured margin bands of a document's text. */
export function marginBandsOf(ir: IR): MarginBands {
    const heights = new Map(ir.pages.map((p) => [p.pageIndex, p.height] as const));
    return measureMarginBands(
        ir.runs
            .filter((r) => r.text.trim().length > 0)
            .map((r) => ({ y: r.y, pageHeight: heights.get(r.pageIndex) ?? 0 })),
        ir.pages.length,
    );
}

/** Whether a baseline at `y` lies in a measured margin band. */
export function inMarginBand(y: number, pageHeight: number, bands: MarginBands): boolean {
    return y < pageHeight * bands.bottom || y > pageHeight * bands.top;
}

/**
 * Share of the page width, left and right, that is side margin: text set
 * wholly inside it (a thumb-index tab, a marginal note) lies outside the
 * text block.
 */
export const SIDE_MARGIN = 0.07;

/** Whether text spanning `left`..`right` lies wholly in a side margin of a page `pageWidth` wide. */
export function inSideMargin(left: number, right: number, pageWidth: number): boolean {
    return left >= pageWidth * (1 - SIDE_MARGIN) || right <= pageWidth * SIDE_MARGIN;
}
