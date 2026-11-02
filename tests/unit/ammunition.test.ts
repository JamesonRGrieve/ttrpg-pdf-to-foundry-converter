// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    ammunitionEffect,
    applyAmmunitionEffects,
    applyAmmunitionWeaponTypes,
    usedWithArmourTypes,
    usedWithPieces,
    usedWithTypes,
} from "../../src/infer/ammunition.ts";
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

describe("ammunition effects", () => {
    it("reads the qualities an effect adds and removes", () => {
        expect(
            ammunitionEffect("<p>A weapon using wick rounds gains the Glowing (2) quality.</p>").added,
        ).toEqual(["glowing-2"]);
        expect(
            ammunitionEffect("Lamp shells add the Dazzle (2) and Flicker qualities to the weapon.").added,
        ).toEqual(["dazzle-2", "flicker"]);
        const swap = ammunitionEffect(
            "These rounds remove the Crude quality, and grant the weapon the Burst (1) quality. It also loses its Steady quality.",
        );
        expect(swap.added).toEqual(["burst-1"]);
        expect(swap.removed).toEqual(["crude", "steady"]);
    });

    it("reads flat damage and penetration amounts, not ones against some targets", () => {
        expect(ammunitionEffect("These rounds add 1 to a weapon’s damage and penetration.")).toMatchObject({
            damage: 1,
            penetration: 1,
        });
        expect(
            ammunitionEffect(
                "Glim slugs add 2 to the weapon’s damage, but armour counts double against them.",
            ),
        ).toMatchObject({ damage: 2 });
        expect(ammunitionEffect("Wick bolts reduce its damage by 2.")).toMatchObject({ damage: -2 });
        expect(
            ammunitionEffect("Lamp bolts add 3 to the weapon’s damage against targets with the Glass trait."),
        ).toMatchObject({ damage: 0 });
        expect(ammunitionEffect("Ember shot adds 3 to the weapon’s penetration.")).toMatchObject({
            penetration: 3,
        });
    });

    it("ignores a list that names no qualities", () => {
        expect(ammunitionEffect("The round gains the bright and steady quality of a lamp.").added).toEqual(
            [],
        );
    });

    it("writes what the effect does where no reading set it", () => {
        const read = entity("ammunition", "Wick Rounds", {
            effect: { dh2: "<p>Adds 2 to the weapon’s damage and gains the Glowing quality.</p>" },
        });
        const kept = entity("ammunition", "Lamp Cells", {
            effect: { dh2: "<p>Gains the Glowing quality.</p>" },
            addedQualities: ["flicker"],
        });
        applyAmmunitionEffects([read, kept]);
        expect(read.fields["system"]).toMatchObject({
            addedQualities: ["glowing"],
            modifiers: { damage: 2 },
        });
        expect(kept.fields["system"]).toMatchObject({ addedQualities: ["flicker"] });
    });
});

describe("armour a modification is used with", () => {
    it("names the schema's armour types a Used With line lists", () => {
        expect(usedWithArmourTypes("Carapace and power armour.")).toEqual(["carapace", "power"]);
        expect(usedWithArmourTypes("Flak, Mesh, Carapace, and Power armour")).toEqual([
            "flak",
            "mesh",
            "carapace",
            "power",
        ]);
        expect(usedWithArmourTypes("Any armour.")).toEqual(["any"]);
    });

    it("names none when a piece names no armour type", () => {
        expect(usedWithArmourTypes("Carapace armour and lamp hoods")).toEqual([]);
        expect(usedWithArmourTypes("Glow cloaks")).toEqual([]);
    });
});
