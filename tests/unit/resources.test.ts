// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    ENGINE_BASE_MB,
    estimateMemoryMb,
    looksOutOfMemory,
    OCR_WORKER_MB,
    PAGES_AHEAD_PER_WORKER,
    PDF_COPIES,
    planResources,
    RENDERED_PAGE_MB,
} from "../../web/resources.ts";

const MB = 1024 * 1024;
const PER_WORKER = OCR_WORKER_MB + PAGES_AHEAD_PER_WORKER * RENDERED_PAGE_MB;

describe("resource plan", () => {
    it("uses every chosen core when there is no budget", () => {
        expect(planResources(8, null, 100 * MB)).toEqual({
            ocrWorkers: 8,
            maxInFlight: 8 * PAGES_AHEAD_PER_WORKER,
            overBudget: false,
        });
    });

    it("never plans fewer than one worker", () => {
        expect(planResources(0, null, 0).ocrWorkers).toBe(1);
    });

    it("fits the workers in the budget left after the PDFs", () => {
        const pdf = 100 * MB;
        const budget = ENGINE_BASE_MB + PDF_COPIES * 100 + 3 * PER_WORKER + 1;
        expect(planResources(8, budget, pdf)).toEqual({
            ocrWorkers: 3,
            maxInFlight: 3 * PAGES_AHEAD_PER_WORKER,
            overBudget: false,
        });
    });

    it("keeps to the core count when the budget would allow more", () => {
        expect(planResources(2, 64 * 1024, MB).ocrWorkers).toBe(2);
    });

    it("estimates the engine, the PDF copies, the workers and the pages in flight", () => {
        const plan = planResources(4, null, 0);
        expect(estimateMemoryMb(plan, 10 * MB)).toBe(
            ENGINE_BASE_MB +
                PDF_COPIES * 10 +
                4 * OCR_WORKER_MB +
                4 * PAGES_AHEAD_PER_WORKER * RENDERED_PAGE_MB,
        );
    });

    it("recognises an out-of-memory report and nothing else", () => {
        expect(looksOutOfMemory("RangeError: Array buffer allocation failed")).toBe(true);
        expect(looksOutOfMemory("Aborted(OOM)")).toBe(true);
        expect(looksOutOfMemory("Cannot enlarge memory arrays")).toBe(true);
        expect(looksOutOfMemory("tab ran out of memory")).toBe(true);
        expect(looksOutOfMemory("Detected 40 diacritics")).toBe(false);
        expect(looksOutOfMemory("info: OCR: 25/145 pages recognized")).toBe(false);
        // A word merely containing the letters is not a report.
        expect(looksOutOfMemory("broom closet")).toBe(false);
    });

    it("runs one worker and flags it when the budget cannot hold one", () => {
        expect(planResources(8, 100, 100 * MB)).toEqual({
            ocrWorkers: 1,
            maxInFlight: PAGES_AHEAD_PER_WORKER,
            overBudget: true,
        });
    });
});
