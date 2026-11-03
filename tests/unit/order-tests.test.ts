import { describe, expect, it } from "vitest";

import { applyOrderTests } from "../../src/infer/order-tests.ts";
import type { Entity, JsonObject } from "../../src/types/entity.ts";

const order = (name: string, effect: string): Entity => ({
    documentType: "Item",
    group: "rt",
    pack: "p",
    blockId: "b",
    ordinal: 0,
    fields: { name, type: "order", system: { effect: { rt: `<p>${effect}</p>` } } },
    images: {},
    provenance: { pageIndex: 0, y: 0 },
});

const testOf = (e: Entity): unknown => (e.fields["system"] as JsonObject)["test"];

describe("order tests", () => {
    it("reads the test an order's text first asks for", () => {
        const mend = order(
            "Mend Lamps",
            "The character makes a Difficult (–10) Lamp-Craft Test to mend the lamps. If he succeeds, he makes an Ordinary (+10) Glow Test.",
        );
        const steer = order(
            "Steer",
            "The helmsman makes a Hard (-20) Pilot (Lamp Barge)+ Manoeuvrability Test.",
        );
        const look = order("Look Out", "ThecharactermakesaChallenging(+0)Gazing +Detection Test to scan.");
        const hold = order("Hold", "The character must make a Challenging (+0) Willpower Test.");
        const plain = order("Drift", "The ship drifts. It may not fire.");
        applyOrderTests([mend, steer, look, hold, plain]);
        expect(testOf(mend)).toEqual({ skill: "Lamp-Craft", characteristic: "", modifier: -10 });
        expect(testOf(steer)).toEqual({
            skill: "Pilot (Lamp Barge)",
            characteristic: "",
            modifier: -20,
            shipStat: "manoeuvrability",
        });
        expect(testOf(look)).toEqual({
            skill: "Gazing",
            characteristic: "",
            modifier: 0,
            shipStat: "detection",
        });
        expect(testOf(hold)).toEqual({ skill: "", characteristic: "Willpower", modifier: 0 });
        expect(testOf(plain)).toBeUndefined();
    });
});
