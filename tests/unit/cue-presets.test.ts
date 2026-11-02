// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyCuePresets, cuePresetFor } from "../../src/infer/cue-presets.ts";
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

describe("cue presets", () => {
    it("settles a preset from a weapon type that names one or a synonym of one", () => {
        expect(cuePresetFor("las", "basic")).toBe("las");
        expect(cuePresetFor("solid-projectile", "pistol")).toBe("solid");
        expect(cuePresetFor("grenade", "thrown")).toBe("launcher");
        expect(cuePresetFor("shock", "melee")).toBe("arc");
        expect(cuePresetFor("primitive", "basic")).toBe("solid");
    });

    it("leaves a primitive or exotic melee weapon to the system's default", () => {
        expect(cuePresetFor("primitive", "melee")).toBeNull();
        expect(cuePresetFor("exotic", "melee")).toBeNull();
    });

    it("fills weapons, embedded ones too, and keeps an authored preset", () => {
        const pistol = entity({
            type: "weapon",
            name: "Glow Pistol",
            system: { type: "las", class: "pistol" },
        });
        const authored = entity({
            type: "weapon",
            name: "Ember Gun",
            system: { type: "las", cue: { preset: "flame", tint: "" } },
        });
        const npc = entity({
            type: "npc",
            name: "Warden",
            system: {},
            items: [{ type: "weapon", name: "Lamp Maul", system: { type: "power", class: "melee" } }],
        });
        applyCuePresets([pistol, authored, npc]);
        expect(pistol.fields["system"]).toEqual({ type: "las", class: "pistol", cue: { preset: "las" } });
        expect(authored.fields["system"]).toEqual({ type: "las", cue: { preset: "flame", tint: "" } });
        expect(npc.fields["items"]).toEqual([
            {
                type: "weapon",
                name: "Lamp Maul",
                system: { type: "power", class: "melee", cue: { preset: "power" } },
            },
        ]);
    });
});
