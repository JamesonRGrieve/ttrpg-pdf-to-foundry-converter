// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyIdentifiers, identifierFor, identifierFromName } from "../../src/infer/identifiers.ts";
import type { Entity } from "../../src/types/entity.ts";

const entity = (name: string, type: string, system: Record<string, string> = {}, doc = "Item"): Entity => ({
    blockId: "b",
    documentType: doc as Entity["documentType"],
    group: "g",
    pack: "p",
    ordinal: 0,
    fields: { name, type, system },
    images: {},
    provenance: { pageIndex: 0, y: 0 },
});

describe("identifierFromName", () => {
    it("writes the system's kebab-case form of a name", () => {
        expect(identifierFromName("Widget-Gun (Mk. II)")).toBe("widget-gun-mk-ii");
        expect(identifierFromName("  Two  Words ")).toBe("two-words");
        expect(identifierFromName("Jack's Hook")).toBe("jacks-hook");
    });

    it("leaves a talent's or trait's specialisation placeholder out of its identifier", () => {
        expect(identifierFor("trait", "Lamp Skin (X)")).toBe("lamp-skin");
        expect(identifierFor("talent", "Wick Sense (+x)")).toBe("wick-sense");
        expect(identifierFor("trait", "Glow (Bright)")).toBe("glow-bright");
        // A quality's level is part of it.
        expect(identifierFor("weaponQuality", "Flare (X)")).toBe("flare-x");
    });
});

describe("applyIdentifiers", () => {
    it("fills a missing identifier on an item type whose schema has one", () => {
        const e = entity("Glow Rod", "gear");
        applyIdentifiers([e]);
        expect(e.fields["system"]).toEqual({ identifier: "glow-rod" });
    });

    it("keeps an identifier already present, and leaves actors and unidentified types alone", () => {
        const kept = entity("Glow Rod", "gear", { identifier: "own" });
        const actor = entity("Someone", "dh2-npc", {}, "Actor");
        const other = entity("Thing", "journalPage");
        applyIdentifiers([kept, actor, other]);
        expect(kept.fields["system"]).toEqual({ identifier: "own" });
        expect(actor.fields["system"]).toEqual({});
        expect(other.fields["system"]).toEqual({});
    });
});
