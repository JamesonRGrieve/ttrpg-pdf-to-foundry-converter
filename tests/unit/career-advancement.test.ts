// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    type AdvancementTable,
    advancePrerequisites,
    attachCareerAdvancement,
    characteristicCosts,
    headingAbove,
    isCharacteristicCostTable,
    type KindOf,
    rankAdvances,
    rankOf,
} from "../../src/infer/career-advancement.ts";
import type { Entity } from "../../src/types/entity.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

const run = (text: string, x: number, y: number, size = 10, column = 0): IRTextRun => ({
    pageIndex: 3,
    band: 0,
    x,
    y,
    width: 6 * text.length,
    height: size,
    text,
    font: "f",
    weight: "normal",
    italic: false,
    size,
    sizeBucket: 0,
    column,
    indent: 0,
    renderOrder: 0,
});

const irOf = (runs: IRTextRun[]): IR => ({
    irVersion: 0,
    pages: [],
    runs,
    sizeBuckets: [],
    fonts: [],
    meta: { title: null, author: null, producer: null, creator: null, creationDate: null },
    fingerprint: {
        pageSizes: [],
        orientation: "portrait",
        columns: 1,
        fonts: [],
        sizeBuckets: [],
        marginBox: { left: 0, right: 0, top: 0, bottom: 0 },
    },
});

/** The document defines these names: Lamp Rating a talent, Glass Implants a trait, Trimming a skill. */
const kindOf: KindOf = (name) =>
    (({ "lamp rating": "talent", "glass implants": "trait", trimming: "skill" })[name.toLowerCase()] as
        "talent" | "trait" | "skill" | null) ?? null;

describe("a career's advancement tables", () => {
    it("reads the heading set over a table, not the table's own header or text further up", () => {
        const table = [run("Advance", 20, 500), run("Cost", 200, 500), run("Wick Lore", 20, 488)];
        const ir = irOf([
            run("Chapter text far above.", 20, 600),
            run("RANK 1", 20, 518, 12),
            run("LAMPWRIGHT ADVANCES", 70, 518, 12),
            // The same heights in the next text column are another table's.
            run("RANK 2 LAMPWRIGHT ADVANCES", 320, 518, 12, 1),
            ...table,
        ]);
        expect(headingAbove(ir, table)).toBe("RANK 1 LAMPWRIGHT ADVANCES");
        expect(rankOf("Rank 1 Lampwright Advances")).toBe(1);
        expect(rankOf("Lampwright Characteristic Advances")).toBeNull();
    });

    it("reads each characteristic's cost at each tier", () => {
        expect(
            isCharacteristicCostTable(["Characteristic", "Simple", "Intermediate", "Trained Expert"]),
        ).toBe(true);
        expect(isCharacteristicCostTable(["Advance", "Cost", "Type"])).toBe(false);
        expect(
            characteristicCosts([
                ["Weapon Skill", "250", "500", "750 1,000"],
                ["Wick Sense", "1", "2", "3", "4"],
                ["Fellowship", "500", "750"],
            ]),
        ).toEqual({ weaponSkill: { simple: 250, intermediate: 500, trained: 750, expert: 1000 } });
    });

    it("reads a rank's advances: specialisation, multiplier, type and typed prerequisites", () => {
        const headers = ["Advance", "Cost", "Type Prerequisites"];
        expect(
            rankAdvances(
                headers,
                [
                    ["Trimming", "100", "", "Skill"],
                    ["Lore (Glass)", "100", "Skill", ""],
                    ["Steady Hand (x2)", "200", "Talent", "Glass Implants"],
                    ["Wick Ward", "500", "Talent Lamp Rating, Ag 30, Special"],
                    ["Section row", "", ""],
                ],
                kindOf,
            ),
        ).toEqual([
            { name: "Trimming", cost: 100, type: "skill", prerequisites: [] },
            { name: "Lore", cost: 100, type: "skill", specialization: "Glass", prerequisites: [] },
            {
                name: "Steady Hand",
                cost: 200,
                type: "talent",
                multiplier: 2,
                prerequisites: [{ type: "trait", key: "Glass Implants" }],
            },
            {
                name: "Wick Ward",
                cost: 500,
                type: "talent",
                prerequisites: [
                    { type: "talent", key: "Lamp Rating" },
                    { type: "characteristic", key: "agility", value: 30 },
                ],
            },
        ]);
        expect(advancePrerequisites("—", kindOf)).toEqual([]);
    });

    it("gives each career the tables its heading names, or that follow its entry; rank 1 advances only", () => {
        const career = (name: string, pageIndex: number): Entity => ({
            blockId: "b",
            documentType: "Item",
            group: "rt",
            pack: "p",
            ordinal: pageIndex,
            fields: { name, type: "originPath", system: { step: "career" } },
            images: {},
            provenance: { pageIndex, y: 0 },
        });
        const wright = career("Lampwright", 10);
        const keeper = career("Wick-Keeper", 14);
        const table = (
            pageIndex: number,
            top: number,
            heading: string,
            kind: AdvancementTable["kind"],
            rows: string[][],
        ): AdvancementTable => ({
            kind,
            pageIndex,
            column: 0,
            top,
            heading,
            headers: kind === "advances" ? ["Advance", "Cost", "Type"] : ["Characteristic", "Simple"],
            rows,
        });
        attachCareerAdvancement(
            [wright, keeper],
            [
                table(11, 700, "LAMPWRIGHT CHARACTERISTIC ADVANCES", "characteristics", [
                    ["Agility", "100", "250", "500", "750"],
                ]),
                table(11, 400, "RANK 1 LAMPWRIGHT ADVANCES", "advances", [["Trimming", "100", "Skill"]]),
                // Run on under a stray line: still rank 1.
                table(12, 700, "Glass) +10", "advances", [["Polish", "100", "Skill"]]),
                table(12, 400, "RANK 2 ADVANCES", "advances", [["Glazing", "200", "Skill"]]),
                // A heading that misreads the career's name: the career entered before it.
                table(15, 700, "RANK 1 WICK-KEPER ADVANCES", "advances", [["Snuffing", "100", "Skill"]]),
            ],
            kindOf,
        );
        expect(wright.fields["system"]).toEqual({
            step: "career",
            careerAdvancement: {
                characteristicCosts: {
                    agility: { simple: 100, intermediate: 250, trained: 500, expert: 750 },
                },
                rank1Advances: [
                    { name: "Trimming", cost: 100, type: "skill", prerequisites: [] },
                    { name: "Polish", cost: 100, type: "skill", prerequisites: [] },
                ],
            },
        });
        expect(keeper.fields["system"]).toEqual({
            step: "career",
            careerAdvancement: {
                characteristicCosts: {},
                rank1Advances: [{ name: "Snuffing", cost: 100, type: "skill", prerequisites: [] }],
            },
        });
    });
});
