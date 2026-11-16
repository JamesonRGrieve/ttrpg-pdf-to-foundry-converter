// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { detectTables } from "../../src/infer/detect-tables.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

function run(text: string, x: number, y: number, width: number, opts: Partial<IRTextRun> = {}): IRTextRun {
    return {
        pageIndex: 0,
        band: 0,
        x,
        y,
        width,
        height: 9,
        text,
        font: "body",
        weight: "normal",
        italic: false,
        size: 9,
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

describe("detectTables", () => {
    it("keeps the word spaces of a cell the text layer split into pieces", () => {
        const bold = { weight: "bold" as const };
        const rows = [
            [run("Name", 50, 700, 24, bold), run("Class", 150, 700, 24, bold), run("Wt", 250, 700, 12, bold)],
            // Words a space apart; an empty space run between them, as a text layer leaves it.
            [
                run("Glow", 50, 688, 20),
                run("", 70, 688, 0.3),
                run("Lamp", 72.4, 688, 22),
                run("Basic", 150, 688, 22),
                run("2kg", 250, 688, 14),
            ],
            // A small-capitals piece with no gap belongs to its word.
            [
                run("W", 50, 676, 8),
                run("ick", 58.1, 676, 14),
                run("Pistol", 150, 676, 24),
                run("1kg", 250, 676, 14),
            ],
            [run("Ember", 50, 664, 26), run("Basic", 150, 664, 22), run("3kg", 250, 664, 14)],
        ].flat();
        const [table] = detectTables(irOf(rows));
        expect(table?.rows.map((r) => r.cells[0]?.text)).toEqual(["Glow Lamp", "Wick", "Ember"]);
    });

    it("finds a table's columns beside a column of prose, and joins a cell's wrapped lines to their row", () => {
        const bold = { weight: "bold" as const };
        const lines: IRTextRun[] = [];
        // Prose set one line at a time above the table outnumbers its rows.
        for (let k = 0; k < 30; k++) {
            lines.push(run(`Lamp lore line ${k} runs on and on`, 50, 760 - k * 4, 200));
        }
        lines.push(
            run("Wick", 50, 600, 30, bold),
            run("Cost", 150, 600, 30, bold),
            run("Type", 250, 600, 30, bold),
            run("Needs", 350, 600, 40, bold),
        );
        const rows: [string, string, string, string][] = [
            ["Trimming", "100", "Skill", "-"],
            ["Snuffing", "200", "Talent", "Ag 30"],
            ["Glowing", "300", "Talent", "-"],
            ["Shading", "400", "Talent", "-"],
            ["Dimming", "500", "Talent", "-"],
            ["Kindling", "600", "Talent", "-"],
        ];
        rows.forEach(([a, b, c, d], k) => {
            const y = 585 - k * 15;
            lines.push(run(a, 50, y, 40), run(b, 150, y, 20), run(c, 250, y, 30), run(d, 350, y, 30));
        });
        // A row set beside both lines of its wrapped cell, and one whose cell wraps below it.
        lines.push(
            run("Ag 40, Lamp", 350, 499, 50),
            run("Warding", 50, 494, 40),
            run("700", 150, 494, 20),
            run("Talent", 250, 494, 30),
            run("(Oil)", 350, 489, 30),
        );
        lines.push(
            run("Last Light", 50, 479, 40),
            run("800", 150, 479, 20),
            run("Talent", 250, 479, 30),
            run("Ag 50, Lamp", 350, 479, 50),
        );
        lines.push(run("(Wick)", 350, 470, 30));
        const tables = detectTables(irOf(lines));
        const found = tables.find((t) => t.headers.join("|") === "Wick|Cost|Type|Needs");
        const texts = found?.rows.map((r) => r.cells.map((c) => c.text));
        expect(texts?.find((r) => r[0] === "Warding")).toEqual([
            "Warding",
            "700",
            "Talent",
            "Ag 40, Lamp (Oil)",
        ]);
        expect(texts?.find((r) => r[0] === "Last Light")).toEqual([
            "Last Light",
            "800",
            "Talent",
            "Ag 50, Lamp (Wick)",
        ]);
    });

    it("joins a row the layout splits over lines set closer than its rows", () => {
        const bold = { weight: "bold" as const };
        const lines: IRTextRun[] = [
            run("Wick", 50, 700, 30, bold),
            run("Cost", 150, 700, 30, bold),
            run("Type", 250, 700, 30, bold),
            run("Needs", 350, 700, 40, bold),
        ];
        const entries: [string, string, string, string, string, string][] = [
            ["Lamp Lore (Old", "Ways) +10", "400", "Skill", "Lamp Lore (Old", "Ways)"],
            ["Lamp Lore (Tides)", "+20", "800", "Skill", "Lamp Lore (Tides)", "+10"],
            ["Lamp Lore (Reeds)", "+20", "400", "Skill", "Lamp Lore (Reeds)", "+10"],
        ];
        entries.forEach(([name1, name2, cost, type, need1, need2], k) => {
            const y = 685 - k * 23;
            lines.push(run(name1, 50, y, 60), run(need1, 350, y, 60));
            lines.push(run(cost, 150, y - 5.4, 20), run(type, 250, y - 5.4, 30));
            lines.push(run(name2, 50, y - 10.8, 30), run(need2, 350, y - 10.8, 30));
        });
        const found = detectTables(irOf(lines)).find((t) => t.headers.join("|") === "Wick|Cost|Type|Needs");
        expect(found?.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
            ["Lamp Lore (Old Ways) +10", "400", "Skill", "Lamp Lore (Old Ways)"],
            ["Lamp Lore (Tides) +20", "800", "Skill", "Lamp Lore (Tides) +10"],
            ["Lamp Lore (Reeds) +20", "400", "Skill", "Lamp Lore (Reeds) +10"],
        ]);
    });
});
