// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyCyberneticTypes } from "../../src/infer/cybernetic-types.ts";
import { parseCyberneticType } from "../../src/infer/notation.ts";
import type { Entity } from "../../src/types/entity.ts";

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

describe("cybernetic types", () => {
    it("reads the cybernetic type a name names", () => {
        expect(parseCyberneticType("Lamp Mechadendrite")).toBe("mechadendrite");
        expect(parseCyberneticType("Glow Implants")).toBe("implant");
        expect(parseCyberneticType("Bionic Wick")).toBe("bionic");
        expect(parseCyberneticType("Integrated Weapon Mount")).toBe("integrated-weapon");
    });

    it("names none for a name naming no type, nor the initial one", () => {
        expect(parseCyberneticType("Ember Heart")).toBeNull();
        expect(parseCyberneticType("Replacement Wick")).toBeNull();
    });

    it("types a cybernetic, and one an actor carries, unless a reading typed it", () => {
        const own = entity({ type: "cybernetic", name: "Lamp Mechadendrite", system: {} });
        const typed = entity({ type: "cybernetic", name: "Glow Implants", system: { type: "bionic" } });
        const gear = entity({ type: "gear", name: "Wick Implant", system: {} });
        const actor = entity({
            type: "npc",
            name: "Lamplighter",
            system: {},
            items: [{ type: "cybernetic", name: "Bionic Wick", system: {} }],
        });
        applyCyberneticTypes([own, typed, gear, actor]);
        expect(own.fields["system"]).toEqual({ type: "mechadendrite" });
        expect(typed.fields["system"]).toEqual({ type: "bionic" });
        expect(gear.fields["system"]).toEqual({});
        expect(actor.fields["items"]).toEqual([
            { type: "cybernetic", name: "Bionic Wick", system: { type: "bionic" } },
        ]);
    });
});
