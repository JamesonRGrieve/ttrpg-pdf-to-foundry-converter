// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/infer/detect-entries.ts";
import { parseNpc } from "../../src/infer/npc.ts";
import { profileOverrides, variantGrid, variantOverrides } from "../../src/infer/profile-variants.ts";
import type { DetectedNumericGrid } from "../../src/infer/types.ts";

const LABELS = ["ws", "bs", "s", "t", "ag", "int", "per", "wp", "fel"];

const profile = (pageIndex: number): DetectedNumericGrid => ({
    pageIndex,
    labels: [...LABELS],
    values: [25, 20, 30, 30, 30, 25, 25, 25, 30],
    name: "LAMPLIGHTER PROFILE",
    caption: null,
    bannerNumber: 9,
    associatedText: [],
    blocks: [],
});

const entry = (text: string, fields: [string, string][], pageIndex = 4): Entry => ({
    heading: { text, size: 12, style: "h", pageIndex },
    sections: ["Allies", "The Lamplighters"],
    fields,
    body: "Keepers of the night lamps.",
});

describe("profile variants", () => {
    it("reads a characteristic field's values and wounds", () => {
        expect(profileOverrides("BS 35, Wounds 12")).toEqual({ characteristics: { bs: 35 }, wounds: 12 });
        expect(profileOverrides("Int 30")).toEqual({ characteristics: { int: 30 }, wounds: null });
        expect(profileOverrides("As above")).toBeNull();
    });

    it("needs a characteristic field beside statblock fields", () => {
        expect(variantOverrides(entry("wick", [["Char", "Int 30"]]))).toBeNull();
        expect(variantOverrides(entry("wick", [["Gear", "Lamp."]]))).toBeNull();
        expect(
            variantOverrides(
                entry("wick", [
                    ["Char", "Int 30"],
                    ["Gear", "Lamp."],
                ]),
            ),
        ).not.toBeNull();
    });

    it("writes a variant's values over the nearest profile printed before it", () => {
        const sentry = entry("Lamp Sentry", [
            ["Char", "BS 35, Wounds 12"],
            ["Skills", "Awareness (Per)."],
            ["Gear", "Lamp, staff."],
        ]);
        const read = variantGrid(sentry, [profile(1), profile(3), profile(9)]);
        expect(read?.profile.pageIndex).toBe(3);
        expect(read?.grid.values).toEqual([25, 35, 30, 30, 30, 25, 25, 25, 30]);
        const npc = read === null ? null : parseNpc(read.grid);
        expect(npc?.system["wounds"]).toEqual({ max: 12, value: 12, critical: 0 });
        expect(npc?.system["skills"]).toBe("Awareness (Per)");
        // No profile within reach before it: no variant.
        expect(variantGrid(sentry, [profile(0)])).toBeNull();
    });
});
