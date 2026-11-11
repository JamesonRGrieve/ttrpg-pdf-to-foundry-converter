// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { blockFields } from "../../src/infer/npc.ts";
import { afterLeadIn, closeUpSpacedLetters, panelWeapons } from "../../src/infer/panel-weapons.ts";

describe("closeUpSpacedLetters", () => {
    it("closes up a word set in spaced capitals, keeping real word breaks", () => {
        expect(closeUpSpacedLetters("gL o W gu n")).toBe("gLoW gun");
        expect(closeUpSpacedLetters("Wi c k- L A M p")).toBe("Wick-LAMp");
        expect(closeUpSpacedLetters("Glow Rod")).toBe("Glow Rod");
    });

    it("opens a word at a capital after a capitalised word when small letters follow it", () => {
        expect(closeUpSpacedLetters("L a m p W i c k")).toBe("Lamp Wick");
        expect(closeUpSpacedLetters("Heavy W i c k")).toBe("Heavy Wick");
        // Scrambled case: a capital before one small letter, or after mixed case, stays in the word.
        expect(closeUpSpacedLetters("L a m p I l A s e r")).toBe("LampIlAser");
        // Unspaced pieces in scrambled case ("Gl") mark the whole name's case as lost.
        expect(closeUpSpacedLetters("Gl O w C a n n o n")).toBe("GlOwCannon");
        // A hyphen spaced apart joins the word on either side.
        expect(closeUpSpacedLetters("T w i n G l o w - L a m p")).toBe("Twin Glow-Lamp");
    });
});

describe("afterLeadIn", () => {
    it("drops a sentence of prose leading into a name line, not a short abbreviation", () => {
        expect(afterLeadIn("The craft may take one hull mount. Lamp Gun")).toBe("Lamp Gun");
        expect(afterLeadIn("One pintle-mounted gun with a forward arc: Wick Gun")).toBe("Wick Gun");
        expect(afterLeadIn("Mk. II Lamp Gun")).toBe("Mk. II Lamp Gun");
        expect(afterLeadIn("Lamp Gun")).toBe("Lamp Gun");
    });

    it("reads the name after the lead-in on a name line", () => {
        const [weapon] = panelWeapons([
            "The craft may take a pintle mount. L a m p G u n CLASS BASIC",
            "RNG 90M ROF S/2/- DMG 1D10+3 (E)",
        ]);
        expect(weapon?.name).toBe("Lamp Gun");
    });
});

describe("panelWeapons", () => {
    it("reads boxed weapon profiles: a name line ending in its class, then labelled values", () => {
        const weapons = panelWeapons([
            "HALF 3 FULL 6 CHARGE 9 RUN 18 THREAT 7",
            "gL o W gu n CLASS BASIC",
            "RNG 90M ROF S/2/- DMG 1D10+3 (E)",
            "PEN 1 CLIP 20 RLD FULL WT 4 KG AVL CM",
            "SPECIAL: RELIABLE",
            "W i c k Bom b S ( 3) Class Thrown",
            "rng SBx3 rof S/-/- Dmg 2d10 (x)",
            "1",
            "Pen 0 Clip 1 WT .5 KG avl ra",
            "Skills: Awareness (Per)",
        ]);
        expect(weapons).toEqual([
            {
                name: "gLoW gun",
                count: null,
                cells: {
                    class: "BASIC",
                    range: "90M",
                    rof: "S/2/-",
                    damage: "1D10+3 (E)",
                    penetration: "1",
                    clip: "20",
                    reload: "FULL",
                    weight: "4",
                    availability: "CM",
                    special: "RELIABLE",
                },
            },
            {
                name: "Wick BombS",
                count: 3,
                cells: {
                    class: "Thrown",
                    range: "SBx3",
                    rof: "S/-/-",
                    damage: "2d10 (x)",
                    penetration: "0",
                    clip: "1",
                    weight: ".5",
                    availability: "ra",
                },
            },
        ]);
    });

    it("finds no weapon in a panel without a class line", () => {
        expect(panelWeapons(["Skills: Awareness", "Talents: Keen Eye"])).toEqual([]);
    });
});

describe("blockFields", () => {
    it("takes a field from the block under its own label, not running on into a named rule", () => {
        expect(
            blockFields([
                { label: "Gear", text: "Glow rod, wick", pageIndex: 0 },
                { label: "Dim Ward", text: "As a Half Action, dims the lamps.", pageIndex: 0 },
                { label: "Armour (Hide)", text: "3 All", pageIndex: 0 },
            ]),
        ).toEqual({ gear: "Glow rod, wick", armour: "3 All" });
    });

    it("ends a field at another field's label the panel did not set apart", () => {
        expect(
            blockFields([
                {
                    label: "Skills",
                    text: "Hush (Ag) +20, Wading (S) Talents: Keen Eye, Steady Hand",
                    pageIndex: 0,
                },
                { label: "Traits", text: "Dim Sight", pageIndex: 0 },
            ]),
        ).toEqual({
            skills: "Hush (Ag) +20, Wading (S)",
            talents: "Keen Eye, Steady Hand",
            traits: "Dim Sight",
        });
    });
});
