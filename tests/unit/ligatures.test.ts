// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { withLigaturesJoined } from "../../src/infer/ligatures.ts";
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
