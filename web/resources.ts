// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How much of the machine a conversion uses: OCR runs in parallel workers
 * (one page each), and pages are rendered a little ahead of recognition. The
 * user picks a core count and, optionally, a memory budget; the plan fits the
 * workers and the pages in flight inside both. Output is the same whatever
 * the plan — only the speed and the memory held change.
 *
 * The memory figures are approximations of what each part holds in a
 * browser tab, used only to size the plan.
 */

/** Approximate memory one OCR worker holds (its engine, model and working images), in MB. */
export const OCR_WORKER_MB = 400;
/** A page rendered for recognition: 300 DPI greyscale, about 8.5 MB for a letter-size page. */
export const RENDERED_PAGE_MB = 9;
/** Copies of each PDF the engine holds while it reads (text layer, renderer, the upload itself). */
export const PDF_COPIES = 3;
/** Pages rendered ahead per worker, so a worker never waits for the renderer. */
export const PAGES_AHEAD_PER_WORKER = 2;

const MB = 1024 * 1024;

export interface ResourcePlan {
    /** OCR workers run side by side. */
    ocrWorkers: number;
    /** Pages rendered ahead of recognition at once. */
    maxInFlight: number;
    /** Whether the budget is too small for even one worker (the plan then uses one anyway). */
    overBudget: boolean;
}

/**
 * The plan for `cores` cores (at least one) and a memory budget in MB (null:
 * use everything), converting PDFs totalling `pdfBytes`.
 */
export function planResources(cores: number, budgetMb: number | null, pdfBytes: number): ResourcePlan {
    const coreCap = Math.max(1, Math.floor(cores));
    const perWorker = OCR_WORKER_MB + PAGES_AHEAD_PER_WORKER * RENDERED_PAGE_MB;
    let ocrWorkers = coreCap;
    let overBudget = false;
    if (budgetMb !== null) {
        const free = budgetMb - (PDF_COPIES * pdfBytes) / MB;
        const fits = Math.floor(free / perWorker);
        overBudget = fits < 1;
        ocrWorkers = Math.min(coreCap, Math.max(1, fits));
    }
    return { ocrWorkers, maxInFlight: ocrWorkers * PAGES_AHEAD_PER_WORKER, overBudget };
}
