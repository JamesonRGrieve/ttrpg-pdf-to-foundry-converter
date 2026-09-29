// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { normalize } from "../../src/stages/normalize.ts";
import type { RawDoc, RawTextRun } from "../../src/types/ir.ts";

const PAGE = { width: 600, height: 800, rotation: 0, viewBox: [0, 0, 600, 800] as const };
/** Left and right text columns of the two-column pages. */
const LEFT = 50;
const RIGHT = 310;
const MEASURE = 240;

function raw(pageIndex: number, x: number, y: number, width: number, text: string): RawTextRun {
    return {
        pageIndex,
        x,
        y,
        width,
        height: 8,
        text,
        fontName: "body",
        fontSize: 10,
        weight: "normal",
        italic: false,
        renderOrder: 0,
    };
}

/** `count` full-measure prose lines in each column of `pageIndex`, from `top` down. */
function columns(pageIndex: number, top: number, count: number): RawTextRun[] {
    return Array.from({ length: count }, (_, i) => [
        raw(pageIndex, LEFT, top - 12 * i, MEASURE, `left ${i}`),
        raw(pageIndex, RIGHT, top - 12 * i, MEASURE, `right ${i}`),
    ]).flat();
}

function doc(textRuns: RawTextRun[], pageIndexes: number[]): RawDoc {
    return {
        encrypted: false,
        extractor: "test",
        pages: pageIndexes.map((pageIndex) => ({ pageIndex, ...PAGE })),
        textRuns,
        images: [],
        placements: [],
        meta: { title: null, author: null, producer: null, creator: null, creationDate: null },
    };
}

describe("column regions", () => {
    it("splits two columns above a full-width table, keeping the table's caption with it", () => {
        // The caption sits a little over two line pitches below the prose.
        const caption = raw(2, LEFT, 560, 120, "Table 1-1: Lamps");
        const header = raw(2, LEFT, 545, 200, "NAME WEIGHT");
        const rows = [530, 518, 506].map((y) => raw(2, LEFT, y, 450, `spanning row ${y}`));
        // A last cell reaching into the bottom margin still belongs to the table.
        rows.push(raw(2, 150, 40, 60, "last cell"));
        // A folio out in the margin does not widen the text measure.
        const folio = raw(2, 12, 20, 10, "84");
        const ir = normalize(
            doc([...columns(0, 700, 20), ...columns(2, 700, 10), caption, header, ...rows, folio], [0, 2]),
        );

        expect(ir.pages.map((p) => p.columns)).toEqual([2, 3]);
        const columnOf = (text: string): number | undefined => ir.runs.find((r) => r.text === text)?.column;
        expect(columnOf("left 3")).toBe(0);
        expect(columnOf("right 3")).toBe(1);
        expect([caption, header, ...rows].map((r) => columnOf(r.text))).toEqual([2, 2, 2, 2, 2, 2]);
        // Reading order: the left column, then the right, then the table.
        const order = ir.runs.filter((r) => r.pageIndex === 2).map((r) => r.text);
        expect(order.indexOf("left 9")).toBeLessThan(order.indexOf("right 0"));
        expect(order.indexOf("right 9")).toBeLessThan(order.indexOf(caption.text));
    });

    it("keeps a page of full-width prose as one column", () => {
        const prose = Array.from({ length: 10 }, (_, i) => raw(2, LEFT, 700 - 12 * i, 500, `wide ${i}`));
        const ir = normalize(doc([...columns(0, 700, 20), ...prose], [0, 2]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 1]);
    });

    it("keeps a table whose cell gap meets the gutter as one column", () => {
        const cells = [700, 688, 676, 664].flatMap((y) => [
            raw(2, LEFT, y, 60, `name ${y}`),
            raw(2, RIGHT, y, 40, `value ${y}`),
        ]);
        const prose = Array.from({ length: 4 }, (_, i) => raw(2, LEFT, 600 - 12 * i, 500, `wide ${i}`));
        const ir = normalize(doc([...columns(0, 700, 20), ...cells, ...prose], [0, 2]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 1]);
    });
});
