// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/infer/detect-entries.ts";
import {
    characteristicChanges,
    characteristicModifiers,
    citedOriginPages,
    equipmentItem,
    originCellName,
    namesOriginStep,
    originStepNamedBy,
    pairsSteps,
    readCitedOrigins,
    readHeadedOrigins,
    readEffectOrigins,
    readFieldedOrigins,
    readInlineOrigins,
    withoutStepLabel,
    readOriginAbilities,
    readOriginPaths,
    readOriginTable,
    resourceChanges,
    sameOrigin,
    signedCharacteristicChanges,
    splitTopLevel,
    withCitedOrigins,
    withSkillLevelBase,
    traitGrant,
} from "../../src/infer/origin-paths.ts";
import { buildOriginPath } from "../../src/infer/schema.ts";
import { baseSkillLevel, DEFAULT_TARGET, TARGETS } from "../../src/infer/targets.ts";

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
        // A signed amount, and one amount shared by several characteristics.
        expect(characteristicChanges("Increase Agility by +2 and gain 1 Fate Point.")).toEqual({
            agility: 2,
        });
        expect(characteristicChanges("Increase Weapon Skill and Ballistic Skill each by +2.")).toEqual({
            weaponSkill: 2,
            ballisticSkill: 2,
        });
        expect(characteristicChanges("Increase Agility and the lamp's glow by 2.")).toEqual({});
        // Changes to the character's resources.
        expect(resourceChanges("Begin play with 1 Insanity Point and 1 Corruption Point.")).toEqual({
            insanity: 1,
            corruption: 1,
        });
        expect(resourceChanges("Increase Toughness by +2 and gain 1 Wound. Gain 2 Fate Points.")).toEqual({
            wounds: 1,
            fate: 2,
        });
        expect(resourceChanges("+5 Strength, +2 Wounds, and a lamp.")).toEqual({ wounds: 2 });
        // A sign after a die is a rolled amount.
        expect(resourceChanges("You suffer 1d5+1 Corruption Points.")).toEqual({});
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
        // A table pairing the caption's step with another lists neither's origins.
        const rt = TARGETS.rt.originSteps;
        const homeWorld = originStepNamedBy("Suggested Home Worlds", rt);
        expect(pairsSteps(homeWorld, ["Career", "Home Worlds"], rt)).toBe(true);
        expect(pairsSteps(homeWorld, ["Home World", "Effect"], rt)).toBe(false);
        expect(pairsSteps(homeWorld, ["Roll", "Result"], rt)).toBe(false);
        // A name column headed by a step lists that step's origins, not items.
        expect(namesOriginStep("Home World or Origin", TARGETS.ow.originSteps)).toBe(true);
        expect(namesOriginStep("Chapter", TARGETS.dw.originSteps)).toBe(true);
        // A numbered label is a division of the book.
        expect(namesOriginStep("CHAPTER IV: LAMPS & WICKS", TARGETS.dw.originSteps)).toBe(false);
        expect(namesOriginStep("Chapter 3: Glow", TARGETS.dw.originSteps)).toBe(false);
        expect(namesOriginStep("Name", TARGETS.ow.originSteps)).toBe(false);
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
        // A single skill the origin "gains" at a rank is granted at that rank.
        const gains = entries.map((e) =>
            e.heading.text === "STARTING SKILLS"
                ? { ...e, body: "The Warden gains Lantern Lore (Reeds) as a Trained Advanced Skill." }
                : e,
        );
        const [gained] = readOriginPaths(gains, steps, new Map([[70, ["II: Specialities"]]]));
        expect(gained?.grants["skills"]).toEqual([
            { name: "Lantern Lore", specialization: "Reeds", level: "trained" },
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

    it("names an origin by its section, less the step's own words, when the heading's words before its labels only connect", () => {
        const rt = TARGETS.rt.originSteps;
        const origins = readInlineOrigins(
            [
                at("LAMPWRIGHT CAREER PATH", "display", ["Careers"], [], "Keepers of the lamps."),
                // The heading "Starting Skills, Talents, and Gear" read as two: its second line keeps the fields.
                at("STARTING SKILLS, TALENTS,", "sub", ["Careers", "LAMPWRIGHT CAREER PATH"]),
                at(
                    "AND GEAR",
                    "sub2",
                    ["Careers", "LAMPWRIGHT CAREER PATH"],
                    [
                        ["Starting Skills", "Wading, Hush."],
                        ["Starting Talents", "Steady Hand."],
                        ["Starting Gear", "A lamp."],
                    ],
                ),
            ],
            rt,
        );
        expect(origins.map((o) => [o.name, o.step.key])).toEqual([["Lampwright", "career"]]);
        expect(withoutStepLabel("Lampwright Career Path", ["career"])).toBe("Lampwright");
        expect(withoutStepLabel("Career Path", ["career"])).toBe("Career Path");
        // A display heading's letters split by the text layer.
        expect(withoutStepLabel("Lampwright C areer P ath", ["career"])).toBe("Lampwright");
        expect(withoutStepLabel("Lore of the Lamp", ["lure of the void"])).toBe("Lore of the Lamp");
    });

    it("names an origin by the earlier heading it extends, its step by a section naming it anywhere", () => {
        const rt = TARGETS.rt.originSteps;
        const sections = ["Creation", "Home World Options"];
        const origins = readInlineOrigins(
            [
                at("Home World Options", "display", ["Creation"], [], "Pick one."),
                at("reed World", "name", sections, [], "Born among the reeds."),
                at("Reed World Characters", "sub", sections, [
                    ["Starting Skills", "Wading, Hush."],
                    ["Starting Wounds", "Twice the Toughness bonus."],
                ]),
            ],
            rt,
        );
        expect(origins.map((o) => [o.name, o.step.key, o.description])).toEqual([
            ["Reed World", "homeWorld", "Born among the reeds."],
        ]);
    });

    it("reads an inline origin's fields naming no grant as rules of its own", () => {
        const rt = TARGETS.rt.originSteps;
        const sections = ["Creation", "Home World Options"];
        const origins = readInlineOrigins(
            [
                at("reed World", "name", sections, [], "Born among the reeds."),
                at("Reed World Characters", "sub", sections, [
                    ["Starting Skills", "Wading, Hush."],
                    ["Mud Footed", "Bogs are not Difficult Terrain for you."],
                    ["1-2", "A roll band, not a rule."],
                    ["Starting Wounds", "Twice the Toughness bonus."],
                    ["StartingAptitudes", "Wading"],
                ]),
            ],
            rt,
        );
        expect(origins[0]?.rules).toEqual([
            { name: "Mud Footed", description: "Bogs are not Difficult Terrain for you." },
        ]);
        // A label whose words a text layer joined still reads as its grant.
        expect(origins[0]?.grants["aptitudes"]).toEqual(["Wading"]);
    });

    it("reads an origin's abilities printed apart under a heading naming whose they are", () => {
        const rt = TARGETS.rt.originSteps;
        const abilities = readOriginAbilities(
            [
                at(
                    "LAMPLIGHTER SPECIAL ABILITY",
                    "sub",
                    ["Career Paths", "Special Abilities"],
                    [["Steady Flame", "Once per round, relight a lamp."]],
                ),
                at("SPECIAL ABILITIES", "sub", ["Career Paths"], [["Unnamed", "No origin named."]]),
                at("Wick Special Ability", "sub", ["Lamps"], [["Trim", "Not under a step."]]),
            ],
            rt,
        );
        expect(abilities.map((a) => [a.origin, a.step.key, a.rules])).toEqual([
            [
                "Lamplighter",
                "career",
                [{ name: "Steady Flame", description: "Once per round, relight a lamp." }],
            ],
        ]);
        expect(sameOrigin("Arch-militant", "ARCH-MILITANT")).toBe(true);
    });

    it("reads origins printed as headings with effect fields under a section naming a step", () => {
        const rt = TARGETS.rt.originSteps;
        const sections = ["Creation", "BIRTHRIGHT"];
        const origins = readEffectOrigins(
            [
                at("BIRTHRIGHT", "display", ["Creation"], [], "Where you were raised."),
                at(
                    "lamp-born",
                    "name",
                    sections,
                    [["Effect", "You gain +5 Perception but -5 Agility."]],
                    "Raised by lamps.",
                ),
                at("WICKED", "name", sections, [
                    ["Bright Eyes", "You gain the Keen Eye talent."],
                    ["Dim Wits", "Reduce your Intelligence by 3."],
                ]),
                at("Prose Only", "name", sections, [], "No rules."),
            ],
            rt,
        );
        expect(origins.map((o) => [o.name, o.step.key, o.modifiers])).toEqual([
            ["Lamp-born", "birthright", { perception: 5, agility: -5 }],
            ["WICKED", "birthright", { intelligence: -3 }],
        ]);
        expect(origins[1]?.effect).toBe(
            "Bright Eyes: You gain the Keen Eye talent.\n\nDim Wits: Reduce your Intelligence by 3.",
        );
    });

    it("reads an effect's bulleted options, set among the prose, as rules offered as a choice", () => {
        const rt = TARGETS.rt.originSteps;
        const sections = ["Creation", "BIRTHRIGHT"];
        const [origin] = readEffectOrigins(
            [
                at(
                    "Wick-born",
                    "name",
                    sections,
                    [["Effect", "Choose one of the following results."]],
                    "Raised by wicks.\n\n• Smoky: You gain +3 Perception. • Waxen Hands: You suffer -3 Agility.",
                ),
            ],
            rt,
        );
        expect(origin?.description).toBe("Raised by wicks.");
        expect(origin?.rules).toEqual([
            { name: "Smoky", description: "You gain +3 Perception.", choice: "Effect" },
            { name: "Waxen Hands", description: "You suffer -3 Agility.", choice: "Effect" },
        ]);
        expect(origin?.effect).toContain("• Waxen Hands: You suffer -3 Agility.");
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

    it("keeps a signed wound or Fate change out of the formula, as a resource modifier", () => {
        const origins = readInlineOrigins(
            [
                at("STAGE 4: SELECT A PRIDE", "display", ["Lamps"], [], "Pick one."),
                at("Ember Heart", "display", ["Lamps"], [], "The flame never dies."),
                at(
                    "SKILLS, TALENTS & GEAR",
                    "sub",
                    ["Lamps", "Ember Heart"],
                    [
                        ["Characteristic Bonus", "Gain +5 Toughness."],
                        ["Starting Talents", "Steady Hand"],
                        ["Wounds", "+2"],
                        ["Fate", "−1"],
                    ],
                ),
            ],
            bc,
        );
        expect(origins.map((o) => [o.name, o.step.key, o.resources])).toEqual([
            ["Ember Heart", "pride", { wounds: 2, fate: -1 }],
        ]);
        expect(origins[0]?.grants["woundsFormula"]).toBe("");
        expect(origins[0]?.grants["fateThreshold"]).toBe(0);
        const body = buildOriginPath({
            name: "Ember Heart",
            step: { key: "pride", index: 3 },
            line: "bc",
            book: "lamps",
            page: "1",
            description: "",
            grants: origins[0]?.grants ?? {},
            characteristics: origins[0]?.modifiers ?? {},
            ...(origins[0]?.resources === undefined ? {} : { resources: origins[0].resources }),
        });
        const system = body["system"] as { modifiers: unknown; grants: Record<string, unknown> };
        expect(system.modifiers).toEqual({
            characteristics: { toughness: 5 },
            resources: { wounds: 2, fate: -1 },
        });
        // The system declares no grants.wounds (#688): the bonus has one home.
        expect(system.grants).not.toHaveProperty("wounds");
    });

    it("flags an origin granting a Psy Rating as making a psyker, never one asking for it (#681)", () => {
        const read = (fields: [string, string][]): ReturnType<typeof readInlineOrigins> =>
            readInlineOrigins(
                [
                    at("STAGE 2: SELECT AN ARCHETYPE", "display", ["Lamps"], [], "Pick one."),
                    at("Flamewright", "display", ["Lamps"], [], "Fire answers the call."),
                    at("SKILLS, TALENTS & GEAR", "sub", ["Lamps", "Flamewright"], fields),
                ],
                bc,
            );
        const granted = read([
            ["Starting Talents", "Steady Hand"],
            ["Starting Traits", "Psy Rating 2"],
            ["Starting Gear", "Lantern"],
        ]);
        expect(granted[0]?.grantsPsychicPowers).toBe(true);
        const body = buildOriginPath({
            name: "Flamewright",
            step: { key: "archetype", index: 2 },
            line: "bc",
            book: "BC: Lamps",
            page: "1",
            description: "",
            grants: granted[0]?.grants ?? {},
            characteristics: {},
            grantsPsychicPowers: true,
        });
        expect((body["system"] as Record<string, unknown>)["grantsPsychicPowers"]).toBe(true);
        const asked = read([
            ["Prerequisites", "Psy Rating 3"],
            ["Starting Talents", "Steady Hand"],
            ["Starting Gear", "Lantern"],
        ]);
        expect(asked.map((o) => o.name)).toEqual(["Flamewright"]);
        expect(asked[0]?.grantsPsychicPowers).toBeUndefined();
        // A psy rating others have, named in a rule, grants none.
        const mentioned = read([
            ["Starting Talents", "Steady Hand"],
            ["Benefits", "• Gains the Hush talent. • Anyone who has a psy rating finds the character cold."],
            ["Starting Gear", "Lantern"],
        ]);
        expect(mentioned[0]?.grantsPsychicPowers).toBeUndefined();
        const stated = read([
            ["Starting Talents", "Steady Hand"],
            ["Benefits", "• Gains the Hush trait and a psy rating of 1."],
            ["Starting Gear", "Lantern"],
        ]);
        expect(stated[0]?.grantsPsychicPowers).toBe(true);
    });

    it("flags an origin granting the psyker trait as making a psyker", () => {
        const origins = readInlineOrigins(
            [
                at("STAGE 2: SELECT AN ARCHETYPE", "display", ["Lamps"], [], "Pick one."),
                at("Flamewright", "display", ["Lamps"], [], "Fire answers the call."),
                at(
                    "SKILLS, TALENTS & GEAR",
                    "sub",
                    ["Lamps", "Flamewright"],
                    [
                        ["Starting Talents", "Steady Hand"],
                        ["Starting Traits", "Psyker"],
                        ["Starting Gear", "Lantern"],
                    ],
                ),
            ],
            bc,
        );
        expect(origins[0]?.grantsPsychicPowers).toBe(true);
    });

    it("grants a skill at the first level of the line's skill ladder", () => {
        expect(baseSkillLevel("dh2")).toBe("known");
        expect(baseSkillLevel("rt")).toBe("trained");
        const grants = {
            skills: [
                { name: "Lamp Lore", specialization: "", level: "known" },
                { name: "Glowcraft", specialization: "", level: "experienced" },
            ],
        };
        expect(withSkillLevelBase(grants, "trained")["skills"]).toEqual([
            { name: "Lamp Lore", specialization: "", level: "trained" },
            { name: "Glowcraft", specialization: "", level: "experienced" },
        ]);
        expect(withSkillLevelBase(grants, "known")).toEqual(grants);
    });

    it("reads a skill without the characteristic tag printed after it", () => {
        const origins = readInlineOrigins(
            [
                at("STAGE 2: SELECT AN ARCHETYPE", "display", ["Lamps"], [], "Pick one."),
                at("Flamewright", "display", ["Lamps"], [], "Fire answers the call."),
                at(
                    "SKILLS, TALENTS & GEAR",
                    "sub",
                    ["Lamps", "Flamewright"],
                    [
                        [
                            "Starting Skills",
                            "Glowcraft (Fel), Lamp Lore (Wicks) (Int), Tongue (High Wick, Low Wick) (Int)",
                        ],
                        ["Starting Talents", "Steady Hand"],
                        ["Starting Gear", "Lantern"],
                    ],
                ),
            ],
            bc,
        );
        expect(
            (origins[0]?.grants["skills"] as { name: string; specialization: string }[]).map((s) => [
                s.name,
                s.specialization,
            ]),
        ).toEqual([
            ["Glowcraft", ""],
            ["Lamp Lore", "Wicks"],
            ["Tongue", "High Wick"],
            ["Tongue", "Low Wick"],
        ]);
    });

    it("grants a talent's listed specialisations and offers the alternatives among them", () => {
        const origins = readInlineOrigins(
            [
                at("STAGE 2: SELECT AN ARCHETYPE", "display", ["Lamps"], [], "Pick one."),
                at("Flamewright", "display", ["Lamps"], [], "Fire answers the call."),
                at(
                    "SKILLS, TALENTS & GEAR",
                    "sub",
                    ["Lamps", "Flamewright"],
                    [
                        ["Starting Skills", "Lamp Lore"],
                        ["Starting Talents", "Wick Training (Tallow, and Beeswax or Oil)"],
                        ["Starting Gear", "Lantern"],
                    ],
                ),
            ],
            bc,
        );
        expect(origins[0]?.grants["talents"]).toEqual([{ name: "Wick Training", specialization: "Tallow" }]);
        expect(origins[0]?.grants["choices"]).toEqual([
            {
                type: "talent",
                label: "Starting Talents",
                count: 1,
                options: [
                    {
                        name: "Wick Training",
                        label: "Wick Training",
                        value: "Wick Training",
                        specializations: ["Beeswax", "Oil"],
                    },
                ],
            },
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

describe("origins each under a heading of their own", () => {
    const display = (text: string, pageIndex: number, sections: string[], body = ""): Entry => ({
        ...entry(text, pageIndex, sections, body),
        heading: { text, size: 30, style: "d", pageIndex },
    });
    const part = ["Choose the Background"];

    it("reads a heading whose rules repeat its name under a section closing on a step", () => {
        const entries: Entry[] = [
            display("Lamp Wardens", 7, part, "Keepers of the long wicks."),
            // A heading set apart between them does not end the origin's rules.
            entry("TRIMMING AT DUSK", 8, ["Wick Lore", "Dusk"]),
            entry("LAMP WARDENS PASTS", 9, [...part, "Lamp Wardens"]),
            entry("LAMP WARDENS SOLO ABILITY", 10, [...part, "Lamp Wardens"]),
            display("Reed Cutters", 12, part, "Who work the marsh."),
            // One heading repeating the name is not enough.
            entry("REED CUTTERS PASTS", 13, [...part, "Reed Cutters"]),
        ];
        expect(
            readHeadedOrigins(entries, STEPS).map((o) => [o.name, o.step.key, o.pageIndex, o.description]),
        ).toEqual([["Lamp Wardens", "background", 7, "Keepers of the long wicks."]]);
    });

    it("reads none where the step's name does not close the section", () => {
        const wargear = ["Background Wargear"];
        const entries: Entry[] = [
            display("Followers", 20, wargear),
            entry("FOLLOWERS IN THE FIELD", 21, [...wargear, "Followers"]),
            entry("FOLLOWERS WITHOUT SHEETS", 22, [...wargear, "Followers"]),
        ];
        expect(readHeadedOrigins(entries, STEPS)).toEqual([]);
    });
});

describe("origins on the pages a step's section cites", () => {
    // Printed page = page index + 1.
    const printed = (pageIndex: number): string => String(pageIndex + 1);
    const lines = ["Creation"];
    const entries: Entry[] = [
        entry(
            "STAGE 2: CHOOSE A BACKGROUND",
            3,
            lines,
            "Pick where you served. You will find the backgrounds on pages 11-14.",
        ),
        entry("The Lamp Wardens", 10, lines, "Keepers of the long wicks."),
        entry("TRIMMING", 10, [...lines, "The Lamp Wardens"], "Wicks are cut at dusk."),
        entry(
            "LAMP WARDENS CHARACTERS",
            11,
            [...lines, "The Lamp Wardens", "TRIMMING"],
            "Lamp Wardens gain the following benefits: +5 Perception, +5 Willpower, and the Steady Hand ability.",
        ),
        entry("Reed Cutters", 12, lines, "Who work the marsh."),
        entry("REED CUTTERS CHARACTERS", 13, [...lines, "Reed Cutters"], "They gain +5 Strength."),
        // Past the cited pages: not an origin of the step.
        entry("Bell Ringers", 20, lines, "Who ring the hours."),
        entry("BELL RINGERS CHARACTERS", 20, [...lines, "Bell Ringers"], "They gain +5 Fellowship."),
    ];

    it("finds the pages a step's own section cites", () => {
        expect(citedOriginPages(entries, STEPS)).toEqual(new Map([["background", [{ lo: 11, hi: 14 }]]]));
    });

    it("reads a heading repeated by a heading of its own beneath it there as an origin", () => {
        const origins = readCitedOrigins(entries, STEPS, printed);
        expect(origins.map((o) => [o.name, o.step.key, o.pageIndex, o.modifiers, o.description])).toEqual([
            ["Lamp Wardens", "background", 11, { perception: 5, willpower: 5 }, "Keepers of the long wicks."],
            ["Reed Cutters", "background", 13, { strength: 5 }, "Who work the marsh."],
        ]);
    });

    it("drops a step's readings from other pages and reads its cited origins in their place", () => {
        const stray = readCitedOrigins(entries, STEPS, () => "12")
            .slice(0, 1)
            .map((o) => ({ ...o, name: "Stray", pageIndex: 30 }));
        const none: ReadonlySet<string> = new Set();
        expect(withCitedOrigins(stray, entries, STEPS, printed, none).map((o) => o.name)).toEqual([
            "Lamp Wardens",
            "Reed Cutters",
        ]);
        // A reading on the cited pages stands, and the step is read from it alone.
        const onPage = stray.map((o) => ({ ...o, pageIndex: 12 }));
        expect(withCitedOrigins(onPage, entries, STEPS, printed, none).map((o) => o.name)).toEqual(["Stray"]);
        // A step a table read is not read again.
        expect(withCitedOrigins([], entries, STEPS, printed, new Set(["background"]))).toEqual([]);
    });
});

describe("traitGrant", () => {
    it("reads a bracketed figure as the trait's level and a bracketed word as its specialisation", () => {
        expect(traitGrant("Unnatural Toughness (2)")).toEqual({ name: "Unnatural Toughness", level: 2 });
        expect(traitGrant("Unnatural Characteristic (Strength)")).toEqual({
            name: "Unnatural Characteristic",
            specialization: "Strength",
        });
        expect(traitGrant("Dark-sight")).toEqual({ name: "Dark-sight" });
        expect(traitGrant("Unnatural Strength (x2)")).toEqual({ name: "Unnatural Strength (x2)" });
    });
});
