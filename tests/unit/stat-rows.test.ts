// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    captionNames,
    cellValues,
    detectStatRows,
    isLabelRow,
    rowValues,
} from "../../src/infer/detect-stat-rows.ts";
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

const LABELS = "WS BS S T Ag Int Per WP Fel";
const bold = { weight: "bold" as const };

describe("statblock rows", () => {
    it("recognizes a row of characteristic labels", () => {
        expect(isLabelRow(LABELS)).toBe(true);
        expect(isLabelRow("WS BS S T")).toBe(false);
        expect(isLabelRow("Name Class Range Dam Pen Clip Rld Wt")).toBe(false);
    });

    it("reads one value per label, a dash as no characteristic, and rejects modifier rows", () => {
        expect(rowValues("38 - 40 35 40 15 45 35 10", 9)).toEqual([38, 0, 40, 35, 40, 15, 45, 35, 10]);
        expect(rowValues("-10 -10 +0 -10 -10 - -10 - -", 9)).toBeNull();
        expect(rowValues("38 38 38", 9)).toBeNull();
    });

    it("drops the word most captions end in, wherever it stands", () => {
        expect(
            captionNames(["Lamp Warden Profile", "Wick Hound Profile", "Ember Moth Profile - Young", "Glim"]),
        ).toEqual(["Lamp Warden", "Wick Hound", "Ember Moth - Young", "Glim"]);
        // Too few captions to discover a shared word.
        expect(captionNames(["Lamp Warden Profile"])).toEqual(["Lamp Warden Profile"]);
        // A stricter share leaves names that share a last word by chance.
        const names = ["Wick Cultist", "Ember Cultist", "Lamp Warden", "Glim Moth"];
        expect(captionNames(names)).toEqual(["Wick", "Ember", "Lamp Warden", "Glim Moth"]);
        expect(captionNames(names, 0.8)).toEqual(names);
    });

    it("reads each value under its label, closing up letter-spaced values", () => {
        const labels = ["WS", "BS", "S"].map((text, i) => ({ x: 10 + 25 * i, width: 12, text }));
        const at = (x: number, text: string) => ({ x, width: 12, text });
        expect(cellValues(labels, [at(10, "35"), at(35, "0 5"), at(60, "- -")])).toEqual([35, 5, 0]);
        // A run holding several values, or a label with none, is not read by position.
        expect(cellValues(labels, [at(10, "35 40"), at(60, "20")])).toBeNull();
        expect(cellValues(labels, [at(10, "35"), at(60, "20")])).toBeNull();
    });

    it("reads a statblock from its caption, rows and labelled fields, past a tab in the side margin", () => {
        const ir = irOf([
            run("Lamp Warden", 60, 700, { size: 11 }),
            run(LABELS, 60, 680, { size: 11.75 }),
            run("30 25 35 - 30 20 35 30 25", 60, 660, { size: 14.75 }),
            run("Wounds:", 60, 640, bold),
            run("12", 100, 640),
            run("TAB", 570, 640, { size: 90, width: 20 }),
            run("Talents:", 60, 628, bold),
            run("Quick Draw.", 110, 628),
            run("NEXT HEADING", 60, 600, { size: 12 }),
            run("Prose after the statblock.", 60, 588),
        ]);
        const [block] = detectStatRows(ir);
        expect(block?.name).toBe("Lamp Warden");
        expect(block?.caption).toBe("Lamp Warden");
        expect(block?.values).toEqual([30, 25, 35, 0, 30, 20, 35, 30, 25]);
        expect(block?.blocks.map((b) => b.label)).toEqual(["Wounds", "Talents"]);
    });

    it("reads the values past a line of bracketed notes set over them", () => {
        const ir = irOf([
            run("Glim Beast", 60, 700, { size: 11 }),
            run(LABELS, 60, 680, { size: 11.75 }),
            run("(8) (8)", 110, 667, { size: 7 }),
            run("40 20 45 45 30 10 35 30 5", 60, 660, { size: 14.75 }),
        ]);
        expect(detectStatRows(ir)[0]?.values).toEqual([40, 20, 45, 45, 30, 10, 35, 30, 5]);
    });

    it("takes no statblock from a worked example under a sentence", () => {
        const ir = irOf([
            run("so the characteristics now look like this.", 60, 700),
            run(LABELS, 60, 680, { size: 11.75 }),
            run("30 25 35 30 30 20 35 30 25", 60, 660, { size: 14.75 }),
        ]);
        expect(detectStatRows(ir)).toEqual([]);
    });
});
