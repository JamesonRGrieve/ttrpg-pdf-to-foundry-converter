// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { withoutOverlaidCopies } from "../../src/infer/overlaid.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

const run = (text: string, x: number, y: number, font: string, width = 8 * text.length): IRTextRun => ({
    pageIndex: 0,
    band: 0,
    x,
    y,
    width,
    height: 18,
    text,
    font,
    weight: "normal",
    italic: false,
    size: 18,
    sizeBucket: 0,
    column: 0,
    indent: 0,
    renderOrder: 0,
});

const irOf = (runs: IRTextRun[]): IR => ({
    irVersion: 0,
    pages: [],
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
});

const texts = (ir: IR): string[] => ir.runs.map((r) => `${r.font}:${r.text}`);

describe("a heading set twice over itself", () => {
    it("keeps one face where a whole-word copy lies over fragments", () => {
        const ir = irOf([
            run("Lamp", 40, 700, "display"),
            run("Wright", 80, 700, "display"),
            run("l", 42, 698, "plain", 6),
            run("amp", 48, 698, "plain", 24),
            run("WR", 80, 698, "plain", 16),
            run("ight", 96, 698, "plain", 32),
            run("Body text below.", 40, 600, "body"),
        ]);
        expect(texts(withoutOverlaidCopies(ir))).toEqual([
            "plain:l",
            "plain:amp",
            "plain:WR",
            "plain:ight",
            "body:Body text below.",
        ]);
    });

    it("leaves a shadow (as many runs in each face) alone", () => {
        const ir = irOf([run("Lamp", 40, 700, "display"), run("Lamp", 41, 699, "plain")]);
        expect(withoutOverlaidCopies(ir).runs).toHaveLength(2);
    });

    it("leaves lines alone whose faces spell differently, and the heading lines stacked with them", () => {
        const ir = irOf([
            // A misread line: the two faces disagree.
            run("Lamp", 40, 720, "display"),
            run("WrightRight", 80, 720, "display"),
            run("l", 42, 718, "plain", 6),
            run("amp", 48, 718, "plain", 24),
            run("Wri", 80, 718, "plain", 24),
            // The heading's next line spells alike, but stays with its stack.
            run("(Guild)", 40, 698, "display"),
            run("(g", 40, 696, "plain", 16),
            run("uild)", 56, 696, "plain", 40),
        ]);
        expect(withoutOverlaidCopies(ir).runs).toHaveLength(8);
    });
});
