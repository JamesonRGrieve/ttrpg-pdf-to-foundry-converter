// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { PLANNED_SYSTEMS, plannedSystem, unavailableTarget } from "../../src/infer/planned.ts";
import { TARGET_IDS, targetFor } from "../../src/infer/targets.ts";

describe("planned systems", () => {
    it("are not offered as targets until their readers land", () => {
        for (const planned of PLANNED_SYSTEMS) {
            expect(TARGET_IDS).not.toContain(planned.target);
            expect(targetFor(planned.target)).toBeNull();
        }
    });

    it("each name a distinct system with its compatibility and character-option types", () => {
        const targets = PLANNED_SYSTEMS.map((p) => p.target);
        expect(new Set(targets).size).toBe(targets.length);
        for (const planned of PLANNED_SYSTEMS) {
            expect(planned.compatibility.minimum.length).toBeGreaterThan(0);
            expect(planned.characterOptionTypes.length).toBeGreaterThan(0);
            expect(new Set(planned.characterOptionTypes).size).toBe(planned.characterOptionTypes.length);
        }
    });

    it("explain a planned target apart from an unknown one", () => {
        expect(plannedSystem("pf2e")?.system).toBe("pf2e");
        expect(plannedSystem("nope")).toBeUndefined();
        expect(unavailableTarget("pf2e", ["dh2"])).toMatch(/planned, not available yet; choose one of dh2$/u);
        expect(unavailableTarget("nope", ["dh2"])).toBe('--target must be one of dh2, got "nope"');
    });
});
