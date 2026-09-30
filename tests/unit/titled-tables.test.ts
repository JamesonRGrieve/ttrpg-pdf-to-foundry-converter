// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    centredInColumn,
    cutAtEdges,
    detectTitledTables,
    splitHeaderRuns,
} from "../../src/infer/detect-titled-tables.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

function run(text: string, x: number, y: number, opts: Partial<IRTextRun> = {}): IRTextRun {
    return {
        pageIndex: 0,
        band: 0,
        x,
        y,
        width: 5.5 * text.length,
        height: 9,
        text,
        font: "body",
        weight: "normal",
        italic: false,
        size: 10,
        sizeBucket: 0,
        column: 0,
        indent: 0,
        renderOrder: 0,
        ...opts,
    };
}

function irOf(runs: IRTextRun[]): IR {
    return {
        irVersion: 0,
        pages: [{ pageIndex: 0, width: 600, height: 800, rotation: 0, columns: 1 }],
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
    };
}

const bold = { weight: "bold" as const, font: "head" };

describe("centred cells", () => {
    it("places a cell centred under its label in that label's column, not the one it starts in", () => {
        const edges = [53, 153, 201, 244];
        // Starts mid-way through the name column, lies mostly under the class label.
        expect(centredInColumn({ ...run("Melee, Thrown", 137, 578), width: 52 }, edges).x).toBe(153);
        // A cell set at its own column's edge stays, however far it runs on.
        expect(centredInColumn({ ...run("Basic 90m", 154, 578), width: 60 }, edges).x).toBe(154);
        // Mostly in the column it starts in: stays.
        expect(centredInColumn({ ...run("Lantern", 120, 578), width: 40 }, edges).x).toBe(120);
    });
});

describe("cells in one run", () => {
    it("cuts a run spanning column edges at the word break nearest each edge", () => {
        // Cells written as one run, the wide gap between cells as one space:
        // an even spread of letters would put "2d6" left of its column edge.
        const pieces = cutAtEdges({ ...run("S/-/- 2d6 X", 224, 133), width: 59 }, [64, 224, 260]);
        expect(pieces.map((p) => [p.text, p.x >= 260])).toEqual([
            ["S/-/-", false],
            ["2d6 X", true],
        ]);
    });
});

describe("titled tables", () => {
    it("reads a two-line name whose values sit between its lines, past a superscript marker", () => {
        const ir = irOf([
            run("Table 1-1: Lamps", 60, 700, bold),
            run("NAME", 60, 680, bold),
            run("CLASS", 200, 680, bold),
            run("DAM", 300, 680, bold),
            run("Rushlight", 60, 660),
            run("Basic", 200, 660),
            run("1d10 E", 300, 660),
            // "Tinder / Crossbow†" wraps; its values are centred between the lines.
            run("Tinder", 60, 640),
            run("Heavy", 200, 634.5),
            run("2d10 I", 300, 634.5),
            run("†", 108, 632, { size: 5.75 }),
            run("Crossbow", 60, 629),
            run("Glim", 60, 609),
            run("Pistol", 200, 609),
            run("1d5 E", 300, 609),
        ]);
        const [table] = detectTitledTables(ir);
        const names = table?.rows.map((r) => r.cells.find((c) => c.colIndex === 0)?.text);
        expect(names).toEqual(["Rushlight", "Tinder Crossbow", "Glim"]);
    });

    it("finds a caption set in a display face, not one in the body face, and leaves side-margin tabs out", () => {
        const prose = Array.from({ length: 6 }, (_, i) =>
            run("plain running words of the text", 60, 400 - 12 * i),
        );
        const ir = irOf([
            ...prose,
            run("Table 1-3: Lanterns", 60, 700, { font: "display" }),
            run("NAME", 60, 680, bold),
            run("CLASS", 200, 680, bold),
            run("DAM", 300, 680, bold),
            run("Rushlight", 60, 660),
            run("Basic", 200, 660),
            run("1d10 E", 300, 660),
            run("TAB", 570, 660, { width: 20 }),
            run("Glim", 60, 640),
            run("Pistol", 200, 640),
            run("1d5 E", 300, 640),
            run("Table 1-4: Wicks", 60, 300),
        ]);
        const tables = detectTitledTables(ir);
        expect(tables.map((t) => t.tableTitle)).toEqual(["Lanterns"]);
        expect(tables[0]?.rows[0]?.cells.find((c) => c.colIndex === 2)?.text).toBe("1d10 E");
    });

    it("finds a caption set in several runs, its number in a larger size", () => {
        const ir = irOf([
            run("Table", 60, 700, { ...bold, width: 30 }),
            run("", 90, 700, { ...bold, width: 0.2 }),
            run("6-1:", 93, 700, { ...bold, size: 16, width: 20 }),
            run("Ranged", 116, 700, { ...bold, width: 38 }),
            run("Lamps", 157, 700, { ...bold, width: 30 }),
            run("NAME", 60, 680, bold),
            run("CLASS", 200, 680, bold),
            run("DAM", 300, 680, bold),
            run("Rushlight", 60, 660),
            run("Basic", 200, 660),
            run("1d10 E", 300, 660),
            run("Glim", 60, 640),
            run("Pistol", 200, 640),
            run("1d5 E", 300, 640),
            run("Wick", 60, 620),
            run("Basic", 200, 620),
            run("2d5 E", 300, 620),
            run("Ember", 60, 600),
            run("Heavy", 200, 600),
            run("1d10 X", 300, 600),
        ]);
        expect(detectTitledTables(ir).map((t) => [t.tableTitle, t.rows.length])).toEqual([
            ["Ranged Lamps", 4],
        ]);
    });

    it("splits header labels set closer than a word space where the rows start their cells", () => {
        const ir = irOf([
            run("Table 1-5: Wick Mishaps", 60, 700, bold),
            run("ROLL D10", 60, 680, { ...bold, width: 44 }),
            run("EFFECT", 106, 680, { ...bold, width: 33 }),
            run("1-3", 60, 660),
            run("The wick smokes and the lamp dims.", 106, 660),
            run("4-7", 60, 640),
            run("The flame gutters out.", 106, 640),
            run("8-9", 60, 620),
            run("The oil catches alight.", 106, 620),
            run("10", 60, 600),
            run("The lamp shatters.", 106, 600),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["ROLL D10", "EFFECT"]);
        expect(table?.rows.map((r) => r.cells.find((c) => c.colIndex === 0)?.text)).toEqual([
            "1-3",
            "4-7",
            "8-9",
            "10",
        ]);
    });

    it("keeps a key centred under its label that starts left of the label", () => {
        const ir = irOf([
            run("Table 1-6: Omens", 60, 700, bold),
            run("ROLL", 70, 680, bold),
            run("OMEN", 120, 680, bold),
            run("01", 74, 660),
            run("The lamp gutters.", 120, 660),
            run("02-07", 62, 640),
            run("The wick smokes.", 120, 640),
            run("08-10", 64, 620),
            run("The oil catches.", 120, 620),
            run("11", 74, 600),
            run("The lamp shatters.", 120, 600),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.rows.map((r) => r.cells.find((c) => c.colIndex === 0)?.text)).toEqual([
            "01",
            "02-07",
            "08-10",
            "11",
        ]);
    });

    it("completes a header label that wraps onto a second line", () => {
        const ir = irOf([
            run("Table 1-7: Lamp Origins", 60, 700, bold),
            run("ROLL", 64, 686, { ...bold, width: 22 }),
            run("RESULT", 120, 686, bold),
            run("(D10)", 60, 673, { ...bold, width: 28 }),
            run("1-4", 60, 658, bold),
            run("Marsh Lamp:", 120, 658, { ...bold, width: 66 }),
            run("A lamp of the reeds.", 190, 658),
            run("5-7", 60, 640, bold),
            run("Hill Lamp:", 120, 640, { ...bold, width: 66 }),
            run("A lamp of the heights.", 190, 640),
            run("8-10", 60, 622, bold),
            run("Sea Lamp:", 120, 622, { ...bold, width: 66 }),
            run("A lamp of the tides.", 190, 622),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["ROLL (D10)", "RESULT"]);
        expect(table?.rows.map((r) => r.cells.find((c) => c.colIndex === 0)?.text)).toEqual([
            "1-4",
            "5-7",
            "8-10",
        ]);
    });

    it("keeps a section row under the header a section row, however close, when its like recurs", () => {
        const ir = irOf([
            run("Table 1-10: Lodgings", 60, 706, bold),
            run("TYPE", 60, 686, { ...bold, width: 22 }),
            run("COST", 200, 686, bold),
            run("Inns", 60, 672, bold),
            run("Low Grade", 60, 660),
            run("5", 200, 660),
            run("High Grade", 60, 650),
            run("40", 200, 650),
            run("Barges", 60, 636, bold),
            run("Low Grade", 60, 624),
            run("3", 200, 624),
            run("High Grade", 60, 614),
            run("30", 200, 614),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["TYPE", "COST"]);
    });

    it("reads on into a sub-table with its own header after a note line", () => {
        const ir = irOf([
            run("Table 1-8: Lamps", 60, 706, bold),
            run("NAME", 60, 686, bold),
            run("CLASS", 200, 686, bold),
            run("DAM", 300, 686, bold),
            run("Rushlight", 60, 672),
            run("Basic", 200, 672),
            run("1d10 E", 300, 672),
            run("Glim", 60, 662),
            run("Pistol", 200, 662),
            run("1d5 E", 300, 662),
            run("* Damage depends on the oil the lamp is filled with at the time.", 60, 652),
            run("Wicks", 60, 634, bold),
            run("NAME", 60, 624, bold),
            run("RANGE", 250, 624, bold),
            run("Tallow", 60, 610),
            run("5m", 250, 610),
            run("Beeswax", 60, 600),
            run("8m", 250, 600),
            run("Rush", 60, 590),
            run("3m", 250, 590),
            run("Oil", 60, 580),
            run("10m", 250, 580),
            // A section row and a header of other columns, straight on.
            run("Shades", 60, 566, bold),
            run("NAME", 60, 556, bold),
            run("COLOUR", 150, 556, bold),
            run("WT", 250, 556, bold),
            run("Smoked", 60, 546),
            run("Grey", 150, 546),
            run("1kg", 250, 546),
            run("Frosted", 60, 536),
            run("White", 150, 536),
            run("1kg", 250, 536),
            run("Stained", 60, 526),
            run("Red", 150, 526),
            run("2kg", 250, 526),
        ]);
        const tables = detectTitledTables(ir);
        expect(tables.map((t) => t.headers)).toEqual([
            ["NAME", "CLASS", "DAM"],
            ["NAME", "RANGE"],
            ["NAME", "COLOUR", "WT"],
        ]);
        expect(tables[1]?.rows.filter((r) => !r.isSectionHeader).map((r) => r.cells[0]?.text)).toEqual([
            "Tallow",
            "Beeswax",
            "Rush",
            "Oil",
        ]);
        expect(tables.map((t) => t.tableTitle)).toEqual(["Lamps", "Lamps", "Lamps"]);
    });

    it("leaves out prose set beside the table on the same baselines", () => {
        const ir = irOf([
            run("Table 1-9: Lamp Kit", 60, 706, bold),
            run("NAME", 60, 686, bold),
            run("WT", 150, 686, bold),
            run("COST", 200, 686, bold),
            run("Wick", 60, 672),
            run("-", 150, 672),
            run("5", 200, 672),
            run("A wick is trimmed at dawn.", 330, 672),
            run("Oil Flask", 60, 658),
            run("1kg", 150, 658),
            run("20", 200, 658),
            run("Oil keeps the lamp alight.", 330, 658),
            run("Shade", 60, 644),
            run("0.5kg", 150, 644),
            run("15", 200, 644),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
            ["Wick", "-", "5"],
            ["Oil Flask", "1kg", "20"],
            ["Shade", "0.5kg", "15"],
        ]);
    });

    it("keeps a full-size marker that is a cell's own value", () => {
        const ir = irOf([
            run("Table 1-2: Launchers", 60, 700, bold),
            run("NAME", 60, 680, bold),
            run("CLASS", 200, 680, bold),
            run("DAM", 300, 680, bold),
            run("Tube", 60, 660),
            run("Basic", 200, 660),
            run("†", 300, 660),
            run("Glim", 60, 640),
            run("Pistol", 200, 640),
            run("1d5 E", 300, 640),
            run("Lamp", 60, 620),
            run("Pistol", 200, 620),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.rows[0]?.cells.find((c) => c.colIndex === 2)?.text).toBe("†");
    });
});

describe("header runs holding two labels", () => {
    // "Clip Rld" set as one run 40pt wide from x=300: "Rld" starts near x=325.
    const merged = run("Clip Rld", 300, 700, { width: 40, weight: "bold" });

    it("splits where records start a column at the run's edge and inside it", () => {
        expect(splitHeaderRuns([merged], [300, 325]).map((r) => [r.text, r.x])).toEqual([
            ["Clip", 300],
            ["Rld", 325],
        ]);
    });

    it("keeps whole a label over centred values, one naming a single field, or pieces naming no field", () => {
        // Values centred under the label start only inside it.
        expect(splitHeaderRuns([merged], [325])).toEqual([merged]);
        // One field's label ("Armour Type" names the name column).
        const single = run("Armour Type", 300, 700, { width: 55, weight: "bold" });
        expect(splitHeaderRuns([single], [300, 335])).toEqual([single]);
        // Pieces that are no schema labels.
        const prose = run("Lamp Oil", 300, 700, { width: 40, weight: "bold" });
        expect(splitHeaderRuns([prose], [300, 325])).toEqual([prose]);
    });
});
