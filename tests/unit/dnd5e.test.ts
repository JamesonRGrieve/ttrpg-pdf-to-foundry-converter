// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildDocuments } from "../../src/infer/dnd5e/documents.ts";
import { inferDnd5e } from "../../src/infer/dnd5e/index.ts";
import { cellsOf, columnEdges, type Line, readLayout } from "../../src/infer/dnd5e/layout.ts";
import { featureNames, readProgression } from "../../src/infer/dnd5e/progression.ts";
import { readCharacterOptions, readSkills } from "../../src/infer/dnd5e/read.ts";
import { linesHtml, readFields, readTraits } from "../../src/infer/dnd5e/text.ts";
import { ABILITIES, countOf, keysNamed, SKILLS } from "../../src/infer/dnd5e/vocab.ts";
import { inferPageNumbering } from "../../src/infer/page-numbers.ts";
import { LINES } from "../../src/infer/schema.ts";
import { DND5E_TARGETS, TARGET_IDS, targetFor, targetId, TARGETS } from "../../src/infer/targets.ts";
import { createLogger } from "../../src/logger.ts";
import { moduleSystem } from "../../src/run.ts";
import { emit } from "../../src/stages/emit.ts";
import { buildModule, MODULE_ASSET_PLACEHOLDER } from "../../src/stages/module.ts";
import type { JsonObject, JsonValue } from "../../src/types/entity.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

/**
 * Synthetic pages laid out the way the dnd5e reader expects character options
 * to be typeset — headings by size, bold labels, bold-italic trait leads, level
 * tables — filled with invented content.
 */

const BODY = 10;
/** Width of a character, in ems, for the synthetic runs. */
const CHAR_EM = 0.5;
const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

interface CellSpec {
    text: string;
    x: number;
    size?: number;
    bold?: boolean;
    italic?: boolean;
}

/** A cell of a row, placed by its offset from the column's left edge. */
type RowCell = Omit<CellSpec, "x"> & { dx: number };

const widthOf = (text: string, size: number): number => text.length * size * CHAR_EM;

class Doc {
    readonly runs: IRTextRun[] = [];
    readonly pages = new Set<number>();

    put(page: number, column: number, y: number, cells: readonly CellSpec[], size: number): void {
        this.pages.add(page);
        for (const c of cells) {
            const s = c.size ?? size;
            this.runs.push({
                pageIndex: page,
                band: 0,
                x: c.x,
                y,
                width: widthOf(c.text, s),
                height: s * 0.7,
                text: c.text,
                font: c.bold === true && s > BODY ? "display" : c.bold === true ? "serif-bold" : "serif",
                weight: c.bold === true ? "bold" : "normal",
                italic: c.italic ?? false,
                size: s,
                sizeBucket: 0,
                column,
                indent: 0,
                renderOrder: this.runs.length,
            });
        }
    }

    ir(title: string | null = null): IR {
        return {
            irVersion: 0,
            pages: [...this.pages]
                .sort((a, b) => a - b)
                .map((p) => ({
                    pageIndex: p,
                    width: PAGE_WIDTH,
                    height: PAGE_HEIGHT,
                    rotation: 0,
                    columns: 2,
                    edgeText: [],
                    hasTextLayer: true,
                })),
            runs: this.runs,
            sizeBuckets: [],
            fonts: [],
            meta: { title, author: null, producer: null, creator: null, creationDate: null },
            fingerprint: {
                pageSizes: [],
                orientation: "portrait",
                columns: 2,
                fonts: [],
                sizeBuckets: [],
                marginBox: { left: 0, right: 0, top: 0, bottom: 0 },
            },
        };
    }
}

/** Writes lines down one column of one page. */
class Column {
    private y: number;

    constructor(
        private readonly doc: Doc,
        private readonly page: number,
        private readonly column: number,
        readonly x: number,
        top = 730,
    ) {
        this.y = top;
    }

    at(y: number): this {
        this.y = y;
        return this;
    }

    heading(text: string, size: number): this {
        this.y -= size * 0.5;
        this.doc.put(this.page, this.column, this.y, [{ text, x: this.x, bold: true }], size);
        this.y -= size * 1.3;
        return this;
    }

    text(text: string, opts: { dx?: number; italic?: boolean; size?: number } = {}): this {
        const size = opts.size ?? BODY;
        this.doc.put(
            this.page,
            this.column,
            this.y,
            [{ text, x: this.x + (opts.dx ?? 0), italic: opts.italic === true }],
            size,
        );
        this.y -= size * 1.2;
        return this;
    }

    /** A row of cells at offsets from the column's left edge. */
    cells(cells: readonly RowCell[], size: number): this {
        this.doc.put(
            this.page,
            this.column,
            this.y,
            cells.map(({ dx, ...c }) => ({ ...c, x: this.x + dx })),
            size,
        );
        this.y -= size * 1.4;
        return this;
    }

    /** `Label:` in bold, its value after a word space. */
    field(label: string, value: string): this {
        const lead = `${label}:`;
        this.doc.put(
            this.page,
            this.column,
            this.y,
            [
                { text: lead, x: this.x, bold: true },
                { text: value, x: this.x + widthOf(lead, BODY) + 2 },
            ],
            BODY,
        );
        this.y -= BODY * 1.2;
        return this;
    }

    /** A paragraph led by `Label.` in bold italic, indented as a new paragraph. */
    trait(label: string, body: string): this {
        const lead = `${label}.`;
        const x = this.x + 9;
        this.doc.put(
            this.page,
            this.column,
            this.y,
            [
                { text: lead, x, bold: true, italic: true },
                { text: body, x: x + widthOf(lead, BODY) + 2 },
            ],
            BODY,
        );
        this.y -= BODY * 1.2;
        return this;
    }

    gap(points: number): this {
        this.y -= points;
        return this;
    }
}

const LEFT = 50;
const RIGHT = 320;
const SMALL = 9;

/** A three-page document in the older conventions: inline `Label:` fields, ordinal-level tables. */
function olderRules(): IR {
    const doc = new Doc();
    const a = new Column(doc, 0, 0, LEFT);
    a.heading("Callings", 22)
        .heading("Lamplighter", 18)
        .heading("Class Features", 14)
        .text("As a lamplighter, you gain these features.")
        .heading("Hit Points", 12)
        .field("Hit Dice", "1d8 per lamplighter level")
        .field("Hit Points at 1st Level", "8 + your Constitution")
        .text("modifier", { dx: 9 })
        .heading("Proficiencies", 12)
        .field("Armor", "Light armor, shields")
        .field("Weapons", "Simple weapons, hand lanterns")
        .field("Saving Throws", "Wisdom, Charisma")
        .field("Skills", "Choose two from Arcana,")
        .text("History, and Insight", { dx: 9 })
        .heading("The Lamplighter", 12)
        .cells([{ text: "Proficiency", dx: 30, bold: true }], SMALL)
        .cells(
            [
                { text: "Level", dx: 0, bold: true },
                { text: "Bonus", dx: 35, bold: true },
                { text: "Features", dx: 75, bold: true },
                { text: "Charges", dx: 185, bold: true },
            ],
            SMALL,
        )
        .cells(
            [
                { text: "1st", dx: 2 },
                { text: "+2", dx: 40 },
                { text: "Wick Sense,", dx: 75 },
                { text: "2", dx: 192 },
            ],
            SMALL,
        )
        .cells([{ text: "Lamp Craft", dx: 75 }], SMALL)
        .cells(
            [
                { text: "2nd", dx: 2 },
                { text: "+2", dx: 40 },
                { text: "Glow Step", dx: 75 },
                { text: "2", dx: 192 },
            ],
            SMALL,
        )
        .cells(
            [
                { text: "3rd", dx: 2 },
                { text: "+2", dx: 40 },
                { text: "Lantern Path", dx: 75 },
                { text: "3", dx: 192 },
            ],
            SMALL,
        );
    const b = new Column(doc, 0, 1, RIGHT);
    b.cells(
        [
            { text: "4th", dx: 2 },
            { text: "+2", dx: 40 },
            { text: "Ability Score", dx: 75 },
            { text: "3", dx: 192 },
        ],
        SMALL,
    )
        .cells([{ text: "Improvement", dx: 75 }], SMALL)
        .cells(
            [
                { text: "5th", dx: 2 },
                { text: "+3", dx: 40 },
                { text: "Path feature", dx: 75 },
                { text: "4", dx: 192 },
            ],
            SMALL,
        )
        .heading("Wick Sense", 14)
        .text("You sense every open flame near you.")
        .heading("Lamp Craft", 14)
        .text("You trim and relight a lantern quickly.")
        .heading("Glow Step", 14)
        .text("You step from one lit lamp to another.")
        .heading("Lantern Path", 14)
        .text("At 3rd level, you choose a path, such as")
        .text("the Order of the Ember.")
        .heading("Ability Score Improvement", 14)
        .text("You raise one ability score.")
        .heading("Order of the Ember", 14)
        .text("Embers guide this order.")
        .heading("Ember Sight", 12)
        .text("When you join this order at 3rd level,")
        .text("you see through smoke.")
        .heading("Ember Ward", 12)
        .text("Starting at 5th level, flames bend away.");

    const c = new Column(doc, 1, 0, LEFT);
    c.heading("Peoples", 22)
        .heading("Mothkin", 18)
        .text("Mothkin are small and dusty fliers.")
        .heading("Mothkin Traits", 14)
        .text("Your mothkin has these traits.")
        .trait("Ability Score Increase", "Your Dexterity score")
        .text("increases by 2.")
        .trait("Size", "Your size is Small.")
        .trait("Speed", "Your base walking speed is 25")
        .text("feet.")
        .trait("Darkvision", "You see in dim light within 60")
        .text("feet of you.")
        .trait("Dust Wings", "You glide down without harm.")
        .heading("Ash Mothkin", 12)
        .text("Ash mothkin roost near hearths.")
        .trait("Ability Score Increase", "Your Wisdom score")
        .text("increases by 1.")
        .trait("Soot Cloak", "Smoke never makes you cough.");
    // No chapter heading: the background nests under the species' heading.
    new Column(doc, 1, 1, RIGHT)
        .heading("Lampwright", 14)
        .text("You trimmed wicks for a lamp guild.")
        .field("Skill Proficiencies", "History, Insight")
        .field("Equipment", "A lantern and a tinderbox")
        .heading("Feature: Lamp Ward", 12)
        .text("Lamp guilds give you shelter.");

    new Column(doc, 2, 0, LEFT)
        .heading("Talents", 22)
        .text("Talents are optional.")
        .heading("Steady Flame", 14)
        .text("Prerequisite: Wisdom 13 or higher", { italic: true })
        .text("Your flame never gutters in the wind.");
    new Column(doc, 2, 1, RIGHT).text("Notes on wicks and oils.").text("More notes on oils.");
    return doc.ir("Lamplighter Almanac");
}

/** A three-page document in the newer conventions: trait tables, `Level N:` headings, a full-width table. */
function newerRules(): IR {
    const doc = new Doc();
    const traitRow = (col: Column, label: string, value: string): Column =>
        col.cells(
            [
                { text: label, dx: 4, bold: true },
                { text: value, dx: 115 },
            ],
            9.5,
        );
    const a = new Column(doc, 0, 0, LEFT);
    a.heading("Tinker", 18).heading("Core Tinker Traits", 10.5);
    traitRow(a, "Primary Ability", "Intelligence");
    traitRow(a, "Hit Point Die", "D8 per Tinker level");
    traitRow(a, "Saving Throw", "Intelligence and Dexterity");
    a.cells([{ text: "Proficiencies", dx: 4, bold: true }], 9.5);
    traitRow(a, "Skill Proficiencies", "Choose 2: Arcana, History,");
    a.cells([{ text: "or Investigation", dx: 115 }], 9.5);
    traitRow(a, "Weapon Proficiencies", "Simple weapons");
    traitRow(a, "Armor Training", "Light armor");
    traitRow(a, "Starting Equipment", "Choose A or B");
    a.heading("Becoming a Tinker", 14).text("• Gain the Core Tinker Traits.");

    new Column(doc, 0, 1, RIGHT)
        .heading("Tinker Class Features", 14)
        .text("You gain these features as you level.")
        .heading("Level 1: Spark", 12)
        .text("You make a bright spark.")
        .heading("Level 2: Gadget", 12)
        .text("You build a small gadget.")
        .heading("Level 3: Tinker Subclass", 12)
        .text("You choose a subclass.")
        .heading("Level 4: Ability Score Improvement", 12)
        .text("You raise one ability score.")
        .heading("Level 5: Overclock", 12)
        .text("Your gadgets run faster.");

    // A table set across both columns at the foot of the page.
    const t = new Column(doc, 0, 0, LEFT).at(250);
    t.heading("Tinker Features", 10.5)
        .cells([{ text: "Proficiency", dx: 40, bold: true }], 9.25)
        .cells(
            [
                { text: "Level", dx: 0, bold: true },
                { text: "Bonus", dx: 50, bold: true },
                { text: "Class Features", dx: 90, bold: true },
                { text: "Charges", dx: 310, bold: true },
                { text: "Dice", dx: 390, bold: true },
            ],
            9.25,
        );
    const rows: [string, string, string, string, string][] = [
        ["1", "+2", "Spark", "2", "1d4"],
        ["2", "+2", "Gadget", "2", "1d4"],
        ["3", "+2", "Tinker Subclass", "3", "1d6"],
        ["4", "+2", "Ability Score Improvement", "3", "1d6"],
        ["5", "+3", "Overclock", "4", "1d8"],
    ];
    for (const [level, bonus, features, charges, dice] of rows) {
        t.cells(
            [
                { text: level, dx: 6 },
                { text: bonus, dx: 54 },
                { text: features, dx: 90 },
                { text: charges, dx: 320 },
                { text: dice, dx: 392 },
            ],
            9.5,
        );
    }

    new Column(doc, 1, 0, LEFT)
        .heading("Tinker Subclass: Clockwork Path", 14)
        .text("Clockwork tinkers love their gears.")
        .heading("Level 3: Gears", 12)
        .text("You fit gears to anything.")
        .heading("Level 5: Escapement", 12)
        .text("You slip free of any hold.")
        .heading("Origins", 18)
        .heading("Gearling", 12)
        .field("Creature Type", "Construct")
        .field("Size", "Small or Medium")
        .field("Speed", "30 feet")
        .text("As a Gearling, you have these traits.")
        .trait("Cog Heart", "Your heart ticks.")
        .trait("Spring Leap", "When you reach character level 5,")
        .text("you can leap far.");
    new Column(doc, 1, 1, RIGHT)
        .heading("Tinkerer", 12)
        .field("Ability Scores", "Intelligence, Dexterity, Constitution")
        .field("Feat", "Quick Study (see “Feats”)")
        .field("Skill Proficiencies", "Arcana and Investigation")
        .field("Equipment", "Choose A or B: tools or 40 GP")
        .heading("Feats", 18)
        .heading("Quick Study", 12)
        .text("Origin Feat", { italic: true })
        .text("You learn new things fast.")
        .heading("Tough Hide", 12)
        .text("General Feat (Prerequisite: Level 4+)", { italic: true })
        .text("Your skin hardens like bark.")
        .trait("Repeatable", "You can take this feat again.");

    new Column(doc, 2, 0, LEFT).text("Notes on springs and gears.");
    new Column(doc, 2, 1, RIGHT).text("More notes on springs.").text("Still more notes.");
    return doc.ir("Tinker Compendium");
}

const lineAt = (lines: readonly Line[], text: string): Line => {
    const line = lines.find((l) => l.text.startsWith(text));
    if (line === undefined) {
        throw new Error(`no line ${text}`);
    }
    return line;
};

describe("dnd5e vocabulary", () => {
    it("reads counts as digits or words", () => {
        expect(countOf("two")).toBe(2);
        expect(countOf("3")).toBe(3);
        expect(countOf("several")).toBeNull();
    });

    it("names the keys whose labels a text contains, in the system's order", () => {
        expect(keysNamed("Wisdom and Strength", ABILITIES)).toEqual(["str", "wis"]);
        expect(keysNamed("Sleight of Hand, Animal Handling", SKILLS)).toEqual(["ani", "slt"]);
    });

    it("reads skill grants and choices", () => {
        expect(readSkills("History, Insight")).toEqual({ grants: ["skills:his", "skills:ins"], choices: [] });
        expect(readSkills("Choose two from Arcana, History, and Insight")).toEqual({
            grants: [],
            choices: [{ count: 2, pool: ["skills:arc", "skills:his", "skills:ins"] }],
        });
        expect(readSkills("Choose any three")).toEqual({
            grants: [],
            choices: [{ count: 3, pool: ["skills:*"] }],
        });
    });

    it("splits a features cell on commas outside parentheses", () => {
        expect(featureNames("Glow (2 uses), Wick Sense,  ")).toEqual(["Glow (2 uses)", "Wick Sense"]);
        expect(featureNames("-")).toEqual([]);
    });
});

describe("dnd5e targets", () => {
    it("adds the rulesets after the game lines", () => {
        expect(TARGET_IDS).toEqual([...LINES, "dnd5e-2014", "dnd5e-2024"]);
        expect(targetFor("dnd5e-2024")).toBe(DND5E_TARGETS["2024"]);
        expect(targetFor("dnd5e-2019")).toBeNull();
        expect(targetId(DND5E_TARGETS["2014"])).toBe("dnd5e-2014");
        expect(targetId(TARGETS.rt)).toBe("rt");
    });

    it("refuses a run that mixes game systems", () => {
        const pdf = new Uint8Array();
        expect(
            moduleSystem([
                { pdf, target: DND5E_TARGETS["2014"] },
                { pdf, target: DND5E_TARGETS["2024"] },
            ]),
        ).toBe("dnd5e");
        expect(() =>
            moduleSystem([
                { pdf, target: TARGETS.dh2 },
                { pdf, target: DND5E_TARGETS["2024"] },
            ]),
        ).toThrow(/one game system/u);
    });
});

describe("dnd5e layout", () => {
    it("splits cells at wide gaps and where a bold label stops at a tab", () => {
        const doc = new Doc();
        doc.put(
            0,
            0,
            500,
            [
                { text: "Label:", x: 50, bold: true },
                { text: "value", x: 82 },
            ],
            BODY,
        );
        doc.put(
            0,
            0,
            480,
            [
                { text: "Label", x: 50, bold: true },
                { text: "value", x: 84 },
            ],
            BODY,
        );
        doc.put(
            0,
            0,
            460,
            [
                { text: "1st", x: 50 },
                { text: "+2", x: 90 },
            ],
            BODY,
        );
        const line = (y: number): string[] =>
            cellsOf(doc.runs.filter((r) => r.y === y)).map(({ cell }) => cell.text);
        expect(line(500)).toEqual(["Label: value"]);
        expect(line(480)).toEqual(["Label", "value"]);
        expect(line(460)).toEqual(["1st", "+2"]);
    });

    it("finds the column edge the document's pages share", () => {
        expect(columnEdges(olderRules())).toEqual([RIGHT]);
    });

    it("reads columns in turn, and a table set across both after them, row by row", () => {
        const { lines } = readLayout(newerRules());
        const order = (text: string): number => lineAt(lines, text).order;
        expect(order("Becoming a Tinker")).toBeLessThan(order("Tinker Class Features"));
        expect(order("Level 5: Overclock")).toBeLessThan(order("Tinker Features"));
        const row = lineAt(lines, "4 +2 Ability Score Improvement");
        expect(row.cells.map((c) => c.text)).toEqual(["4", "+2", "Ability Score Improvement", "3", "1d6"]);
    });

    it("joins a heading set over two lines and ends a caption's section with its table", () => {
        const { root } = readLayout(newerRules());
        const titles = (s: typeof root): string[] => [
            s.title,
            ...s.items.flatMap((i) => ("items" in i ? titles(i) : [])),
        ];
        expect(titles(root)).toContain("Tinker Subclass: Clockwork Path");
        const tinker = root.items.find((i) => "items" in i && i.title === "Tinker");
        expect(
            tinker !== undefined && "items" in tinker && tinker.items.some((i) => "items" in i && i.caption),
        ).toBe(true);
    });
});

describe("dnd5e progression tables", () => {
    it("reads stacked headers and rows that wrap and break across columns", () => {
        const { lines } = readLayout(olderRules());
        const table = readProgression(lines);
        expect(table?.headers).toEqual(["Level", "Proficiency Bonus", "Features", "Charges"]);
        expect(table?.rows.map((r) => r.cells[table.featuresColumn])).toEqual([
            "Wick Sense, Lamp Craft",
            "Glow Step",
            "Lantern Path",
            "Ability Score Improvement",
            "Path feature",
        ]);
        expect(table?.rows.map((r) => r.cells[3])).toEqual(["2", "2", "3", "3", "4"]);
    });

    it("places the words of one header run over the columns below them", () => {
        const doc = new Doc();
        const col = new Column(doc, 0, 0, LEFT);
        col.cells(
            [
                { text: "Level", dx: 0, bold: true },
                { text: "Features", dx: 40, bold: true },
                { text: "Sparks Range", dx: 120, bold: true },
            ],
            SMALL,
        );
        for (const level of [1, 2]) {
            col.cells(
                [
                    { text: String(level), dx: 2 },
                    { text: "Glow", dx: 40 },
                    { text: "3", dx: 122 },
                    { text: "+10 ft.", dx: 150 },
                ],
                SMALL,
            );
        }
        const table = readProgression(readLayout(doc.ir()).lines);
        expect(table?.headers).toEqual(["Level", "Features", "Sparks", "Range"]);
    });
});

describe("dnd5e fields and traits", () => {
    it("reads inline fields with run-on lines, and stops at the prose after them", () => {
        const { lines } = readLayout(newerRules());
        const gearling = lines.filter(
            (l) => l.pageIndex === 1 && l.order >= lineAt(lines, "Creature Type").order,
        );
        const fields = readFields(gearling.slice(0, 4));
        expect(fields.map((f) => [f.label, f.value])).toEqual([
            ["Creature Type", "Construct"],
            ["Size", "Small or Medium"],
            ["Speed", "30 feet"],
        ]);
        expect(linesHtml(gearling.slice(0, 4))).toContain(
            "<p><strong>Speed:</strong> 30 feet</p><p>As a Gearling",
        );
    });

    it("reads label cells, a label set over two lines, and values that wrap", () => {
        const { lines } = readLayout(newerRules());
        const start = lineAt(lines, "Primary Ability").order;
        const fields = readFields(lines.slice(start, start + 10));
        expect(fields.map((f) => [f.label, f.value])).toEqual([
            ["Primary Ability", "Intelligence"],
            ["Hit Point Die", "D8 per Tinker level"],
            ["Saving Throw Proficiencies", "Intelligence and Dexterity"],
            ["Skill Proficiencies", "Choose 2: Arcana, History, or Investigation"],
            ["Weapon Proficiencies", "Simple weapons"],
            ["Armor Training", "Light armor"],
            ["Starting Equipment", "Choose A or B"],
        ]);
    });

    it("reads traits led by a bold-italic name", () => {
        const { lines } = readLayout(olderRules());
        const start = lineAt(lines, "Ability Score Increase").order;
        const traits = readTraits(lines.slice(start, start + 10));
        expect(traits.slice(0, 3).map((t) => [t.label, t.body])).toEqual([
            ["Ability Score Increase", "Your Dexterity score increases by 2."],
            ["Size", "Your size is Small."],
            ["Speed", "Your base walking speed is 25 feet."],
        ]);
    });
});

describe("dnd5e character options (older conventions)", () => {
    const readings = readCharacterOptions(readLayout(olderRules()));

    it("reads a class from its hit-die field and its level table", () => {
        expect(readings.classes).toHaveLength(1);
        const [lamplighter] = readings.classes;
        expect(lamplighter).toMatchObject({
            name: "Lamplighter",
            hitDie: "d8",
            saves: ["wis", "cha"],
            armor: ["lgt", "shl"],
            weapons: ["sim"],
            skills: { grants: [], choices: [{ count: 2, pool: ["skills:arc", "skills:his", "skills:ins"] }] },
            asiLevels: [4],
            subclassLevel: 3,
        });
        expect(lamplighter?.features.map((f) => [f.name, f.level])).toEqual([
            ["Wick Sense", 1],
            ["Lamp Craft", 1],
            ["Glow Step", 2],
            ["Lantern Path", 3],
        ]);
        expect(lamplighter?.scales).toEqual([
            {
                title: "Charges",
                identifier: "charges",
                type: "number",
                scale: { "1": { value: 2 }, "3": { value: 3 }, "5": { value: 4 } },
            },
        ]);
    });

    it("reads a subclass from the sections whose features state their levels", () => {
        const subclass = readings.classes[0]?.subclasses ?? [];
        expect(subclass.map((s) => [s.name, s.features.map((f) => [f.name, f.level])])).toEqual([
            [
                "Order of the Ember",
                [
                    ["Ember Sight", 3],
                    ["Ember Ward", 5],
                ],
            ],
        ]);
    });

    it("reads a subrace as a species with its parent's traits", () => {
        expect(readings.species.map((s) => s.name)).toEqual(["Ash Mothkin"]);
        expect(readings.species[0]).toMatchObject({
            sizes: ["sm"],
            walk: 25,
            darkvision: 60,
            abilityIncreases: { fixed: { dex: 2, wis: 1 }, points: 0 },
        });
        expect(readings.species[0]?.traits.map((t) => t.label)).toEqual(["Dust Wings", "Soot Cloak"]);
    });

    it("names a species by its heading when its traits heading runs the words together", () => {
        const doc = new Doc();
        new Column(doc, 0, 0, LEFT)
            .heading("Burrowkin", 18)
            .heading("BurrowkinTraits", 14)
            .trait("Size", "Your size is Small.")
            .trait("Speed", "Your base walking speed is 25 feet.")
            .trait("Deep Nose", "You smell water underground.");
        const read = readCharacterOptions(readLayout(doc.ir()));
        expect(read.species.map((s) => s.name)).toEqual(["Burrowkin"]);
    });

    it("reads a background nested under a species heading, and a feat by its prerequisite", () => {
        expect(readings.backgrounds).toHaveLength(1);
        expect(readings.backgrounds[0]).toMatchObject({
            name: "Lampwright",
            skills: { grants: ["skills:his", "skills:ins"], choices: [] },
            feat: null,
        });
        expect(readings.backgrounds[0]?.feature?.name).toBe("Lamp Ward");
        expect(readings.feats.map((f) => [f.name, f.prerequisite, f.level, f.subtype])).toEqual([
            ["Steady Flame", "Wisdom 13 or higher", null, ""],
        ]);
    });
});

describe("dnd5e character options (newer conventions)", () => {
    const readings = readCharacterOptions(readLayout(newerRules()));

    it("reads a class from its traits table and level-headed features", () => {
        const [tinker] = readings.classes;
        expect(tinker).toMatchObject({
            name: "Tinker",
            hitDie: "d8",
            primaryAbility: { value: ["int"], all: true },
            saves: ["dex", "int"],
            armor: ["lgt"],
            weapons: ["sim"],
            skills: { grants: [], choices: [{ count: 2, pool: ["skills:arc", "skills:his", "skills:inv"] }] },
            asiLevels: [4],
            subclassLevel: 3,
        });
        expect(tinker?.features.map((f) => [f.name, f.level])).toEqual([
            ["Spark", 1],
            ["Gadget", 2],
            ["Overclock", 5],
        ]);
        expect(tinker?.scales.map((s) => [s.title, s.type, s.scale])).toEqual([
            ["Charges", "number", { "1": { value: 2 }, "3": { value: 3 }, "5": { value: 4 } }],
            [
                "Dice",
                "dice",
                {
                    "1": { number: 1, faces: 4 },
                    "3": { number: 1, faces: 6 },
                    "5": { number: 1, faces: 8 },
                },
            ],
        ]);
        expect(tinker?.subclasses.map((s) => [s.name, s.features.map((f) => [f.name, f.level])])).toEqual([
            [
                "Clockwork Path",
                [
                    ["Gears", 3],
                    ["Escapement", 5],
                ],
            ],
        ]);
    });

    it("reads a species, a background and feats by their fields and lead lines", () => {
        expect(readings.species).toHaveLength(1);
        expect(readings.species[0]).toMatchObject({
            name: "Gearling",
            creatureType: "construct",
            sizes: ["sm", "med"],
            walk: 30,
            darkvision: null,
        });
        expect(readings.backgrounds[0]).toMatchObject({
            name: "Tinkerer",
            abilities: ["dex", "con", "int"],
            feat: "Quick Study",
            skills: { grants: ["skills:arc", "skills:inv"], choices: [] },
        });
        expect(readings.feats.map((f) => [f.name, f.subtype, f.level, f.repeatable])).toEqual([
            ["Quick Study", "origin", null, false],
            ["Tough Hide", "general", 4, true],
        ]);
    });
});

const advancements = (doc: JsonObject): JsonObject[] =>
    ((doc["system"] as JsonObject)["advancement"] as JsonValue[]).map((a) => a as JsonObject);

describe("dnd5e documents", () => {
    const ir = newerRules();
    const target = DND5E_TARGETS["2024"];
    const entities = buildDocuments(
        readCharacterOptions(readLayout(ir)),
        target,
        "tinker-compendium",
        "Tinker Compendium",
        inferPageNumbering(ir),
    );
    const named = (name: string, type: string): JsonObject => {
        const entity = entities.find((e) => e.fields["name"] === name && e.fields["type"] === type);
        if (entity === undefined) {
            throw new Error(`no ${type} ${name}`);
        }
        return entity.fields;
    };

    it("writes a class in the system's data model, marked with the chosen ruleset", () => {
        const tinker = named("Tinker", "class");
        const system = tinker["system"] as JsonObject;
        expect(system["hd"]).toEqual({ denomination: "d8", additional: "", spent: 0 });
        expect(system["identifier"]).toBe("tinker");
        expect((system["source"] as JsonObject)["rules"]).toBe("2024");
        expect(advancements(tinker).map((a) => [a["type"], a["level"] ?? null, a["title"]])).toEqual([
            ["HitPoints", null, ""],
            ["Trait", 1, "Saving Throw Proficiencies"],
            ["Trait", 1, "Armor Proficiencies"],
            ["Trait", 1, "Weapon Proficiencies"],
            ["Trait", 1, "Skill Proficiencies"],
            ["ItemGrant", 1, "Features"],
            ["ItemGrant", 2, "Features"],
            ["ItemGrant", 5, "Features"],
            ["AbilityScoreImprovement", 4, ""],
            ["ScaleValue", null, "Charges"],
            ["ScaleValue", null, "Dice"],
            ["Subclass", 3, ""],
        ]);
        const ids = advancements(tinker).map((a) => a["_id"]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("grants a background's feat and limits its ability scores to those it lists", () => {
        const tinkerer = named("Tinkerer", "background");
        const [asi, , feat] = advancements(tinkerer);
        expect(asi?.["configuration"]).toMatchObject({ points: 3, cap: 2, locked: ["str", "wis", "cha"] });
        expect(feat?.["type"]).toBe("ItemGrant");
        expect(JSON.stringify(feat)).toContain("{{ref:dnd5e:feat:");
    });

    it("grants a species trait at the character level it names", () => {
        const gearling = named("Gearling", "race");
        expect(advancements(gearling).map((a) => [a["type"], a["level"]])).toEqual([
            ["Size", 0],
            ["ItemGrant", 0],
            ["ItemGrant", 5],
        ]);
        expect((gearling["system"] as JsonObject)["movement"]).toEqual({ walk: 30, units: "ft" });
    });

    it("resolves grants to compendium UUIDs that packaging points into the module", () => {
        const result = inferDnd5e(ir, createLogger("error"), target);
        const emitted = emit(result.graph, new Map(), { assetRefPrefix: MODULE_ASSET_PLACEHOLDER });
        const packs = [...emitted.packs.values()];
        expect(emitted.warnings).toEqual([]);
        const built = buildModule({
            system: "dnd5e",
            targets: ["dnd5e-2024"],
            packs: packs.map((p) => ({
                name: p.pack,
                label: p.pack,
                documentType: p.documentType,
                documents: p.documents,
            })),
            assets: [],
            sources: [result.book],
            provenance: { release: "2000-01-02-03-04", target: "dnd5e-2024" },
        });
        const manifest = JSON.parse(
            String(built.files.find((f) => f.relPath.endsWith("module.json"))?.contents),
        ) as JsonObject;
        expect(manifest["relationships"]).toEqual({ systems: [{ id: "dnd5e", type: "system" }] });
        expect(manifest["compatibility"]).toEqual({ minimum: "14", verified: "14" });
        const classPack = built.files.find((f) => f.relPath.endsWith("-classes.db"));
        const tinker = JSON.parse(String(classPack?.contents).split("\n")[0] ?? "") as JsonObject;
        const grants = advancements(tinker).filter((a) => a["type"] === "ItemGrant");
        const uuid = String(
            ((grants[0]?.["configuration"] as JsonObject)["items"] as JsonObject[])[0]?.["uuid"],
        );
        expect(uuid).toMatch(
            new RegExp(
                `^Compendium\\.${built.id}\\.dnd5e-2024-tinker-compendium-class-features\\.Item\\.\\w{16}$`,
                "u",
            ),
        );
        const featurePack = built.files.find((f) => f.relPath.endsWith("-class-features.db"));
        expect(String(featurePack?.contents)).toContain(`"_id":"${uuid.split(".").at(-1) ?? ""}"`);
    });
});
