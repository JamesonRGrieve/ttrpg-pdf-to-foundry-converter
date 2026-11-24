// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { EmittedPack } from "../../src/stages/emit.ts";
import { withFollowedOrigins } from "../../src/stages/follow-rules.ts";
import type { JsonObject } from "../../src/types/entity.ts";

const origin = (name: string, system: JsonObject): JsonObject => ({ name, type: "originPath", system });
const pack = (documents: JsonObject[]): EmittedPack => ({
    group: "g",
    pack: "p",
    documentType: "Item",
    documents,
});

describe("origins following another document's origin", () => {
    it("takes the named origin's base rules from another document of the run, keeping its own abilities", () => {
        const base = origin("Marsh World", {
            step: "homeWorld",
            description: { dh2: { value: "<p>Wet.</p>" } },
            grants: {
                woundsFormula: "8+1d5",
                aptitudes: ["Toughness"],
                specialAbilities: [{ name: "Old", description: "x" }],
            },
            modifiers: { characteristics: { toughness: 5 } },
        });
        const follower = origin("Ashreach", {
            step: "homeWorld",
            description: { dh2: { value: "<p>Ashreach natives follow the marsh world rules.</p>" } },
            grants: {
                woundsFormula: "",
                aptitudes: [],
                specialAbilities: [{ name: "New", description: "y" }],
            },
            modifiers: { characteristics: {} },
        });
        withFollowedOrigins([
            { line: "dh2", packs: [pack([base])] },
            { line: "dh2", packs: [pack([follower])] },
        ]);
        const system = follower["system"] as JsonObject;
        expect(system["grants"]).toEqual({
            woundsFormula: "8+1d5",
            aptitudes: ["Toughness"],
            specialAbilities: [{ name: "New", description: "y" }],
        });
        expect(system["modifiers"]).toEqual({ characteristics: { toughness: 5 } });
    });

    it("leaves an origin whose named base is of another line", () => {
        const base = origin("Marsh World", {
            step: "homeWorld",
            grants: { woundsFormula: "8+1d5" },
            modifiers: { characteristics: { toughness: 5 } },
        });
        const follower = origin("Ashreach", {
            step: "homeWorld",
            description: "Ashreach natives follow the marsh world rules.",
            grants: {},
            modifiers: { characteristics: {} },
        });
        withFollowedOrigins([
            { line: "rt", packs: [pack([base])] },
            { line: "dh2", packs: [pack([follower])] },
        ]);
        expect((follower["system"] as JsonObject)["grants"]).toEqual({});
    });
});
