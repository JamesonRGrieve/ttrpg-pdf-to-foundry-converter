// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { variantizeRulesFields } from "../../src/infer/schema.ts";
import type { JsonObject } from "../../src/types/entity.ts";

describe("per-line rules fields", () => {
    it("wraps a flat rules field in the line's variant container", () => {
        const system: JsonObject = { category: "tools", notes: "Lit by hand.", consumable: false, weight: 2 };
        variantizeRulesFields(system, "rt");
        expect(system).toEqual({
            category: { rt: "tools" },
            notes: { rt: "Lit by hand." },
            consumable: { rt: false },
            // Not a per-line rules field: left as it is.
            weight: 2,
        });
    });

    it("leaves a field already keyed by line, and an unauthored one", () => {
        const system: JsonObject = {
            effect: { dh2: "<p>Glows.</p>" },
            uses: { dh2: { __books: { core: { value: 1, max: 3 } } } },
            category: null,
        };
        variantizeRulesFields(system, "dh2");
        expect(system).toEqual({
            effect: { dh2: "<p>Glows.</p>" },
            uses: { dh2: { __books: { core: { value: 1, max: 3 } } } },
            category: null,
        });
    });

    it("wraps an object value that is not keyed by line", () => {
        const system: JsonObject = { uses: { value: 0, max: 5 } };
        variantizeRulesFields(system, "bc");
        expect(system["uses"]).toEqual({ bc: { value: 0, max: 5 } });
    });
});
