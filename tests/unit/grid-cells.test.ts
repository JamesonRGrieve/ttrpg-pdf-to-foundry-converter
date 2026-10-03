// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { gridCellsToRead } from "../../src/ocr/grid-cells.ts";
import { cellPage, withCellReads } from "../../src/ocr/recognize.ts";
import type { OcrWord } from "../../src/ocr/types.ts";

const word = (text: string, x: number, y: number, h = 10): OcrWord => ({
    text,
    confidence: 90,
    box: [x, y, x + 12, y + h],
    line: 0,
    baseline: y,
    lineHeight: h,
    stroke: 1,
});

/** A 3×3 grid of values at columns 100/130/160 and rows 300/275/250, minus the given cells. */
function grid(missing: readonly string[], replace: Record<string, string> = {}): OcrWord[] {
    const out: OcrWord[] = [];
    [300, 275, 250].forEach((y, r) => {
        [100, 130, 160].forEach((x, c) => {
            const key = `${r}${c}`;
            if (!missing.includes(key)) {
                out.push(word(replace[key] ?? String(30 + r * 3 + c), x, y));
            }
        });
    });
    return out;
}

describe("gridCellsToRead", () => {
    it("places the cells a partly read grid misses from its rows and columns", () => {
        const cells = gridCellsToRead(grid(["01", "22"]));
        expect(cells.map((c) => c.box.map(Math.round))).toEqual([
            [130, 300, 142, 310],
            [160, 250, 172, 260],
        ]);
        expect(cells.every((c) => c.misread === null)).toBe(true);
    });

    it("reads again a cell holding a value no two-digit grid holds, and leaves a dash", () => {
        const cells = gridCellsToRead(grid([], { "12": "128", "20": "—" }));
        expect(cells).toHaveLength(1);
        expect(cells[0]?.misread?.text).toBe("128");
    });

    it("finds the grid's lattice past stray numbers set beside it", () => {
        const cells = gridCellsToRead([...grid(["11"]), word("16", 190, 330), word("9", 70, 262)]);
        expect(cells.map((c) => c.box.map(Math.round))).toEqual([[130, 275, 142, 285]]);
    });

    it("completes nothing from too few cells, nor from numbers in no grid", () => {
        expect(gridCellsToRead(grid(["00", "01", "02", "10", "11"]))).toEqual([]);
        expect(gridCellsToRead([word("12", 100, 300), word("40", 400, 600), word("7", 50, 50)])).toEqual([]);
    });
});

describe("withCellReads", () => {
    it("sets each cell's read on the cell's box, in place of what lay inside it", () => {
        const misread = word("128", 160, 275);
        const edge = word("|", 158, 278);
        const page = { pageIndex: 0, words: [...grid(["12"]), misread, edge], cells: [] };
        const cells = [
            { box: [160, 275, 172, 285] as const, misread },
            { box: [100, 250, 112, 260] as const, misread: null },
        ];
        const read = [
            { ...word("2", 0, 0), line: 0 },
            { ...word("8", 4, 0, 30), line: 0, confidence: 41 },
        ];
        const out = withCellReads(page, cells, read);
        expect(out.words.map((w) => w.text)).not.toContain("128");
        expect(out.words.map((w) => w.text)).not.toContain("|");
        expect(out.cells.map((c) => [c.text, c.confidence, c.box, c.baseline])).toEqual([
            ["28", 41, [160, 275, 172, 285], 275],
        ]);
    });
});

describe("cellPage", () => {
    it("crops a cell with its margin into a page of its own whose view box places it on the page", () => {
        // A 300×400-pixel page at 2 pixels a point, its view box 150×200 points.
        const pixels = new Uint8Array(300 * 400).fill(255);
        const page = {
            pageIndex: 3,
            png: new Uint8Array(),
            image: { pixels, width: 300, height: 400, stride: 300 },
            widthPx: 300,
            heightPx: 400,
            scale: 2,
            viewBox: [0, 0, 150, 200] as const,
        };
        // A cell 10 points tall: a 5-point margin all round.
        const cell = cellPage(page, [50, 100, 60, 110]);
        expect([cell.widthPx, cell.heightPx]).toEqual([40, 40]);
        expect(cell.viewBox).toEqual([45, 95, 65, 115]);
        expect([cell.pageIndex, cell.scale]).toEqual([3, 2]);
    });
});
