// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyAmmunitionWeaponTypes, usedWithPieces, usedWithTypes } from "../../src/infer/ammunition.ts";
import type { Entity } from "../../src/types/entity.ts";

const entity = (type: string, name: string, system: Record<string, unknown> = {}): Entity =>
    ({ documentType: "Item", fields: { type, name, system } }) as unknown as Entity;

describe("ammunition weapon types", () => {
    const weapons = new Map([
        ["glimrevolver", "solid-projectile"],
        ["wickcannon", "solid-projectile"],
        ["lampgun", "las"],
    ]);

    it("splits a Used With line into the weapons it names", () => {
        expect(usedWithPieces("Glim revolvers, lamp guns (all types) and wick cannons.")).toEqual([
            "Glim revolvers",
            "lamp guns",
            "wick cannons",
        ]);
    });

    it("takes a type the line names, else the types of the document's weapons it names", () => {
        expect(usedWithTypes("All bolt weapons.", weapons)).toEqual(["bolt"]);
        expect(usedWithTypes("Glim revolvers, wick cannons and lamp guns.", weapons)).toEqual([
            "solid-projectile",
            "las",
        ]);
        expect(usedWithTypes("Ember throwers.", weapons)).toEqual([]);
    });

    it("fills an ammunition's weapon types from its printed line, keeping any it has", () => {
        const entities = [
            entity("weapon", "Glim Revolver", { type: "solid-projectile" }),
            entity("ammunition", "Wick Rounds"),
            entity("ammunition", "Lamp Cells", { weaponTypes: ["las"] }),
        ];
        applyAmmunitionWeaponTypes(
            entities,
            new Map([
                ["wickrounds", "Glim revolvers."],
                ["lampcells", "All bolt weapons."],
            ]),
        );
        expect(entities.map((e) => (e.fields["system"] as Record<string, unknown>)["weaponTypes"])).toEqual([
            undefined,
            ["solid-projectile"],
            ["las"],
        ]);
    });
});
