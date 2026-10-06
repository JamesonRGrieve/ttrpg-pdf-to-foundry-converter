// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
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
        const budget = PDF_COPIES * 100 + 3 * PER_WORKER + 1;
        expect(planResources(8, budget, pdf)).toEqual({
            ocrWorkers: 3,
            maxInFlight: 3 * PAGES_AHEAD_PER_WORKER,
            overBudget: false,
        });
    });

    it("keeps to the core count when the budget would allow more", () => {
        expect(planResources(2, 64 * 1024, MB).ocrWorkers).toBe(2);
    });

    it("runs one worker and flags it when the budget cannot hold one", () => {
        expect(planResources(8, 100, 100 * MB)).toEqual({
            ocrWorkers: 1,
            maxInFlight: PAGES_AHEAD_PER_WORKER,
            overBudget: true,
        });
    });
});
