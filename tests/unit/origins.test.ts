// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/infer/detect-entries.ts";
import {
    characteristicChanges,
    characteristicModifiers,
    equipmentItem,
    originStepNamedBy,
    readOriginPaths,
    readOriginTable,
    splitTopLevel,
} from "../../src/infer/origin-paths.ts";
import { DEFAULT_TARGET, TARGETS } from "../../src/infer/targets.ts";

const STEPS = DEFAULT_TARGET.originSteps;

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
    });

    it("recognises a caption naming a creation step", () => {
        expect(originStepNamedBy("Random Home World", STEPS)?.key).toBe("homeWorld");
        expect(originStepNamedBy("Omens", STEPS)).toBeNull();
    });

    it("writes each line's own actor types", () => {
        expect(TARGETS.rt.actorTypes).toEqual({
            npc: "rt-npc",
            terracraft: "rt-terracraft",
            aircraft: "rt-aircraft",
        });
        expect(TARGETS.dh1.actorTypes.aircraft).toBe("aircraft");
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
        const [origin] = readOriginPaths(entries, STEPS);
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
        const [origin] = readOriginPaths(entries, STEPS);
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
        const [origin] = readOriginPaths(entries, STEPS);
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
        const [origin] = readOriginPaths(entries, STEPS);
        expect(origin?.name).toBe("WARDEN");
        expect(origin?.step.key).toBe("elite");
    });

    it("ignores a section that only describes a step in prose", () => {
        const s = ["ELITE ADV ANCES", "GENERAL RULES"];
        const entries = [
            entry("GENERAL RULES", 30, ["ELITE ADV ANCES"]),
            entry("INSTANT CHANGES", 30, s, "Explains what changes."),
            entry("UNLOCKED ADVANCES", 30, s, "Explains what unlocks."),
        ];
        expect(readOriginPaths(entries, STEPS)).toEqual([]);
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
});
