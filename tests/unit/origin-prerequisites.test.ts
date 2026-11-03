import { describe, expect, it } from "vitest";
import { applyOriginPrerequisites } from "../../src/infer/origin-prerequisites.ts";
import { TARGETS } from "../../src/infer/targets.ts";
import { emit } from "../../src/stages/emit.ts";
import type { Entity, JsonObject } from "../../src/types/entity.ts";

const origin = (ordinal: number, name: string, step: string, requirements = ""): Entity => ({
    documentType: "Item",
    group: "dh2",
    pack: `dh2-b-${step}`,
    blockId: `origin:${step}`,
    ordinal,
    fields: { name, type: "originPath", system: { step, requirements: { text: requirements } } },
    images: {},
    provenance: { pageIndex: 0, y: 0 },
});

const gatesOf = (e: Entity): unknown => (e.fields["system"] as JsonObject)["prerequisites"];
const steps = TARGETS.dh2.originSteps;

describe("origin prerequisites", () => {
    it("reads characteristic and influence minimums printed as list items", () => {
        const knight = origin(0, "Lamp Knight", "elite", "• Influence: 45 • Willpower: 35 • Guidance: Rare.");
        applyOriginPrerequisites([knight], steps);
        expect(gatesOf(knight)).toEqual([
            { type: "influence", key: "influence", value: 45 },
            { type: "characteristic", key: "willpower", value: 35 },
        ]);
    });

    it("names another origin of the document the step requires or forbids", () => {
        const seer = origin(
            0,
            "Seer",
            "elite",
            [
                "• Willpower: 40",
                "• Dim: Characters with the Blank elite advance cannot gain the Seer elite advance.",
                "• Unbound: Characters without the Lamp Order background who gain the Seer elite advance are not bound.",
            ].join(" "),
        );
        const blank = origin(
            1,
            "Blank",
            "elite",
            "• Bright: Characters with the Seer elite advance cannot gain the Blank elite advance.",
        );
        const order = origin(2, "Lamp Order", "background");
        const bound = origin(
            3,
            "Bound Seer",
            "elite",
            [
                "• Lamp Order Background: Only members of the order may train.",
                "• Sworn: A character must possess the Seer elite advance and the Far Shore background.",
            ].join(" "),
        );
        applyOriginPrerequisites([seer, blank, order, bound], steps);
        expect(gatesOf(seer)).toEqual([
            { type: "characteristic", key: "willpower", value: 40 },
            { type: "notOrigin", key: "{{ref:origin:elite#1:referenced}}" },
        ]);
        expect(gatesOf(blank)).toEqual([{ type: "notOrigin", key: "{{ref:origin:elite#0:referenced}}" }]);
        // An origin the document does not print ("Far Shore") is not named.
        expect(gatesOf(bound)).toEqual([
            { type: "origin", key: "{{ref:origin:background#2:referenced}}" },
            { type: "origin", key: "{{ref:origin:elite#0:referenced}}" },
        ]);
        expect(gatesOf(order)).toBeUndefined();

        const emitted = emit({ entities: [seer, blank, order, bound], warnings: [] }, new Map(), {
            assetRefPrefix: "a",
        });
        const docs = [...emitted.packs.values()].flatMap((p) => p.documents);
        const idOf = (name: string): unknown => docs.find((d) => d["name"] === name)?.["_id"];
        const seerDoc = docs.find((d) => d["name"] === "Seer");
        expect((seerDoc?.["system"] as JsonObject)["prerequisites"]).toContainEqual({
            type: "notOrigin",
            key: `Compendium.{module}.dh2-b-elite.Item.${String(idOf("Blank"))}`,
        });
        expect(emitted.warnings).toEqual([]);
    });
});
