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
});
