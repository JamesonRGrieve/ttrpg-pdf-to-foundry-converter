// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { listedSkills, readsWhole, skillKey, trainedSkillsOf } from "../../src/infer/npc-skills.ts";
import { fillSkillCharacteristics } from "../../src/infer/pipeline.ts";
import type { Entity, JsonValue } from "../../src/types/entity.ts";

describe("statblock skills", () => {
    it("keys a skill by its name in lower camel case", () => {
        expect(skillKey("Lantern Lore")).toBe("lanternLore");
        expect(skillKey("Wick-Use")).toBe("wickUse");
        expect(skillKey("  Hush ")).toBe("hush");
    });

    it("reads each entry's name, specialisation, characteristic and rank", () => {
        expect(listedSkills("Hush (Ag) +20, Lantern Lore (Reeds) (Int), Wading (S) +10.")).toEqual([
            {
                key: "hush",
                name: "Hush",
                specialization: "",
                characteristic: "agility",
                advance: 3,
                bonus: 0,
            },
            {
                key: "lanternLore",
                name: "Lantern Lore (Reeds)",
                specialization: "Reeds",
                characteristic: "intelligence",
                advance: 1,
                bonus: 0,
            },
            {
                key: "wading",
                name: "Wading",
                specialization: "",
                characteristic: "strength",
                advance: 2,
                bonus: 0,
            },
        ]);
    });

    it("reads a rank inside the brackets, groups in either order, and a kind-last lore", () => {
        const [inside, reversed, lore] = listedSkills(
            "Lantern Lore (Wards +10), Hush +10 (Ag), Lore: Lantern (Tides) (Int)",
        );
        expect([inside?.name, inside?.advance]).toEqual(["Lantern Lore (Wards)", 2]);
        expect([reversed?.name, reversed?.characteristic, reversed?.advance]).toEqual(["Hush", "agility", 2]);
        expect([lore?.key, lore?.name]).toEqual(["lanternLore", "Lantern Lore (Tides)"]);
    });

    it("reads one bracket of specialisations at their own ranks as the skill once per specialisation", () => {
        const skills = listedSkills("Lantern Lore (Reeds +20, Tides +10, Fens) (Int), Wading (Str) +10");
        expect(skills.map((s) => [s.name, s.characteristic, s.advance])).toEqual([
            ["Lantern Lore (Reeds)", "intelligence", 3],
            ["Lantern Lore (Tides)", "intelligence", 2],
            ["Lantern Lore (Fens)", "intelligence", 1],
            // A longer abbreviation of a characteristic is its tag all the same.
            ["Wading", "strength", 2],
        ]);
        expect(Object(trainedSkillsOf(skills)["lanternLore"]).entries).toHaveLength(3);
    });

    it("reads a characteristic tag printed before the specialisation", () => {
        const [skill] = listedSkills("Lantern Lore (Int) (Reeds, Tides) +10");
        expect(skill).toMatchObject({
            key: "lanternLore",
            name: "Lantern Lore (Reeds, Tides)",
            specialization: "Reeds, Tides",
            characteristic: "intelligence",
            advance: 2,
        });
    });

    it("reads a rank printed alone in brackets", () => {
        expect(listedSkills("Hush (Ag) (+20)")[0]).toMatchObject({
            name: "Hush",
            characteristic: "agility",
            advance: 3,
        });
    });

    it("tells an entry that read whole from one with a rank or a number left in it", () => {
        const whole = (line: string): boolean[] => listedSkills(line).map(readsWhole);
        expect(whole("Hush (Ag) +20, Lantern Lore (Sector 13) (Int)")).toEqual([true, true]);
        // A callout number beside the line, and a note after the rank.
        expect(whole("Wading (S) +10 8")).toEqual([false]);
        expect(whole("Hush (Ag) +20 (2)")).toEqual([false]);
    });

    it("keeps a modifier past the top rank as a bonus, and lists nothing for none", () => {
        expect(listedSkills("Hush (Ag) +50")[0]).toMatchObject({ advance: 4, bonus: 20 });
        expect(listedSkills("None.")).toEqual([]);
        expect(listedSkills("—")).toEqual([]);
        // A comma inside a specialisation's brackets separates no entries.
        expect(listedSkills("Lantern Lore (Reeds, Tides) (Int)").map((s) => s.specialization)).toEqual([
            "Reeds, Tides",
        ]);
    });

    it("writes one row per skill, and an entry per specialisation of a skill listed several times", () => {
        const trained = trainedSkillsOf(
            listedSkills(
                "Hush (Ag) +10, Lantern Lore (Reeds) (Int) +20, Lantern Lore (Tides) (Int), Wading (Marsh) (S)",
            ),
        );
        expect(trained).toEqual({
            hush: {
                name: "Hush",
                characteristic: "agility",
                advance: 2,
                trained: true,
                plus10: true,
                plus20: false,
                plus30: false,
                bonus: 0,
            },
            lanternLore: {
                name: "Lantern Lore",
                characteristic: "intelligence",
                advance: 0,
                trained: false,
                plus10: false,
                plus20: false,
                plus30: false,
                bonus: 0,
                entries: [
                    {
                        name: "Reeds",
                        specialization: "Reeds",
                        characteristic: "intelligence",
                        advance: 3,
                        bonus: 0,
                    },
                    {
                        name: "Tides",
                        specialization: "Tides",
                        characteristic: "intelligence",
                        advance: 1,
                        bonus: 0,
                    },
                ],
            },
            wading: {
                name: "Wading (Marsh)",
                characteristic: "strength",
                advance: 1,
                trained: true,
                plus10: false,
                plus20: false,
                plus30: false,
                bonus: 0,
            },
        });
    });

    it("counts a specialisation printed twice once, at its higher rank", () => {
        const trained = trainedSkillsOf(listedSkills("Hush (Ag), Hush (Ag) +20"));
        expect(trained["hush"]).toMatchObject({ advance: 3, plus20: true });
    });

    it("gives an untagged skill the characteristic of the document's own skill entry", () => {
        const entity = (documentType: "Item" | "Actor", fields: Record<string, JsonValue>): Entity => ({
            blockId: "b",
            documentType,
            group: "dh2",
            pack: "p",
            ordinal: 0,
            fields,
            images: {},
            provenance: { pageIndex: 0, y: 0 },
        });
        const skill = entity("Item", {
            name: "Lantern Lore",
            type: "skill",
            system: { characteristic: "intelligence" },
        });
        const npc = (name: string, skills: string): Entity =>
            entity("Actor", {
                name,
                type: "npc",
                system: { skills, trainedSkills: trainedSkillsOf(listedSkills(skills)) },
            });
        const actor = npc("Lamp Warden", "Lantern Lore (Reeds), Lantern Lore (Tides), Wading (S)");
        const untagged = npc("Wick Keeper", "Lantern Lore (Reeds), Hush");
        fillSkillCharacteristics([skill, actor, untagged]);
        const trained = Object(Object(actor.fields["system"])["trainedSkills"]);
        expect(trained.lanternLore.characteristic).toBe("intelligence");
        expect(trained.lanternLore.entries.map((e: { characteristic: string }) => e.characteristic)).toEqual([
            "intelligence",
            "intelligence",
        ]);
        expect(trained.wading.characteristic).toBe("strength");
        // A skill the document tags nowhere: that statblock keeps its printed line alone.
        expect(Object(untagged.fields["system"])).toEqual({ skills: "Lantern Lore (Reeds), Hush" });
    });

    it("gives an untagged skill the characteristic the document's statblocks most often print for it", () => {
        const actor = (name: string, skills: string): Entity => ({
            blockId: "b",
            documentType: "Actor",
            group: "dh2",
            pack: "p",
            ordinal: 0,
            fields: { name, type: "npc", system: { trainedSkills: trainedSkillsOf(listedSkills(skills)) } },
            images: {},
            provenance: { pageIndex: 0, y: 0 },
        });
        const actors = [
            actor("Lamp Warden", "Hush (Ag), Wading (S)"),
            actor("Wick Keeper", "Hush (Ag), Wading (S)"),
            actor("Reed Cutter", "Hush (Per), Wading (S)"),
            actor("Glim Beast", "Hush, Wading (Marsh), Wading (Fen) (T)"),
        ];
        fillSkillCharacteristics(actors);
        const trained = Object(Object(actors[3]?.fields["system"])["trainedSkills"]);
        expect(trained.hush.characteristic).toBe("agility");
        // The entry printed with its own tag keeps it; the untagged one takes the document's.
        expect(trained.wading.entries.map((e: { characteristic: string }) => e.characteristic)).toEqual([
            "strength",
            "toughness",
        ]);
    });
});
