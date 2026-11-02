// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { armourDiagram, diagramArmour } from "../../src/infer/armour-diagram.ts";
import { parseNpc } from "../../src/infer/npc.ts";
import type { IRTextRun } from "../../src/types/ir.ts";

function run(text: string, x: number, y: number, size: number, width = size * 0.6 * text.length): IRTextRun {
    return {
        pageIndex: 0,
        band: 0,
        x,
        y,
        width,
        height: size,
        text,
        font: "f",
        weight: "normal",
        italic: false,
        size,
        sizeBucket: 0,
        column: 0,
        indent: 0,
        renderOrder: 0,
    };
}

/**
 * A synthetic diagram: each location label (a large initial and a smaller
 * second letter, set as separate touching runs), its hit roll below it, its
 * armour (small) up and to the right, its soak (large) down and to the right.
 */
function diagram(armour: Record<string, string>, soak: Record<string, string> | null): IRTextRun[] {
    const at: Record<string, [number, number]> = {
        H: [100, 200],
        AR: [60, 175],
        AL: [140, 175],
        B: [100, 150],
        LR: [80, 120],
        LL: [125, 120],
    };
    return Object.entries(at).flatMap(([label, [x, y]]) => {
        const letters = [run(label[0] ?? "", x, y, 12, 8)];
        if (label.length > 1) {
            letters.push(run(label.slice(1), x + 8, y, 8.5, 5));
        }
        const figures =
            soak === null
                ? [run(armour[label] ?? "", x + 18, y - 10, 15)]
                : [run(armour[label] ?? "", x + 16, y + 4, 7), run(soak[label] ?? "", x + 18, y - 10, 15)];
        return [...letters, run("01-10", x - 2, y - 10, 7, 12), ...figures];
    });
}

const all = (v: string): Record<string, string> =>
    Object.fromEntries(["H", "AR", "AL", "B", "LR", "LL"].map((k) => [k, v]));

describe("armourDiagram", () => {
    it("sums the smaller figures a location sets side by side, a run set twice counting once", () => {
        const runs = diagram({ ...all("1"), H: "-" }, all("9"));
        // A second small figure beside each armour figure (a natural armour).
        const extra = runs
            .filter((r) => r.size === 7 && r.text !== "01-10")
            .map((r) => ({ ...r, x: r.x + 8, text: "3" }));
        const twice = extra.slice(0, 1);
        expect(armourDiagram([...runs, ...extra, ...twice])?.figures).toEqual({
            head: 3,
            body: 4,
            leftArm: 4,
            rightArm: 4,
            leftLeg: 4,
            rightLeg: 4,
        });
    });

    it("reads the smaller figure where a location prints armour and soak", () => {
        const armour = { ...all("4"), H: "-", B: "6" };
        expect(armourDiagram(diagram(armour, all("9")))).toEqual({
            figures: { head: 0, body: 6, leftArm: 4, rightArm: 4, leftLeg: 4, rightLeg: 4 },
            soak: false,
        });
    });

    it("reads a lone figure at each location as the soak", () => {
        const reading = armourDiagram(diagram({ ...all("3"), LL: "5", H: "2" }, null));
        expect(reading).toEqual({
            figures: { head: 2, body: 3, leftArm: 3, rightArm: 3, leftLeg: 5, rightLeg: 3 },
            soak: true,
        });
        expect(reading === null ? null : diagramArmour(reading, 3)).toEqual({
            head: 0,
            body: 0,
            leftArm: 0,
            rightArm: 0,
            leftLeg: 2,
            rightLeg: 0,
        });
    });

    it("reads location labels a text layer set in lower case", () => {
        const runs = diagram(all("4"), all("8")).map((r) => ({ ...r, text: r.text.toLowerCase() }));
        expect(armourDiagram(runs)?.figures.body).toBe(4);
    });

    it("is null where fewer than four locations are named", () => {
        const runs = diagram(all("4"), all("8")).filter((r) => !/^[ABL]$/u.test(r.text) || r.size !== 12);
        expect(armourDiagram(runs)).toBeNull();
        expect(armourDiagram([run("B", 0, 0, 12), run("3", 10, 0, 12)])).toBeNull();
    });

    it("gives an NPC without an armour line the diagram's armour", () => {
        const npc = parseNpc({
            pageIndex: 0,
            name: "SAMPLE (Troop)",
            caption: null,
            bannerNumber: 9,
            labels: ["ws", "bs", "s", "t", "ag", "int", "per", "wp", "fel"],
            values: [30, 30, 30, 30, 30, 30, 30, 30, 30],
            associatedText: [],
            blocks: [],
            armourDiagram: {
                figures: { head: 0, body: 4, leftArm: 2, rightArm: 2, leftLeg: 2, rightLeg: 2 },
                soak: false,
            },
        });
        expect(npc.system["armour"]).toEqual({
            mode: "locations",
            total: 4,
            authored: true,
            locations: { head: 0, body: 4, leftArm: 2, rightArm: 2, leftLeg: 2, rightLeg: 2 },
        });
    });

    it("takes the Toughness bonus off a diagram's soak", () => {
        const npc = parseNpc({
            pageIndex: 0,
            name: "SAMPLE",
            caption: null,
            bannerNumber: null,
            labels: ["ws", "bs", "s", "t"],
            values: [30, 30, 30, 34],
            associatedText: [],
            blocks: [],
            armourDiagram: {
                figures: { head: 3, body: 7, leftArm: 5, rightArm: 5, leftLeg: 5, rightLeg: 5 },
                soak: true,
            },
        });
        expect((npc.system["armour"] as { locations: unknown }).locations).toEqual({
            head: 0,
            body: 4,
            leftArm: 2,
            rightArm: 2,
            leftLeg: 2,
            rightLeg: 2,
        });
    });

    it("prefers a printed armour line over the diagram", () => {
        const npc = parseNpc({
            pageIndex: 0,
            name: "SAMPLE",
            caption: null,
            bannerNumber: null,
            labels: ["ws"],
            values: [30],
            associatedText: ["Armour: 5 All"],
            blocks: [],
            armourDiagram: {
                figures: { head: 1, body: 1, leftArm: 1, rightArm: 1, leftLeg: 1, rightLeg: 1 },
                soak: false,
            },
        });
        expect((npc.system["armour"] as { total: number }).total).toBe(5);
    });
});
