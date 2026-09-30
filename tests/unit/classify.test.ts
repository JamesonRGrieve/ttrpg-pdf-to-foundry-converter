// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyTable } from "../../src/infer/classify.ts";
import type { DetectedTable } from "../../src/infer/types.ts";

const table = (headers: string[]): DetectedTable => ({ pageIndex: 0, headers, rows: [], tableTitle: "" });

describe("table classification", () => {
    it("recognises a weapon table by its weapon-only columns", () => {
        expect(
            classifyTable(table(["Name", "Class", "Range", "RoF", "Dam", "Pen", "Clip"])).contentType,
        ).toBe("weapon");
    });

    it("recognises catalogues of protection and of acquirable goods", () => {
        expect(classifyTable(table(["Name", "Protection Rating", "Weight"])).contentType).toBe("force-field");
        expect(classifyTable(table(["Name", "AP", "Weight"])).contentType).toBe("armour");
        expect(classifyTable(table(["Name", "Weight", "Availability"])).contentType).toBe("gear");
    });

    it("recognises ship components by their space and ship points", () => {
        expect(
            classifyTable(table(["Lamp Components", "Appropriate Hull Types", "Power", "Space", "SP"]))
                .contentType,
        ).toBe("ship-component");
        expect(classifyTable(table(["Name", "Space"])).contentType).not.toBe("ship-component");
    });

    it("matches acquisition signals as whole header words, not inside other words", () => {
        expect(classifyTable(table(["Time Required", "Bonus", "Penalty"])).contentType).toBe("unknown");
        expect(classifyTable(table(["Item", "Req"])).contentType).toBe("gear");
    });

    it("recognises a roll table by its dice column", () => {
        expect(classifyTable(table(["d100", "Result"])).contentType).toBe("rolltable");
    });
});
