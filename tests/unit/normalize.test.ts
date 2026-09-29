// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { normalize } from "../../src/stages/normalize.ts";
import type { RawDoc, RawTextRun } from "../../src/types/ir.ts";

const PAGE = { width: 600, height: 800, rotation: 0, viewBox: [0, 0, 600, 800] as const };
/** Left and right text columns of the two-column pages. */
const LEFT = 50;
const RIGHT = 310;
const MEASURE = 240;
/** Column edges and measure of the three-column pages: a wide gutter channel beside each column. */
const THIRDS = [50, 213, 376];
const THIRD_MEASURE = 135;

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

/** `count` full-measure prose lines in each of three columns of `pageIndex`, from `top` down. */
function thirds(pageIndex: number, top: number, count: number): RawTextRun[] {
    return Array.from({ length: count }, (_, i) =>
        THIRDS.map((x, c) => raw(pageIndex, x, top - 12 * i, THIRD_MEASURE, `col${c} ${i}`)),
    ).flat();
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

/** Two plain two-column pages of the same parity, setting the document's layout. */
const twoColumnPages = (): RawTextRun[] => [...columns(0, 700, 20), ...columns(4, 700, 20)];

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
            doc([...twoColumnPages(), ...columns(2, 700, 10), caption, header, ...rows, folio], [0, 2, 4]),
        );

        expect(ir.pages.map((p) => p.columns)).toEqual([2, 3, 2]);
        const columnOf = (text: string): number | undefined =>
            ir.runs.find((r) => r.pageIndex === 2 && r.text === text)?.column;
        expect(columnOf("left 3")).toBe(0);
        expect(columnOf("right 3")).toBe(1);
        expect([caption, header, ...rows].map((r) => columnOf(r.text))).toEqual([2, 2, 2, 2, 2, 2]);
        // Reading order: the left column, then the right, then the table.
        const order = ir.runs.filter((r) => r.pageIndex === 2).map((r) => r.text);
        expect(order.indexOf("left 9")).toBeLessThan(order.indexOf("right 0"));
        expect(order.indexOf("right 9")).toBeLessThan(order.indexOf(caption.text));
    });

    it("splits two columns beside a thumb-index tab in the side margin", () => {
        const rows = [530, 518, 506].map((y) => raw(2, LEFT, y, 450, `spanning row ${y}`));
        const tab = raw(2, 5, 620, 25, "Tab");
        const ir = normalize(doc([...twoColumnPages(), ...columns(2, 700, 10), ...rows, tab], [0, 2, 4]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 3, 2]);
        expect(ir.runs.find((r) => r.pageIndex === 2 && r.text === "right 3")?.column).toBe(1);
    });

    it("splits three columns above a full-width table when the document sets pages in three", () => {
        const rows = [530, 518, 506].map((y) => raw(2, LEFT, y, 470, `spanning row ${y}`));
        const ir = normalize(
            doc(
                [
                    ...twoColumnPages(),
                    ...thirds(6, 700, 20),
                    ...thirds(8, 700, 20),
                    ...thirds(2, 700, 10),
                    ...rows,
                ],
                [0, 2, 4, 6, 8],
            ),
        );
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 4, 2, 3, 3]);
        const columnOf = (text: string): number | undefined =>
            ir.runs.find((r) => r.pageIndex === 2 && r.text === text)?.column;
        expect(["col0 3", "col1 3", "col2 3", "spanning row 518"].map(columnOf)).toEqual([0, 1, 2, 3]);
    });

    it("reads no column from a thumb-index tab in the side margin", () => {
        const prose = Array.from({ length: 10 }, (_, i) => raw(2, LEFT, 700 - 12 * i, 500, `wide ${i}`));
        const tab = raw(2, 570, 400, 20, "Tab");
        const ir = normalize(doc([...twoColumnPages(), ...prose, tab], [0, 2, 4]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 1, 2]);
    });

    it("takes no layout from a single page", () => {
        const rows = [530, 518, 506].map((y) => raw(2, LEFT, y, 450, `spanning row ${y}`));
        const ir = normalize(doc([...columns(0, 700, 20), ...columns(2, 700, 10), ...rows], [0, 2]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 1]);
    });

    it("keeps a page of full-width prose as one column", () => {
        const prose = Array.from({ length: 10 }, (_, i) => raw(2, LEFT, 700 - 12 * i, 500, `wide ${i}`));
        const ir = normalize(doc([...twoColumnPages(), ...prose], [0, 2, 4]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 1, 2]);
    });

    it("keeps a table whose cell gap meets the gutter as one column", () => {
        const cells = [700, 688, 676, 664].flatMap((y) => [
            raw(2, LEFT, y, 60, `name ${y}`),
            raw(2, RIGHT, y, 40, `value ${y}`),
        ]);
        const prose = Array.from({ length: 4 }, (_, i) => raw(2, LEFT, 600 - 12 * i, 500, `wide ${i}`));
        const ir = normalize(doc([...twoColumnPages(), ...cells, ...prose], [0, 2, 4]));
        expect(ir.pages.map((p) => p.columns)).toEqual([2, 1, 2]);
    });
});
