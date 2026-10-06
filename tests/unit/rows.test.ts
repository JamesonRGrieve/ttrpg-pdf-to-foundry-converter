// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isLoadRow, mapRow, rowType } from "../../src/infer/rows.ts";

describe("weapon-table load rows", () => {
    const shell = {
        name: "Ember Shell",
        class: "—",
        range: "—",
        rof: "—",
        damage: "2d10+3 E",
        penetration: "4",
        clip: "—",
        special: "Blast (2), Flame",
        weight: "1kg",
        availability: "Scarce",
    };

    it("reads a row with damage but no class, range, rate of fire or clip as a load", () => {
        expect(isLoadRow(shell)).toBe(true);
        expect(rowType("weapon", shell)).toBe("ammunition");
    });

    it("reads every row of a table with no class, rate of fire or clip column as a weapon", () => {
        const melee = { name: "Iron Hook", range: "—", damage: "1d10+2 R", penetration: "1", weight: "3kg" };
        expect(isLoadRow(melee)).toBe(false);
        expect(rowType("weapon", melee)).toBe("weapon");
    });

    it("keeps wielded weapons and self-contained charges as weapons", () => {
        expect(rowType("weapon", { ...shell, class: "Pistol", range: "30m", rof: "S/-/-" })).toBe("weapon");
        expect(rowType("weapon", { ...shell, clip: "1" })).toBe("weapon");
        expect(rowType("weapon", { ...shell, damage: "—" })).toBe("weapon");
        expect(rowType("gear", shell)).toBe("gear");
    });

    it("drops weapon-table rows that print no weapon profile", () => {
        expect(rowType("weapon", { name: "Kettle whistle", availability: "—" })).toBeNull();
        expect(rowType("weapon", { name: "Sling", damage: "—", class: "—" })).toBeNull();
        expect(rowType("weapon", { name: "Hand-Cranked", class: "Weapons" })).toBeNull();
        expect(rowType("weapon", { name: "BANNER", clip: "LANTERN" })).toBeNull();
        expect(rowType("gear", { name: "Padded Coat" })).toBe("gear");
    });

    it("reads dashed armour points as no protection anywhere", () => {
        const mapped = mapRow("armour", { name: "Ward Plate", armourPoints: "—", protection: "40" });
        expect(mapped.variantized["armourPoints"]).toEqual({
            head: 0,
            body: 0,
            leftArm: 0,
            rightArm: 0,
            leftLeg: 0,
            rightLeg: 0,
        });
        expect(mapped.variantized).not.toHaveProperty("coverage");
    });

    it("drops armour-table rows that print no protective profile", () => {
        expect(rowType("armour", { name: "Padded Coat", armourPoints: "2", weight: "3kg" })).toBe("armour");
        expect(rowType("armour", { name: "Ward Plate", protection: "40" })).toBe("armour");
        expect(
            rowType("armour", { name: "SIDEBAR", maxAgility: "WARD-PATTERN", weight: "LANTERN" }),
        ).toBeNull();
    });

    it("maps a load's printed profile to its effect and added qualities", () => {
        const mapped = mapRow("ammunition", shell);
        expect(mapped.variantized).toEqual({
            effect: "2d10+3 E, Pen 4, Blast (2), Flame",
            addedQualities: ["blast-2", "flame"],
        });
        expect(mapped.system).toMatchObject({ weight: 1, availability: "scarce" });
        expect(mapped.unparsed).toEqual([]);
    });

    it("reads a dashed weight as negligible and leaves a dashed availability unset", () => {
        const mapped = mapRow("gear", { name: "Tin Whistle", weight: "—", availability: "—" });
        expect(mapped.system["weight"]).toBe(0);
        expect(mapped.system).not.toHaveProperty("availability");
    });

    it("maps an ammunition-table row by its effect column", () => {
        const mapped = mapRow("ammunition", {
            name: "Ember Rounds",
            effect: "Adds Flame.",
            availability: "Rare",
        });
        expect(mapped.variantized).toEqual({ effect: "Adds Flame." });
        expect(mapped.system).toMatchObject({ availability: "rare" });
    });
});

describe("ship weapon rows", () => {
    it("maps a ship weapon's fit, power drawn and strike profile", () => {
        const mapped = mapRow("shipWeapon", {
            name: "Wick Lance",
            hullTypes: "Light Cruisers, Cruisers",
            power: "9",
            space: "4",
            shipPoints: "2",
            strength: "1",
            damage: "1d10+4",
            crit: "3",
            range: "6",
            type: "Lances",
        });
        expect(mapped.unparsed).toEqual([]);
        expect(mapped.system).toEqual({
            hullType: ["light-cruiser", "cruiser"],
            space: 4,
            shipPoints: 2,
            power: 9,
            weaponType: "lance",
            strength: 1,
            crit: 3,
            range: 6,
            damage: "1d10+4",
        });
    });

    it("leaves dashed or note-marked strike values unset and reports unreadable ones", () => {
        const mapped = mapRow("shipWeapon", { name: "Wick Tubes", damage: "—", crit: "†", range: "6–40" });
        expect(mapped.system).not.toHaveProperty("damage");
        expect(mapped.system).not.toHaveProperty("crit");
        expect(mapped.unparsed).toEqual(["range: 6–40"]);
    });
});

describe("weapon classes and renown", () => {
    it("reads a second class printed after a slash, and a renown column", () => {
        const mapped = mapRow("weapon", {
            name: "Lamp Lance",
            class: "Melee/ Thrown",
            range: "—/10m",
            damage: "1d10+2 R",
            renown: "Famed",
        });
        expect(mapped.system["class"]).toBe("melee");
        expect(mapped.system["secondaryClass"]).toBe("thrown");
        expect(mapped.system["renown"]).toBe("famed");
    });

    it("sets no second class for a weapon of one class", () => {
        const mapped = mapRow("weapon", { name: "Wick Gun", class: "Basic", damage: "1d10 I" });
        expect(mapped.system).not.toHaveProperty("secondaryClass");
        expect(mapped.system).not.toHaveProperty("renown");
    });

    it("reads a placed explosive's class", () => {
        const mapped = mapRow("weapon", { name: "Lamp Charge", class: "Placed Explosive", damage: "2d10 X" });
        expect(mapped.system["class"]).toBe("placed");
    });
});
