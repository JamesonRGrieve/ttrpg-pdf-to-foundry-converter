// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    type AdvancementTable,
    advancePrerequisites,
    attachCareerAdvancement,
    characteristicCosts,
    headingAbove,
    isCharacteristicCostTable,
    isRankTable,
    type KindOf,
    numberRanks,
    printedRanks,
    rankAdvances,
    rankNamed,
    rankOf,
    rankCharts,
    headingBeside,
    isAdvanceHeaderRow,
    topLine,
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

    it("gives each career the tables its heading names, or that follow its entry; every numbered rank", () => {
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
                rank1Advances: [],
                ranks: [
                    {
                        rank: 1,
                        title: "",
                        minXp: null,
                        advances: [
                            { name: "Trimming", cost: 100, type: "skill", prerequisites: [] },
                            { name: "Polish", cost: 100, type: "skill", prerequisites: [] },
                        ],
                    },
                    {
                        rank: 2,
                        title: "",
                        minXp: null,
                        advances: [{ name: "Glazing", cost: 200, type: "skill", prerequisites: [] }],
                    },
                ],
            },
        });
        expect(keeper.fields["system"]).toEqual({
            step: "career",
            careerAdvancement: {
                characteristicCosts: {},
                rank1Advances: [],
                ranks: [
                    {
                        rank: 1,
                        title: "",
                        minXp: null,
                        advances: [{ name: "Snuffing", cost: 100, type: "skill", prerequisites: [] }],
                    },
                ],
            },
        });
    });

    it("numbers a titled rank from the career's table of ranks: branches starting at one XP share a number", () => {
        const ranks = printedRanks(
            ["Rank", "XP Level", "Follows"],
            [
                ["TRIMMER", "0–499", "—"],
                ["SNUFFER", "500–999", "Trimmer"],
                ["CHIEF SNUFFER", "1,000–1,999", "Snuffer"],
                ["CHIEF GLAZER", "1,000–1,999", "Snuffer"],
                ["MASTER CHIEF GLAZER", "2,000–2,999", "Chief Glazer"],
            ],
        );
        expect(ranks.map((r) => [r.title, r.minXp])).toEqual([
            ["Trimmer", 0],
            ["Snuffer", 500],
            ["Chief Snuffer", 1000],
            ["Chief Glazer", 1000],
            ["Master Chief Glazer", 2000],
        ]);
        expect([...numberRanks(ranks).values()]).toEqual([1, 2, 3, 3, 4]);
        expect(isRankTable(["Rank", "XP Level", "Follows"])).toBe(true);
        expect(isRankTable(["Advance", "Cost", "Type"])).toBe(false);
        // A shorter heading takes the earliest rank holding its words that no table has claimed.
        const glazer = ranks[3];
        expect(rankNamed("CHIEF GLAZER ADVANCES", ranks, new Set())).toBe(glazer);
        expect(rankNamed("GLAZER ADVANCES", ranks, new Set())).toBe(glazer);
        expect(rankNamed("GLAZER ADVANCES", ranks, new Set(glazer === undefined ? [] : [glazer]))).toBe(
            ranks[4],
        );
        expect(rankNamed("CHANDLER ADVANCES", ranks, new Set())).toBeUndefined();
    });

    it("gives a titled table its rank's number, title and starting XP", () => {
        const career: Entity = {
            blockId: "b",
            documentType: "Item",
            group: "dh1",
            pack: "p",
            ordinal: 1,
            fields: { name: "Lampwright", type: "originPath", system: { step: "career" } },
            images: {},
            provenance: { pageIndex: 3, y: 0 },
        };
        const at = (
            top: number,
            heading: string,
            kind: AdvancementTable["kind"],
            headers: string[],
            rows: string[][],
        ): AdvancementTable => ({
            kind,
            pageIndex: 4,
            column: 0,
            top,
            heading,
            headers,
            rows,
        });
        attachCareerAdvancement(
            [career],
            [
                at(
                    900,
                    "LAMPWRIGHT RANKS",
                    "ranks",
                    ["Rank", "XP Level"],
                    [
                        ["TRIMMER", "0–499"],
                        ["SNUFFER", "500–999"],
                    ],
                ),
                at(
                    600,
                    "SNUFFER ADVANCES",
                    "advances",
                    ["Advance", "Cost", "Type"],
                    [["Snuffing", "200", "Talent"]],
                ),
                at(
                    300,
                    "TRIMMER ADVANCES",
                    "advances",
                    ["Advance", "Cost", "Type"],
                    [["Trimming", "100", "Skill"]],
                ),
            ],
            kindOf,
        );
        expect(career.fields["system"]).toEqual({
            step: "career",
            careerAdvancement: {
                characteristicCosts: {},
                rank1Advances: [],
                ranks: [
                    {
                        rank: 1,
                        title: "Trimmer",
                        minXp: 0,
                        advances: [{ name: "Trimming", cost: 100, type: "skill", prerequisites: [] }],
                    },
                    {
                        rank: 2,
                        title: "Snuffer",
                        minXp: 500,
                        advances: [{ name: "Snuffing", cost: 200, type: "talent", prerequisites: [] }],
                    },
                ],
            },
        });
    });

    it("reads a chart of ranks: each box's title over the XP it starts at", () => {
        const face = (r: IRTextRun, font: string): IRTextRun => ({ ...r, font });
        const charts = rankCharts(
            irOf([
                face(run("Trimmer", 110, 700, 7), "title"),
                face(run("XP Level: 0-499", 100, 694, 5), "xp"),
                face(run("Chief", 112, 660, 7), "title"),
                face(run("Snuffer", 110, 652, 7), "title"),
                face(run("XP Level: 500-999", 100, 646, 5), "xp"),
                // A box beside it, on the same lines: its own title, not the other's.
                face(run("Glazer", 210, 652, 7), "title"),
                face(run("XP Level: 500-999", 200, 646, 5), "xp"),
            ]),
        );
        expect(charts.map((c) => c.rows)).toEqual([
            [
                ["Trimmer", "0"],
                ["Chief Snuffer", "500"],
                ["Glazer", "500"],
            ],
        ]);
    });

    it("finds a rank's title set beside the table's header line, in a face the table does not use", () => {
        const header = [run("Advance", 170, 286), run("Cost", 260, 286)];
        const side = (text: string, y: number): IRTextRun => ({ ...run(text, 100, y, 11), font: "display" });
        const ir = irOf([...header, side("SNUFFER", 292), side("ADVANCES", 276), run("prose", 45, 254)]);
        expect(headingBeside(ir, header, topLine(header))).toBe("SNUFFER ADVANCES");
        expect(isAdvanceHeaderRow(["SNUFFER", "Advance", "Cost", "Type"])).toBe(true);
        expect(isAdvanceHeaderRow(["Advance", "100", "Skill"])).toBe(false);
    });

    it("reads a row from its cost: initials for the type, a name sharing the cost's cell, prose before the name", () => {
        expect(
            rankAdvances(
                ["Advance", "Cost", "Type"],
                [
                    ["Trimming +10 100", "S", "", "Trimming"],
                    ["the guild,", "hence Snuffing", "", "200", "", "T Ag 30"],
                ],
                kindOf,
            ),
        ).toEqual([
            {
                name: "Trimming +10",
                cost: 100,
                type: "skill",
                prerequisites: [{ type: "skill", key: "Trimming" }],
            },
            {
                name: "Snuffing",
                cost: 200,
                type: "talent",
                prerequisites: [{ type: "characteristic", key: "agility", value: 30 }],
            },
        ]);
    });
});
