// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { withLigaturesJoined, withLostLettersRestored } from "../../src/infer/ligatures.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

function irOf(texts: string[]): IR {
    const runs: IRTextRun[] = texts.map((text, i) => ({
        pageIndex: 0,
        band: 0,
        x: 60,
        y: 700 - 12 * i,
        width: 5 * text.length,
        height: 9,
        text,
        font: "body",
        weight: "normal",
        italic: false,
        size: 10,
        sizeBucket: 0,
        column: 0,
        indent: 0,
        renderOrder: i,
    }));
    return { irVersion: 0, pages: [], runs } as unknown as IR;
}

describe("a letter lost after a ligature", () => {
    const at = (text: string, x: number, width: number, y = 600): IRTextRun => {
        const [run] = irOf([text]).runs;
        if (run === undefined) {
            throw new Error("no run");
        }
        return { ...run, x, y, width };
    };
    const ir = (runs: IRTextRun[]): IR => ({ irVersion: 0, pages: [], runs }) as unknown as IR;

    it("restores the letter an empty glyph after the pair stands for, as the document prints the word", () => {
        const runs = [
            at("Reed Rifl", 60, 35),
            at("", 95, 4),
            at("Basic", 120, 20),
            at("The reed rifle and the bone rifle are rifles.", 60, 200, 500),
            at("Staff", 60, 20, 400),
            at("", 80, 5, 400),
            at("A staff is a staff.", 60, 80, 300),
        ];
        const texts = withLostLettersRestored(ir(runs)).runs.map((r) => r.text);
        expect(texts[0]).toBe("Reed Rifle");
        // A word the document prints as it is keeps its form.
        expect(texts[4]).toBe("Staff");
    });

    it("leaves a pair followed by a space-wide or a distant empty run", () => {
        const runs = [at("Reed Rifl", 60, 35), at("", 95, 1), at("rifle rifle", 60, 50, 500)];
        expect(withLostLettersRestored(ir(runs)).runs[0]?.text).toBe("Reed Rifl");
        const far = [at("Reed Rifl", 60, 35), at("", 110, 4), at("rifle rifle", 60, 50, 500)];
        expect(withLostLettersRestored(ir(far)).runs[0]?.text).toBe("Reed Rifl");
    });
});

describe("ligatures set with a space", () => {
    it("joins the words of a document that splits most of its fi and fl pairs", () => {
        const ir = withLigaturesJoined(
            irOf(["The fl ame burns a signifi cant while,", "its benefi ts fi nite.", "A first lamp."]),
        );
        expect(ir.runs.map((r) => r.text)).toEqual([
            "The flame burns a significant while,",
            "its benefits finite.",
            "A first lamp.",
        ]);
    });

    it("leaves a document that splits only a few, as a name ending on the pair", () => {
        const texts = ["Ralfi is here at first.", "The flame of the fire is fine."];
        expect(withLigaturesJoined(irOf(texts)).runs.map((r) => r.text)).toEqual(texts);
    });
});
