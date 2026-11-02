// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyDefaultIcons, ICON_CDN, ICONS, iconFor, iconRoleFor } from "../../src/infer/icons.ts";
import type { Entity, JsonObject } from "../../src/types/entity.ts";

const doc = (type: string, name: string, system: JsonObject = {}): JsonObject => ({ type, name, system });

const entity = (fields: JsonObject, documentType: Entity["documentType"] = "Item"): Entity => ({
    blockId: "b",
    documentType,
    group: "dh2",
    pack: "p",
    ordinal: 0,
    fields,
    images: {},
    provenance: { pageIndex: 0, y: 0 },
});

describe("default icons by function", () => {
    it("chooses a weapon's icon by natural attack, type, generic arm, then class", () => {
        expect(iconRoleFor(doc("weapon", "Raking Claws"))).toBe("weapon.claw");
        expect(iconRoleFor(doc("weapon", "Lamp Pistol", { type: "las", class: "pistol" }))).toBe(
            "weapon.las",
        );
        expect(iconRoleFor(doc("weapon", "Tin Bomb", { type: "explosive", class: "thrown" }))).toBe(
            "weapon.grenade",
        );
        expect(iconRoleFor(doc("weapon", "Wick Hatchet", { class: "melee" }))).toBe("weapon.axe");
        expect(iconRoleFor(doc("weapon", "Lamplighter", { class: { dh2: "basic" } }))).toBe("weapon.basic");
        expect(iconRoleFor(doc("weapon", "Lamplighter"))).toBe("weapon.default");
    });

    it("chooses armour by type, a talent by first aptitude then category, a power by discipline", () => {
        expect(iconRoleFor(doc("armour", "Quilted Jerkin", { type: "primitive" }))).toBe("armour.primitive");
        expect(iconRoleFor(doc("armour", "Quilted Jerkin"))).toBe("armour.default");
        expect(iconRoleFor(doc("talent", "Lantern Sense", { aptitudes: ["Perception", "Fieldcraft"] }))).toBe(
            "talent.perception",
        );
        expect(iconRoleFor(doc("talent", "Steady", { aptitudes: [], category: "social" }))).toBe(
            "talent.social",
        );
        expect(iconRoleFor(doc("talent", "Steady"))).toBe("talent.default");
        expect(iconRoleFor(doc("psychicPower", "Spark", { discipline: "Pyromancy" }))).toBe(
            "psychic.pyromancy",
        );
        expect(iconRoleFor(doc("psychicPower", "Spark", { discipline: "" }))).toBe("psychic.default");
    });

    it("gives other covered types their default, craft actors the vehicle icon, and the rest nothing", () => {
        expect(iconRoleFor(doc("originPath", "Lamp World"))).toBe("originPath.default");
        expect(iconRoleFor(doc("trait", "Glow"))).toBe("trait.default");
        expect(iconRoleFor(doc("dh2-terracraft", "Wagon"))).toBe("vehicle.default");
        expect(iconRoleFor(doc("dh2-npc", "Moth"))).toBeNull();
        expect(iconRoleFor(doc("gear", "Lantern"))).toBeNull();
        // Conditions are named by their books; the engine carries no names to match.
        expect(iconRoleFor(doc("condition", "Dazzled"))).toBeNull();
        expect(iconFor(doc("trait", "Glow"))).toBe(`${ICON_CDN}/lorc/dna1.svg`);
    });

    it("maps every role a rule names to an icon", () => {
        const roles = [
            doc("weapon", "Claws"),
            doc("weapon", "x", { type: "melta" }),
            doc("armour", "x", { type: "void" }),
            doc("talent", "x", { aptitudes: ["Tech"] }),
            doc("psychicPower", "x", { discipline: "Sorcery" }),
            doc("shipComponent", "x", { componentType: "plasmaDrive" }),
        ].map((d) => iconRoleFor(d));
        for (const role of roles) {
            expect(role !== null && ICONS[role] !== undefined).toBe(true);
        }
    });

    it("fills only documents and embedded items without an image of their own", () => {
        const own = entity({ name: "Lantern", type: "weapon", img: "modules/x/assets/a.png", system: {} });
        const bare = entity({ name: "Wick Knife", type: "weapon", system: {} });
        const placed = entity({ name: "Glow", type: "trait", system: {} });
        placed.images["img"] = "asset1";
        const table = entity({ name: "Mutations", results: [] }, "RollTable");
        const actor = entity(
            {
                name: "Wagon",
                type: "dh2-terracraft",
                system: {},
                items: [
                    { name: "Bite", type: "weapon", system: {} },
                    { name: "Glow", type: "trait", system: {}, img: "modules/x/assets/b.png" },
                ],
            },
            "Actor",
        );
        applyDefaultIcons([own, bare, placed, table, actor]);
        expect(own.fields["img"]).toBe("modules/x/assets/a.png");
        expect(bare.fields["img"]).toBe(`${ICON_CDN}/lorc/broad-dagger.svg`);
        expect(placed.fields["img"]).toBeUndefined();
        expect(table.fields["img"]).toBeUndefined();
        expect(actor.fields["img"]).toBe(`${ICON_CDN}/lorc/tank.svg`);
        expect((actor.fields["items"] as JsonObject[]).map((i) => i["img"])).toEqual([
            `${ICON_CDN}/lorc/bestial-fangs.svg`,
            "modules/x/assets/b.png",
        ]);
    });
});
