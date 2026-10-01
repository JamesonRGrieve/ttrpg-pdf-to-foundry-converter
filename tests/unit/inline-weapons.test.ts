// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { inlineWeapons } from "../../src/infer/inline-weapons.ts";

describe("inlineWeapons", () => {
    it("reads each profile of a weapon list, placing parts by their notation", () => {
        const text =
            "Lamp Warden: Wick gun (Basic; 60m; −/3/10; 1d10+4 I; Pen 0; Clip 30; Reload Full; Inaccurate, Unreliable) or big wick gun (Heavy; 120m; −/−/10; 2d10+5 I; Pen 2; Clip 120; Reload 2 Full; Felling (2)).";
        expect(inlineWeapons(text)).toEqual([
            {
                name: "Wick Gun",
                cells: {
                    name: "Wick gun",
                    class: "Basic",
                    range: "60m",
                    rof: "−/3/10",
                    damage: "1d10+4 I",
                    penetration: "0",
                    clip: "30",
                    reload: "Full",
                    special: "Inaccurate, Unreliable",
                },
            },
            {
                name: "Big Wick Gun",
                cells: {
                    name: "big wick gun",
                    class: "Heavy",
                    range: "120m",
                    rof: "−/−/10",
                    damage: "2d10+5 I",
                    penetration: "2",
                    clip: "120",
                    reload: "2 Full",
                    special: "Felling (2)",
                },
            },
        ]);
    });

    it("reads a melee profile that leaves out range, rate of fire and clip", () => {
        expect(inlineWeapons("Weapons: Lamp-hook (Melee; 1d10+2 R; Pen 1; Balanced).")).toEqual([
            {
                name: "Lamp-hook",
                cells: {
                    name: "Lamp-hook",
                    class: "Melee",
                    damage: "1d10+2 R",
                    penetration: "1",
                    special: "Balanced",
                },
            },
        ]);
    });

    it("reads no weapon from a bracket that is no profile, or from a name inside a sentence", () => {
        expect(inlineWeapons("Awareness (Per), Dodge (Ag)")).toEqual([]);
        expect(inlineWeapons("He carries a wick gun (Basic; 1d10 I) at all times")).toEqual([]);
        expect(inlineWeapons("Wick gun (Basic; 60m; Pen 2)")).toEqual([]);
    });
});
