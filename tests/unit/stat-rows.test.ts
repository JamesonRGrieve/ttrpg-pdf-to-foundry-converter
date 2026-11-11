// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    captionNames,
    cellValues,
    detectStatRows,
    isLabelRow,
    rowValues,
    textBlockRuns,
    withMissingLabel,
    withTrailingLabel,
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

    it("looks for the shared word before a tier note that varies, and drops a note all share", () => {
        const tiered = ["Lamp Warden Profile (Elite)", "Wick Hound Profile(Troop)", "Glim Profile (Master)"];
        expect(captionNames(tiered)).toEqual(["Lamp Warden (Elite)", "Wick Hound (Troop)", "Glim (Master)"]);
        const minions = ["Wick Hound (Minion)", "Lamp Moth (Minion)", "Glim (Minion)"];
        expect(captionNames(minions)).toEqual(["Wick Hound", "Lamp Moth", "Glim"]);
        // The most common tier is still a tier, not a shared label.
        const tiers = ["Wick Hound (Elite)", "Lamp Moth (Elite)", "Glim (Master)"];
        expect(captionNames(tiers)).toEqual(tiers);
    });

    it("reads a row of ten labels, the tenth the schema's influence", () => {
        expect(isLabelRow(`${LABELS} Inf`)).toBe(true);
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

    it("reads no statblock from a worked example led in to by running text", () => {
        const under = (caption: string): number =>
            detectStatRows(
                irOf([
                    run("He rolls again, so his numbers now", 60, 712),
                    run(caption, 60, 700),
                    run(LABELS, 60, 680),
                    run("41 45 46 40 39 42 45 44 38", 60, 668),
                    run("NEXT HEADING", 60, 640, { size: 12 }),
                ]),
            ).length;
        expect(under("look like this:")).toBe(0);
        expect(under("Example Profile:")).toBe(0);
        expect(under("Lamp Warden")).toBe(1);
        // A caption set in small capitals arrives in lower case: still a name.
        expect(under("lamp warden profile")).toBe(1);
    });

    it("leaves a page's folio out of a panel that runs on to the next page", () => {
        const one = irOf([
            run("Lamp Warden", 60, 120, { size: 11 }),
            run(LABELS, 60, 100, { size: 11.75 }),
            run("30 25 35 - 30 20 35 30 25", 60, 80, { size: 14.75 }),
            run("Skills:", 60, 60, bold),
            run("Hush (Ag), Silent", 100, 60),
            run("377", 300, 6),
            run("Wading (S) +10.", 60, 760, { pageIndex: 1 }),
            run("Talents:", 60, 748, { ...bold, pageIndex: 1 }),
            run("Keen Eye.", 110, 748, { pageIndex: 1 }),
            run("378", 300, 6, { pageIndex: 1 }),
        ]);
        const [page] = one.pages;
        if (page === undefined) {
            throw new Error("one page expected");
        }
        const ir = { ...one, pages: [page, { ...page, pageIndex: 1 }] };
        const [block] = detectStatRows(ir);
        expect(block?.blocks.map((b) => [b.label, b.text])).toEqual([
            ["Skills", "Hush (Ag), Silent Wading (S) +10."],
            ["Talents", "Keen Eye."],
        ]);
    });

    it("reads the panel past a mark recovered from the page image, larger than body text", () => {
        const panel = (mark: Partial<IRTextRun>): string[] =>
            detectStatRows(
                irOf([
                    run("Lamp Warden", 60, 700, { size: 11 }),
                    run(LABELS, 60, 680, { size: 11.75 }),
                    run("30 25 35 - 30 20 35 30 25", 60, 660, { size: 14.75 }),
                    run("YY", 200, 650, { size: 10.5, ...mark }),
                    run("Wounds:", 60, 640, bold),
                    run("12", 100, 640),
                    ...Array.from({ length: 6 }, (_, i) =>
                        run("Prose after the statblock.", 60, 600 - 12 * i),
                    ),
                ]),
            )[0]?.blocks.map((b) => b.label ?? "") ?? [];
        expect(panel({ font: "ocr-recovered" })).toContain("Wounds");
        // Set in the text layer at that size, the line is a heading: the panel ends at it.
        expect(panel({})).not.toContain("Wounds");
    });

    it("reads a doubled dash as no characteristic", () => {
        expect(rowValues("40 - 35 35 48 18 40 30 --", 9)).toEqual([40, 0, 35, 35, 48, 18, 40, 30, 0]);
        expect(rowValues("40 --- 35", 3)).toBeNull();
    });

    it("puts back the one label a text layer dropped where the row leaves room for it", () => {
        const at = (text: string, x: number) => ({ x, width: 10, text });
        // "Fel" missing between "WP" and "Inf": a double gap.
        const row = ["WS", "BS", "S", "T", "Ag", "Int", "Per", "WP"].map((t, i) => at(t, 100 + 22 * i));
        const restored = withMissingLabel([...row, at("Inf", 100 + 22 * 9)]);
        expect(restored.map((l) => l.text)).toEqual([...row.map((l) => l.text), "fel", "Inf"]);
        expect(restored[8]?.x).toBe(100 + 22 * 8);
        // A full row, a row missing two, or one whose gap leaves no room stays as it is.
        const full = [...row, at("Fel", 276)];
        expect(withMissingLabel(full)).toEqual(full);
        const two = [at("WS", 100), at("S", 144), at("Ag", 188), ...row.slice(5)];
        expect(withMissingLabel(two)).toEqual(two);
        const tight = [...row, at("Inf", 276)];
        expect(withMissingLabel(tight)).toEqual(tight);
    });

    it("puts back a last label a text layer dropped past the row's end, under a value set there", () => {
        const at = (text: string, x: number) => ({ x, width: 10, text });
        const row = LABELS.split(" ").map((t, i) => at(t, 100 + 22 * i));
        const values = (count: number) => Array.from({ length: count }, (_, i) => at("3", 100 + 22 * i));
        // Ten values under nine labels: the tenth stands where the schema's next label goes.
        const restored = withTrailingLabel(row, values(10));
        expect(restored.map((l) => l.text).at(-1)).toBe("inf");
        expect(restored.at(-1)?.x).toBe(100 + 22 * 9);
        expect(cellValues(restored, values(10))).toEqual(Array.from({ length: 10 }, () => 3));
        // As many values as labels, or a stray run far past the row: the row as it is.
        expect(withTrailingLabel(row, values(9))).toEqual(row);
        expect(withTrailingLabel(row, [...values(9), at("7", 100 + 22 * 12)])).toEqual(row);
        // A row already ending on the schema's last label has none after it.
        const ten = [...row, at("Inf", 100 + 22 * 9)];
        expect(withTrailingLabel(ten, values(11))).toEqual(ten);
    });

    it("keeps a row's last column set past the side margin's edge, not a tab set apart there", () => {
        // A page 600 wide: its right margin starts at 558. Labels and values one run each, every 25 points.
        const labels = LABELS.split(" ").map((text, i) => run(text, 360 + 25 * i, 680, { width: 12 }));
        const values = ["30", "25", "35", "40", "30", "20", "35", "30", "25"].map((text, i) =>
            run(text, 360 + 25 * i, 660, { size: 12, width: 12 }),
        );
        const ir = irOf([
            run("Lamp Warden", 360, 700, { size: 11 }),
            ...labels,
            ...values,
            run("TAB", 590, 700, { width: 8 }),
        ]);
        const [block] = detectStatRows(ir);
        expect(block?.values).toEqual([30, 25, 35, 40, 30, 20, 35, 30, 25]);
        expect(textBlockRuns(ir.runs, () => 600).map((r) => r.text)).not.toContain("TAB");
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

    it("reads the values past a note set as a small superscript over them", () => {
        const ir = irOf([
            run("Glim Beast", 60, 700, { size: 11 }),
            run(LABELS, 60, 680, { size: 11.75 }),
            run("8", 220, 671, { size: 5 }),
            run("40 20 45 45 30 10 35 30 5", 60, 660, { size: 14.75 }),
        ]);
        expect(detectStatRows(ir)[0]?.values).toEqual([40, 20, 45, 45, 30, 10, 35, 30, 5]);
    });

    it("names statblocks sharing one caption by the heading above it", () => {
        const block = (name: string, top: number): IRTextRun[] => [
            run(name, 60, top, { size: 11 }),
            run("Main Profile", 60, top - 12, { size: 8 }),
            run(LABELS, 60, top - 24, { size: 8 }),
            run("30 25 35 30 30 20 35 30 25", 60, top - 36, { size: 9.5 }),
            run("Wounds:", 60, top - 50, bold),
            run("12", 100, top - 50),
        ];
        const ir = irOf([...block("GLIM BEAST", 700), ...block("LAMP WARDEN", 560)]);
        expect(detectStatRows(ir).map((b) => [b.name, b.caption])).toEqual([
            ["GLIM BEAST", "GLIM BEAST"],
            ["LAMP WARDEN", "LAMP WARDEN"],
        ]);
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
