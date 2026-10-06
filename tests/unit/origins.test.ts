// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/infer/detect-entries.ts";
import {
    characteristicChanges,
    characteristicModifiers,
    equipmentItem,
    originCellName,
    originStepNamedBy,
    readFieldedOrigins,
    readInlineOrigins,
    readOriginPaths,
    readOriginTable,
    signedCharacteristicChanges,
    splitTopLevel,
} from "../../src/infer/origin-paths.ts";
import { DEFAULT_TARGET, TARGETS } from "../../src/infer/targets.ts";

const STEPS = DEFAULT_TARGET.originSteps;
/** No page carries running text. */
const NO_HEADS: ReadonlyMap<number, readonly string[]> = new Map();

const entry = (text: string, pageIndex: number, sections: string[], body = ""): Entry => ({
    heading: { text, size: 10, style: "h", pageIndex },
    sections,
    fields: [],
    body,
});

describe("origin list parsing", () => {
    it("splits a list on commas outside parentheses", () => {
        expect(splitTopLevel("Lantern Lore (Reeds, Tides), Hush or Glow, Wading", /^,\s*/u)).toEqual([
            "Lantern Lore (Reeds, Tides)",
            "Hush or Glow",
            "Wading",
        ]);
    });

    it("reads equipment quantities", () => {
        expect(equipmentItem("3 flasks of lamp oil")).toEqual({ name: "Lamp Oil", quantity: 3 });
        expect(equipmentItem("12 reed candles")).toEqual({ name: "Reed Candles", quantity: 12 });
        expect(equipmentItem("wading staff")).toEqual({ name: "Wading Staff", quantity: 1 });
    });

    it("reads characteristic modifiers and changes", () => {
        expect(characteristicModifiers("+ Agility, + Perception, – Willpower")).toEqual({
            agility: 5,
            perception: 5,
            willpower: -5,
        });
        expect(
            characteristicChanges(
                "Increase this character's Fellowship by 5. Reduce his Toughness characteristic by 3.",
            ),
        ).toEqual({
            fellowship: 5,
            toughness: -3,
        });
        expect(characteristicChanges("Increase his Agility or Intelligence by 3.")).toEqual({});
        expect(
            signedCharacteristicChanges("+5 Fellowship, –5 Toughness, +2 Wounds, -3 Ballistic Skill."),
        ).toEqual({
            fellowship: 5,
            toughness: -5,
            ballisticSkill: -3,
        });
        // An abbreviation after a number is no characteristic name ("+2 S" is not read).
        expect(signedCharacteristicChanges("+2 S, +10 to the test")).toEqual({});
    });

    it("recognises a caption naming a creation step", () => {
        expect(originStepNamedBy("Random Home World", STEPS)?.key).toBe("homeWorld");
        expect(originStepNamedBy("Omens", STEPS)).toBeNull();
        // The step must be the caption's head noun, not a modifier of another.
        expect(originStepNamedBy("Home World Hazards", STEPS)).toBeNull();
    });

    it("writes each line's own actor types", () => {
        expect(TARGETS.rt.actorTypes).toEqual({
            npc: "rt-npc",
            terracraft: "rt-terracraft",
            aircraft: "rt-aircraft",
            voidcraft: "rt-voidcraft",
        });
        expect(TARGETS.dh1.actorTypes.aircraft).toBe("aircraft");
        expect(TARGETS.dh1.actorTypes.voidcraft).toBe("voidcraft");
        expect(DEFAULT_TARGET.actorTypes.npc).toBe("dh2-npc");
    });

    it("recognises only the chosen target's creation steps", () => {
        const voidSteps = TARGETS.rt.originSteps;
        expect(originStepNamedBy("Random Lure of the Void", voidSteps)?.key).toBe("lureOfTheVoid");
        expect(originStepNamedBy("Random Lure of the Void", STEPS)).toBeNull();
        expect(originStepNamedBy("Trials and Travails", voidSteps)?.index).toBe(4);
        expect(originStepNamedBy("Divinations", voidSteps)).toBeNull();
    });
});

describe("origin rules blocks", () => {
    it("reads a rules block's grants and names it by the heading it extends", () => {
        const entries = [
            entry("REED WORLD", 10, ["CHOOSE HOME WORLD"], "The damp and patient folk of the reeds."),
            entry("REED WORLD RULES", 10, ["CHOOSE HOME WORLD"]),
            entry(
                "CHARACTERISTIC MODIFIERS",
                10,
                ["CHOOSE HOME WORLD", "REED WORLD RULES"],
                "+ Agility, – Strength",
            ),
            entry(
                "FATE THRESHOLD",
                10,
                ["CHOOSE HOME WORLD", "REED WORLD RULES"],
                "3 (Patron’s Blessing 7+)",
            ),
            entry(
                "HOME WORLD BONUS",
                10,
                ["CHOOSE HOME WORLD", "REED WORLD RULES"],
                "Wader: Ignores marsh terrain.\n\nNarrative.",
            ),
            entry("HOME WORLD APTITUDE", 10, ["CHOOSE HOME WORLD", "REED WORLD RULES"], "Agility"),
            entry(
                "WOUNDS",
                10,
                ["CHOOSE HOME WORLD", "REED WORLD RULES"],
                "A reed worlder starts with 7+1d5 wounds.",
            ),
        ];
        const [origin] = readOriginPaths(entries, STEPS, NO_HEADS);
        expect(origin?.name).toBe("REED WORLD");
        expect(origin?.step.key).toBe("homeWorld");
        expect(origin?.modifiers).toEqual({ agility: 5, strength: -5 });
        expect(origin?.grants).toMatchObject({
            woundsFormula: "7+1d5",
            fateThreshold: 3,
            aptitudes: ["Agility"],
            specialAbilities: [{ name: "Wader", description: "Ignores marsh terrain." }],
        });
    });

    it("turns 'or' into choices and parenthesised specialisations into grants", () => {
        const s = ["CHOOSE BACKGROUND", "LAMPLIGHTERS RULES"];
        const entries = [
            entry("LAMPLIGHTERS RULES", 20, ["CHOOSE BACKGROUND"]),
            entry("STARTING SKILLS", 20, s, "Lantern Lore (Reeds, Tides), Hush or Glow"),
            entry("STARTING TALENTS", 20, s, "Wick Training (Oil or Tallow)"),
            entry("BACKGROUND APTITUDE", 20, s, "Finesse or Offence"),
        ];
        const [origin] = readOriginPaths(entries, STEPS, NO_HEADS);
        expect(origin?.step.key).toBe("background");
        expect(origin?.grants["skills"]).toEqual([
            { name: "Lantern Lore", specialization: "Reeds", level: "known" },
            { name: "Lantern Lore", specialization: "Tides", level: "known" },
        ]);
        const choices = origin?.grants["choices"] as { type: string; options: unknown[] }[];
        expect(choices.map((c) => c.type)).toEqual(["skill", "talent", "aptitude"]);
    });

    it("names a rules block by a 'Kind: Name' heading it extends", () => {
        const s = ["NEW PATHS", "LAMPLIGHTER RULES"];
        const entries = [
            entry("NEW ROLE: LAMPLIGHTER", 40, ["NEW PATHS"], "Keepers of the wick."),
            entry("LAMPLIGHTER RULES", 40, ["NEW PATHS"]),
            entry("ROLE APTITUDES", 40, s, "Finesse, Perception"),
            entry("ROLE TALENT", 40, s, "Wick Training"),
        ];
        const [origin] = readOriginPaths(entries, STEPS, NO_HEADS);
        expect(origin?.name).toBe("LAMPLIGHTER");
        expect(origin?.description).toBe("Keepers of the wick.");
    });

    it("takes a block bought with experience as an elite advance when nothing names its step", () => {
        const s = ["NEW PATHS", "WARDEN SPECIAL RULES"];
        const entries = [
            entry("WARDEN", 50, ["NEW PATHS"], "Keepers of the gate."),
            entry("WARDEN SPECIAL RULES", 50, ["NEW PATHS"]),
            entry("EXPERIENCE COST", 50, s, "300 xp"),
            entry("PREREQUISITES", 50, s, "Willpower 35"),
            entry("EQUIPMENT", 50, s, "Lantern"),
        ];
        const [origin] = readOriginPaths(entries, STEPS, NO_HEADS);
        expect(origin?.name).toBe("WARDEN");
        expect(origin?.step.key).toBe("elite");
        // Its price and requirement are its content even when it grants nothing listed.
        const [priced] = readOriginPaths(entries.slice(0, -1), STEPS, NO_HEADS);
        expect([priced?.name, priced?.xpCost, priced?.requirements]).toEqual(["WARDEN", 300, "Willpower 35"]);
    });

    it("takes the step from the page's running head, and offers listed special abilities", () => {
        const steps = TARGETS.dw.originSteps;
        const s = ["LANTERN KEEPERS", "WICK WARDEN"];
        const entries = [
            entry("WICK WARDEN", 70, ["LANTERN KEEPERS"], "Wardens tend the wicks."),
            entry(
                "STARTING SKILLS",
                71,
                s,
                "The Warden begins with Lantern Lore (Reeds) and Wick-Use as Trained Advanced Skills.",
            ),
            // Set in the other column, before its sibling label.
            entry("STEADY FLAME", 71, [...s, "STARTING SKILLS"], "The flame never gutters."),
            entry("SPECIAL ABILITY", 71, s, "Choose one of the following:"),
            entry("BRIGHT WICK", 71, [...s, "SPECIAL ABILITY"], "Light carries twice as far."),
        ];
        expect(readOriginPaths(entries, steps, NO_HEADS)).toEqual([]);
        const [origin] = readOriginPaths(entries, steps, new Map([[70, ["II: Specialities"]]]));
        expect(origin?.name).toBe("WICK WARDEN");
        expect(origin?.step.key).toBe("speciality");
        expect(origin?.grants["skills"]).toEqual([
            { name: "Lantern Lore", specialization: "Reeds", level: "trained" },
            { name: "Wick-Use", specialization: "", level: "trained" },
        ]);
        expect(origin?.grants["choices"]).toEqual([
            {
                type: "specialAbility",
                label: "Special Ability",
                count: 1,
                options: [{ name: "Bright Wick", description: "Light carries twice as far." }],
            },
        ]);
    });

    it("ignores a section that only describes a step in prose", () => {
        const s = ["ELITE ADV ANCES", "GENERAL RULES"];
        const entries = [
            entry("GENERAL RULES", 30, ["ELITE ADV ANCES"]),
            entry("INSTANT CHANGES", 30, s, "Explains what changes."),
            entry("UNLOCKED ADVANCES", 30, s, "Explains what unlocks."),
        ];
        expect(readOriginPaths(entries, STEPS, NO_HEADS)).toEqual([]);
    });
});

describe("origin tables", () => {
    it("reads one origin per row, skipping the roll band", () => {
        const rows = [
            ["01-05", "The reeds remember.", "Increase this character's Perception by 5."],
            ["06-10", "Silence is a lantern.", "This character gains the Hush talent."],
        ];
        const divination = STEPS.find((s) => s.key === "divination");
        if (divination === undefined) {
            throw new Error("the default target has a divination step");
        }
        const origins = readOriginTable(divination, rows, 7);
        expect(origins.map((o) => [o.name, o.modifiers])).toEqual([
            ["The reeds remember.", { perception: 5 }],
            ["Silence is a lantern.", {}],
        ]);
        expect(origins.every((o) => o.fromTable === true && o.pageIndex === 7)).toBe(true);
    });

    it("reads signed characteristic changes in a row's effect", () => {
        const pride = TARGETS.bc.originSteps.find((s) => s.key === "pride");
        if (pride === undefined) {
            throw new Error("the target has a pride step");
        }
        const [origin] = readOriginTable(
            pride,
            [
                [
                    "3",
                    "Lanterncraft",
                    "Fine work. Characteristic modifier: +1 Renown, +3 Agility, –3 Weapon Skill.",
                ],
            ],
            70,
        );
        expect(origin?.modifiers).toEqual({ agility: 3, weaponSkill: -3 });
    });

    it("names an origin by the quotation or the lead before a colon that opens its cell", () => {
        expect(originCellName("“The reeds remember.” Increase Perception by 5.")).toEqual({
            name: "“The reeds remember.”",
            rest: "Increase Perception by 5.",
        });
        expect(originCellName("Marsh World: Marsh folk are patient and hard to startle.")).toEqual({
            name: "Marsh World",
            rest: "Marsh folk are patient and hard to startle.",
        });
        expect(originCellName("Silence is a lantern.")).toEqual({ name: "Silence is a lantern.", rest: "" });
        expect(originCellName("and so it goes.")).toBeNull();
    });
});

describe("origins with inline fields", () => {
    const dh1 = TARGETS.dh1.originSteps;
    const fielded = (heading: string, fields: [string, string][], sections: string[]): Entry => ({
        heading: { text: heading, size: 10, style: "h", pageIndex: 36 },
        sections,
        fields,
        body: "Lamplighters of the reed worlds.",
    });

    it("reads a priced package requiring earlier steps as the step its section names", () => {
        const [origin] = readFieldedOrigins(
            [
                fielded(
                    "WICK GUILD RUNNER",
                    [
                        ["Home World", "Reed Born."],
                        ["Career", "Lamplighter"],
                        ["Cost", "100 xp"],
                        ["Skills", "Lantern Lore (Reeds)"],
                        ["Talents", "Wick Training (Oil)"],
                    ],
                    ["IV: Lamps", "Background Packages"],
                ),
            ],
            dh1,
        );
        expect(origin?.name).toBe("WICK GUILD RUNNER");
        expect(origin?.step.key).toBe("background");
        expect(origin?.xpCost).toBe(100);
        expect(origin?.requirements).toBe("Home World: Reed Born. Career: Lamplighter");
        expect(origin?.grants["skills"]).toEqual([
            { name: "Lantern Lore", specialization: "Reeds", level: "known" },
        ]);
    });

    it("takes grants from the sub-headings under a priced package", () => {
        const sections = ["IV: Lamps", "Background Packages"];
        const [origin] = readFieldedOrigins(
            [
                fielded("THE EMBER VAULTS", [["Package Cost", "200 xp"]], sections),
                {
                    // "Effects" set larger than the package headings: not nested, still its grants.
                    ...fielded("Effects", [["Talents", "You gain Wick Training (Oil)"]], sections),
                    heading: { text: "Effects", size: 12, style: "effects", pageIndex: 36 },
                    body: "Apply all of the following changes to your character.",
                },
                fielded("THE NEXT PACKAGE", [["Package Cost", "100 xp"]], sections),
            ],
            dh1,
        );
        expect(origin?.xpCost).toBe(200);
        expect(origin?.requirements).toBeUndefined();
        expect((origin?.grants["talents"] as unknown[]).length).toBeGreaterThan(0);
    });

    it("reads no origin from a priced heading that grants nothing (a price list)", () => {
        const sections = ["IV: Lamps", "Background Packages"];
        const priceList = [fielded("WICK ADVANCES", [["Cost", "100 xp"]], sections)];
        expect(readFieldedOrigins(priceList, dh1)).toEqual([]);
    });

    it("reads nothing from an entry without a price or a section naming its step", () => {
        const fields: [string, string][] = [
            ["Home World", "Reed Born."],
            ["Cost", "100 xp"],
        ];
        expect(
            readFieldedOrigins(
                [fielded("LAMP", [["Home World", "Reed Born."]], ["Background Packages"])],
                dh1,
            ),
        ).toEqual([]);
        expect(readFieldedOrigins([fielded("LAMP", fields, ["IV: Lamps"])], dh1)).toEqual([]);
    });
});

describe("origins granted by inline fields", () => {
    const bc = TARGETS.bc.originSteps;
    const at = (
        text: string,
        style: string,
        sections: string[],
        fields: [string, string][] = [],
        body = "",
    ): Entry => ({ heading: { text, size: 10, style, pageIndex: 48 }, sections, fields, body });

    it("names an origin by its heading's words before its field labels, under a section naming the step", () => {
        const origins = readInlineOrigins(
            [
                at("STAGE 1: CHOOSE A RACE", "chapter", ["Lamps"], [], "Pick one."),
                at("LAMPWRIGHTS", "section", ["Lamps", "Stage 1: Choose a Race"], [], "Makers of lamps."),
                at(
                    "LAMPWRIGHT STARTING ABILITIES",
                    "sub",
                    ["Stage 1: Choose a Race", "LAMPWRIGHTS"],
                    [
                        ["Starting Skills", "Glow Lore (Wicks), Hush, Wading."],
                        ["Starting Traits", "Dim Sight, Lantern Bearer (+2)."],
                    ],
                ),
            ],
            bc,
        );
        expect(origins.map((o) => [o.name, o.step.key, o.description])).toEqual([
            ["Lampwright", "race", "Makers of lamps."],
        ]);
        expect(origins[0]?.grants["skills"]).toEqual([
            { name: "Glow Lore", specialization: "Wicks", level: "known" },
            { name: "Hush", specialization: "", level: "known" },
            { name: "Wading", specialization: "", level: "known" },
        ]);
        expect(origins[0]?.grants["traits"]).toEqual([
            { name: "Dim Sight" },
            { name: "Lantern Bearer (+2)" },
        ]);
    });

    it("names an origin by its section when the heading is all labels, its step by a sibling heading", () => {
        const origins = readInlineOrigins(
            [
                at("STAGE 3: SELECT AN ARCHETYPE", "display", ["Lamps"], [], "Pick one."),
                at(
                    "W ickkeeper",
                    "display",
                    ["Lamps"],
                    [],
                    "Keepers of the wick. A Wickkeeper never sleeps.",
                ),
                at(
                    "SKILLS, TALENTS & GEAR",
                    "sub",
                    ["Lamps", "W ickkeeper"],
                    [
                        ["Characteristic Bonus", "Wickkeepers gain +5 Perception."],
                        ["Starting Talents", "Steady Hand or Keen Eye"],
                        ["Starting Gear", "Lantern, wick shears"],
                        ["Wounds", "12+1d5"],
                    ],
                ),
            ],
            bc,
        );
        expect(origins.map((o) => [o.name, o.step.key, o.modifiers])).toEqual([
            ["Wickkeeper", "archetype", { perception: 5 }],
        ]);
        expect(origins[0]?.grants["woundsFormula"]).toBe("12+1d5");
        expect(origins[0]?.grants["equipment"]).toEqual([
            { name: "Lantern", quantity: 1 },
            { name: "Wick Shears", quantity: 1 },
        ]);
    });

    it("reads nothing from a single grant, a priced block, or a section naming no step", () => {
        const sections = ["Lamps", "Stage 1: Choose a Race"];
        const single = at("GLOW", "sub", sections, [["Starting Skills", "Hush"]]);
        const priced = at("GLOW", "sub", sections, [
            ["Cost", "100 xp"],
            ["Starting Skills", "Hush"],
            ["Starting Talents", "Keen Eye"],
        ]);
        const elsewhere = at(
            "GLOW",
            "sub",
            ["Lamps", "Lantern Upkeep"],
            [
                ["Starting Skills", "Hush"],
                ["Starting Talents", "Keen Eye"],
            ],
        );
        expect(readInlineOrigins([single, priced, elsewhere], bc)).toEqual([]);
    });
});
