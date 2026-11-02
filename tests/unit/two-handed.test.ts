// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyTwoHandedClasses, twoHandedClasses } from "../../src/infer/two-handed.ts";
import type { Entity, JsonObject } from "../../src/types/entity.ts";

const weapon = (cls: string, extra: JsonObject = {}): Entity => ({
    blockId: cls,
    documentType: "Item",
    group: "g",
    pack: "p",
    ordinal: 0,
    fields: { name: "Lamp", type: "weapon", system: { class: cls, ...extra } },
    images: {},
    provenance: { pageIndex: 0, y: 0 },
});

describe("two-handed weapon classes", () => {
    it("reads the classes the document's rules say require two hands", () => {
        expect(
            [
                ...twoHandedClasses(
                    "• Basic weapons normally require two hands, but can be used one-handed. " +
                        "• Heavy: Such weapons always require two\nhands and must be braced.",
                ),
            ].sort(),
        ).toEqual(["basic", "heavy"]);
        expect([...twoHandedClasses("Basic: Weapons of this class normally require two hands.")]).toEqual([
            "basic",
        ]);
        // A sentence about some weapons of a class, or a word that is no class, names none.
        expect([
            ...twoHandedClasses(
                "A glove lets pistol weapons that normally require two hands be used in one.",
            ),
        ]).toEqual([]);
        expect([...twoHandedClasses("Lantern weapons require two hands.")]).toEqual([]);
    });

    it("flags each weapon of such a class, a pack's own or one an actor carries, unless set", () => {
        const basic = weapon("basic");
        const pistol = weapon("pistol");
        const printed = weapon("basic", { twoHanded: false });
        const actor: Entity = {
            ...weapon("npc"),
            documentType: "Actor",
            fields: {
                name: "Warden",
                type: "npc",
                items: [{ name: "Lamp", type: "weapon", system: { class: "basic" } }],
            },
        };
        applyTwoHandedClasses([basic, pistol, printed, actor], new Set(["basic"]));
        const flag = (e: Entity): unknown => (e.fields["system"] as JsonObject)["twoHanded"];
        expect([flag(basic), flag(pistol), flag(printed)]).toEqual([true, undefined, false]);
        expect(((actor.fields["items"] as JsonObject[])[0]?.["system"] as JsonObject)["twoHanded"]).toBe(
            true,
        );
    });
});
