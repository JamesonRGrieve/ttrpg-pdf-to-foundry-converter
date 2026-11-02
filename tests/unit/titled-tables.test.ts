// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    centredInColumn,
    cutAtEdges,
    detectTitledTables,
    splitHeaderRuns,
    withRepeatedHeaders,
} from "../../src/infer/detect-titled-tables.ts";
import type { TableRow } from "../../src/infer/types.ts";
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
        pages: [
            {
                pageIndex: 0,
                width: 600,
                height: 800,
                rotation: 0,
                columns: 1,
                edgeText: [],
                hasTextLayer: true,
            },
        ],
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
    it("reads rows set across the page under a header set in one text column", () => {
        const across = { column: 2 };
        const row = (y: number, key: string, name: string, text: string): IRTextRun[] => [
            run(key, 48, y, across),
            run(name, 101, y, across),
            run(text, 167, y, across),
        ];
        const ir = irOf([
            run("Table 2-1: Lamps", 46, 416, { ...bold, column: 0 }),
            run("Roll", 48, 389, { ...bold, column: 0 }),
            run("Lamp", 101, 389, { ...bold, column: 0 }),
            run("Description", 167, 389, { ...bold, column: 0 }),
            // The neighbouring column's prose ends above the table.
            run("Prose of the right-hand column.", 285, 430, { column: 1 }),
            ...row(372, "1", "Rushlight", "A reed dipped in fat."),
            ...row(343, "2", "Glim", "A small, steady flame."),
            ...row(309, "3", "Hush Lamp", "Burns without a sound."),
            ...row(280, "4", "Wick Lantern", "Shuttered, for the road."),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["Roll", "Lamp", "Description"]);
        expect(table?.rows.map((r) => r.cells.find((c) => c.colIndex === 1)?.text)).toEqual([
            "Rushlight",
            "Glim",
            "Hush Lamp",
            "Wick Lantern",
        ]);
    });

    it("reads a section row set above the header as the first part's section", () => {
        const table = (lead: IRTextRun[]): string[] => {
            const ir = irOf([
                run("Table 1-1: Lamps", 60, 720, bold),
                ...lead,
                run("Name", 60, 690, bold),
                run("Class", 200, 690, bold),
                run("Range", 300, 690, bold),
                run("Rushlight", 60, 675),
                run("Basic", 200, 675),
                run("30m", 300, 675),
                run("Glim", 60, 660),
                run("Pistol", 200, 660),
                run("10m", 300, 660),
                run("Wick Lamps", 60, 645, bold),
                run("Hush Lamp", 60, 630),
                run("Basic", 200, 630),
                run("20m", 300, 630),
            ]);
            return (detectTitledTables(ir)[0]?.rows ?? []).map((r) =>
                r.isSectionHeader ? `§${r.sectionName ?? ""}` : (r.cells[0]?.text ?? ""),
            );
        };
        expect(table([run("Reed Lamps", 60, 704, bold)])).toEqual([
            "§Reed Lamps",
            "Rushlight",
            "Glim",
            "§Wick Lamps",
            "Hush Lamp",
        ]);
        // Set apart from the header's first column, or naming a column, it is no section.
        expect(table([run("Reed Lamps", 140, 704, bold)])[0]).toBe("Rushlight");
        expect(table([run("Range", 60, 704, bold)])[0]).toBe("Rushlight");
    });

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

    it("finds a caption set larger than the body on a page read from its image, where all is one face", () => {
        const scanned = (runs: IRTextRun[]): IR => {
            const ir = irOf(runs);
            return { ...ir, pages: ir.pages.map((page) => ({ ...page, hasTextLayer: false })) };
        };
        const ocr = { font: "ocr" };
        const prose = Array.from({ length: 6 }, (_, i) =>
            run("plain running words of the text", 60, 400 - 12 * i, ocr),
        );
        const rows = [
            run("NAME", 60, 680, { ...ocr, weight: "bold" }),
            run("CLASS", 200, 680, { ...ocr, weight: "bold" }),
            run("DAM", 300, 680, { ...ocr, weight: "bold" }),
            run("Rushlight", 60, 660, ocr),
            run("Basic", 200, 660, ocr),
            run("1d10 E", 300, 660, ocr),
            run("Glim", 60, 640, ocr),
            run("Pistol", 200, 640, ocr),
            run("1d5 E", 300, 640, ocr),
        ];
        const larger = scanned([...prose, run("Table 1-5: Lamps", 60, 700, { ...ocr, size: 13 }), ...rows]);
        expect(detectTitledTables(larger).map((t) => t.tableTitle)).toEqual(["Lamps"]);
        // At the body's size it reads as running text, as on a page with a text layer.
        const level = scanned([...prose, run("Table 1-5: Lamps", 60, 700, ocr), ...rows]);
        expect(detectTitledTables(level).map((t) => t.tableTitle)).not.toContain("Lamps");
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

    it("reads a header set in the body weight when its labels name the schema's fields", () => {
        const plain = { size: 9, font: "body" };
        const ir = irOf([
            run("Table 1-5: Odd Lanterns", 60, 720, { font: "display" }),
            run("Name", 60, 700, plain),
            run("Class", 200, 700, plain),
            run("Range", 260, 700, plain),
            run("Dam", 320, 700, plain),
            run("Pen", 380, 700, plain),
            run("Rushlight Projector", 60, 685, plain),
            run("Pistol", 200, 685, plain),
            run("4m", 260, 685, plain),
            run("1d10 E", 320, 685, plain),
            run("3", 380, 685, plain),
            run("Glim Beamer", 60, 672, plain),
            run("Heavy", 200, 672, plain),
            run("100m", 260, 672, plain),
            run("2d10 E", 320, 672, plain),
            run("5", 380, 672, plain),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["Name", "Class", "Range", "Dam", "Pen"]);
        expect(table?.rows.map((r) => r.cells[0]?.text)).toEqual(["Rushlight Projector", "Glim Beamer"]);
        // A plain line naming too few fields is a record, not a header.
        const records = irOf([
            run("Table 1-6: Wicks", 60, 720, { font: "display" }),
            run("Wick", 60, 700, plain),
            run("Pistol", 200, 700, plain),
            run("Glim", 60, 685, plain),
            run("Basic", 200, 685, plain),
        ]);
        expect(detectTitledTables(records)).toEqual([]);
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

    it("prefixes a label's first words printed on a line of their own above the header", () => {
        const ir = irOf([
            run("Table 1-8: Lamp Fittings", 60, 712, bold),
            run("Weight per", 140, 698, bold),
            run("Name", 60, 686, bold),
            run("wick", 140, 686, bold),
            run("Fits", 200, 686, bold),
            run("Glass Hood", 60, 670),
            run("+2 kg", 140, 670),
            run("Any", 200, 670),
            run("Brass Hood", 60, 656),
            run("+1 kg", 140, 656),
            run("Marsh lamps", 200, 656),
            run("Tin Hood", 60, 642),
            run("+1 kg", 140, 642),
            run("Any", 200, 642),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["Name", "Weight per wick", "Fits"]);
        expect(table?.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
            ["Glass Hood", "+2 kg", "Any"],
            ["Brass Hood", "+1 kg", "Marsh lamps"],
            ["Tin Hood", "+1 kg", "Any"],
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

    it("takes no display heading sharing a baseline with another heading for a header", () => {
        // A caption whose own rows print no header; further down, a display
        // heading and the next entry's heading in the other column share a
        // baseline. They are two headings, not a table's column labels.
        const field = (label: string, value: string, x: number, y: number): IRTextRun[] => [
            run(label, x, y, bold),
            run(value, x + 70, y),
        ];
        const ir = irOf([
            run("Table 7-1: Lantern Omens", 60, 740, bold),
            run("A gutter of the wick bodes well for the road ahead.", 60, 720),
            run("WICKCRAFT", 60, 487, { ...bold, size: 18 }),
            run("GLIM", 300, 483, { ...bold, size: 11.25 }),
            run("SHIELD", 330, 483, { ...bold, size: 11.25 }),
            ...field("Value:", "300xp", 300, 471),
            ...field("Action:", "Half Action", 300, 459),
            ...field("Range:", "10m", 300, 447),
            run("The lamp-wright bends flame to the will.", 60, 470),
            run("Each glim answers to its keeper alone.", 60, 458),
        ]);
        expect(detectTitledTables(ir).flatMap((t) => t.headers)).not.toContain("WICKCRAFT");
    });

    it("leaves the next column's field lines out of a table whose header shares their baseline", () => {
        // The other column prints an entry's `Label: value` lines in the
        // header's face; one sits on the header's baseline. It is no label of
        // the table, so that column (and the next entry's heading in it) stays out.
        const left = { column: 0 };
        const right = { column: 1 };
        const field = (label: string, value: string, y: number): IRTextRun[] => [
            run(label, 60, y, { ...bold, ...left }),
            run(value, 130, y, left),
        ];
        const ir = irOf([
            run("Table 6-5: Wick Readings", 330, 729, { ...bold, ...right }),
            run("Degrees", 335, 714, { ...bold, ...right }),
            run("of Success", 335, 702, { ...bold, ...right }),
            run("Reading", 400, 702, { ...bold, ...right }),
            ...field("Value:", "100xp", 699),
            run("1", 335, 688, right),
            run("Dim: the flame gutters.", 400, 688, right),
            ...field("Action:", "Half Action", 687),
            run("2", 335, 674, right),
            run("Bright: the flame holds.", 400, 674, right),
            ...field("Range:", "5m", 675),
            run("3", 335, 660, right),
            run("Blaze: the flame leaps.", 400, 660, right),
            run("4", 335, 646, right),
            run("Pyre: the flame consumes.", 400, 646, right),
            run("GLIM", 60, 600, { ...bold, ...left, size: 11.25 }),
            run("SHIELD", 100, 600, { ...bold, ...left, size: 11.25 }),
            ...field("Value:", "200xp", 588),
            ...field("Action:", "Free Action", 576),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.headers).toEqual(["of Success", "Reading"]);
        const cells = table?.rows.flatMap((r) => r.cells.map((c) => c.text)) ?? [];
        expect(cells).toEqual(expect.arrayContaining(["1", "2", "3", "4", "Pyre: the flame consumes."]));
        expect(cells.filter((c) => /Value|Action|Range|GLIM/u.test(c))).toEqual([]);
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

describe("tables with no caption", () => {
    /** A record line: a name and three values under the header's columns. */
    const record = (y: number, name: string): IRTextRun[] => [
        run(name, 60, y),
        run("3+StrB", 200, y),
        run("600", 300, y),
        run("Rare", 400, y),
    ];

    it("reads a table from a header of schema field labels, with centred section rows", () => {
        const ir = irOf([
            // "Name" set as a small-capital initial and the rest of the word.
            run("N", 60, 700, { ...bold, width: 7 }),
            run("ame", 67, 700, { ...bold, width: 16 }),
            run("Dam", 200, 700, bold),
            run("Cost", 300, 700, bold),
            run("Avail", 400, 700, bold),
            // A section label centred across the columns, set apart below the header.
            run("Lamp", 190, 675, bold),
            run("Hooks", 290, 675, bold),
            ...record(660, "Wick Hook"),
            ...record(645, "Ember Hook"),
            ...record(630, "Glim Hook"),
        ]);
        const [table] = detectTitledTables(ir);
        expect(table?.tableTitle).toBeNull();
        expect(table?.headers).toEqual(["Name", "Dam", "Cost", "Avail"]);
        const read = table?.rows.map((r) => (r.isSectionHeader ? `[${r.sectionName}]` : r.cells[0]?.text));
        expect(read).toEqual(["[Lamp Hooks]", "Wick Hook", "Ember Hook", "Glim Hook"]);
    });

    it("finds no table under a bold line that names too few fields", () => {
        const ir = irOf([
            run("Lamp", 60, 700, bold),
            run("Oil", 200, 700, bold),
            run("Dam", 300, 700, bold),
            ...record(670, "Wick Hook"),
            ...record(655, "Ember Hook"),
        ]);
        expect(detectTitledTables(ir)).toEqual([]);
    });
});

describe("withRepeatedHeaders", () => {
    const row = (...texts: string[]): TableRow => ({
        cells: texts.map((text, colIndex) => ({ colIndex, text, isHeader: false })),
        isHeaderRow: false,
        isSectionHeader: false,
        sectionName: null,
    });
    const headers = ["Name", "Locations Covered", "AP"];

    it("reads a repeat of the header as one, and words before its first label as a section", () => {
        const rows = withRepeatedHeaders(
            [
                row("Glow Hood", "Head", "2"),
                row("Name", "Locations Covered", "AP"),
                row("Ember Plate Name", "Locations Covered", "AP"),
                row("Ember Vest", "Body", "4"),
            ],
            headers,
        );
        expect(rows.map((r) => [r.isHeaderRow, r.isSectionHeader, r.sectionName])).toEqual([
            [false, false, null],
            [true, false, null],
            [false, true, "Ember Plate"],
            [true, false, null],
            [false, false, null],
        ]);
    });

    it("keeps a record whose other cells are not the header's labels", () => {
        const rows = withRepeatedHeaders([row("Lamp Name", "Head", "2")], headers);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.isHeaderRow).toBe(false);
    });
});
