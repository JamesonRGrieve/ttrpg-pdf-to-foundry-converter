// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyFocusSkillCharacteristics } from "../../src/infer/entry-types.ts";
import type { Entity, JsonObject } from "../../src/types/entity.ts";

const entity = (fields: Entity["fields"]): Entity => ({
    documentType: "Item",
    group: "g",
    pack: "p",
    blockId: "b",
    ordinal: 0,
    fields,
    images: {},
    provenance: { pageIndex: 0, y: 0 },
});

const power = (name: string, skill: string): Entity =>
    entity({
        name,
        type: "psychicPower",
        system: { focusPower: { characteristic: "willpower", modifier: 0, skill } },
    });

const focusOf = (e: Entity): JsonObject => (e.fields["system"] as JsonObject)["focusPower"] as JsonObject;

describe("focus skill characteristics", () => {
    it("tests a power's focus skill against the characteristic the document's skill entry prints", () => {
        const skill = entity({ name: "Lamp Sight", type: "skill", system: { characteristic: "perception" } });
        const scry = power("Scry", "lampsight");
        const ward = power("Ward", "wickcraft");
        applyFocusSkillCharacteristics([skill, scry, ward]);
        expect(focusOf(scry)["characteristic"]).toBe("perception");
        // A skill the document does not describe leaves the power as read.
        expect(focusOf(ward)["characteristic"]).toBe("willpower");
    });
});
