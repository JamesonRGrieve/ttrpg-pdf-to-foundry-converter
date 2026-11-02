// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    asLoaded,
    citesBook,
    type Doc,
    editDistance,
    embeddedByType,
    leafScore,
    leaves,
    nameKey,
    resolveLine,
    scoreBook,
    typeKey,
} from "../../scripts/lib/parity.ts";

const source = (book: string) => ({ dh2: { provenance: "raw", book, page: "10" } });

describe("resolveLine", () => {
    it("collapses a per-line container to the target line", () => {
        expect(resolveLine({ dh2: { a: 1 }, rt: { a: 2 } }, "rt")).toEqual({ a: 2 });
        expect(resolveLine({ dh2: 5 }, "rt")).toBeUndefined();
    });

    it("collapses a per-book container to its canonical book", () => {
        expect(resolveLine({ __books: { x: 1, y: 2 }, __canonical: "y" }, "dh2")).toBe(2);
    });

    it("leaves an ordinary object alone", () => {
        expect(resolveLine({ ws: 1, bs: 2 }, "dh2")).toEqual({ ws: 1, bs: 2 });
    });
});

describe("keys", () => {
    it("ignores case, punctuation, accents and a variable placeholder", () => {
        expect(nameKey("Sword-Breaker (X)")).toBe(nameKey("sword breaker"));
        expect(nameKey("Déjà Vu")).toBe(nameKey("deja vu"));
    });

    it("compares line-keyed actor types by kind", () => {
        expect(typeKey("dh2-npc")).toBe("npc");
        expect(typeKey("weapon.modification")).toBe("weaponModification");
        expect(typeKey("weapon")).toBe("weapon");
    });
});

describe("leafScore", () => {
    it("treats case, dash glyphs and numeric strings as one value", () => {
        expect(leafScore("Half–Action", "half-action")).toBe(1);
        expect(leafScore("12", 12)).toBe(1);
        expect(leafScore(3, 4)).toBe(0);
    });

    it("counts an omitted leaf as agreeing with an empty reference value", () => {
        expect(leafScore("", undefined)).toBe(1);
        expect(leafScore(0, undefined)).toBe(1);
        expect(leafScore("x", undefined)).toBe(0);
    });

    it("scores prose by word overlap, whatever its markup", () => {
        expect(
            leafScore("<p>Reroll one missed attack each round.</p>", "Reroll one missed attack each round."),
        ).toBe(1);
        expect(leafScore("<p>alpha beta gamma delta</p>", "<p>alpha beta gamma epsilon</p>")).toBeCloseTo(
            0.75,
        );
    });

    it("scores arrays by the Jaccard index of their members", () => {
        expect(leafScore(["a", "b"], ["b", "a"])).toBe(1);
        expect(leafScore(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3);
        expect(leafScore([], [])).toBe(1);
    });

    it("compares structured members without their links into the reference's packs", () => {
        expect(
            leafScore(
                [{ name: "Glow Lore", level: "known", uuid: "Compendium.x.y.Item.abc" }],
                [{ level: "known", name: "Glow Lore" }],
            ),
        ).toBe(1);
        expect(leafScore([{ name: "Glow Lore", uuid: "Compendium.x" }], [{ name: "Wick Lore" }])).toBe(0);
    });
});

describe("leaves", () => {
    it("flattens system leaves with line containers collapsed and editorial data excluded", () => {
        const l = leaves(
            {
                damage: { formula: "1d10", bonus: 2 },
                description: { dh2: { value: "<p>x</p>" } },
                notes: { dh2: "n" },
                cost: { dh2: { influence: 3, homebrew: { throneGelt: 9 } } },
                special: ["a"],
            },
            "dh2",
        );
        expect([...l.keys()].sort()).toEqual(["cost.influence", "damage.bonus", "damage.formula", "special"]);
    });
});

describe("embeddedByType", () => {
    it("groups embedded item names by type, a plural matching its singular", () => {
        const m = embeddedByType({
            items: [
                { name: "Rags", type: "gear" },
                { name: "Blade", type: "weapon" },
            ],
        });
        expect(m.get("gear")).toEqual(["rag"]);
        expect(m.get("weapon")).toEqual(["blade"]);
    });
});

describe("citesBook", () => {
    it("selects RAW citations of the book for the line", () => {
        expect(citesBook({ system: { source: source("B") } }, "dh2", "B")).toBe(true);
        expect(citesBook({ system: { source: source("B") } }, "dh2", "C")).toBe(false);
        expect(
            citesBook({ system: { source: { dh2: { provenance: "homebrew", book: "B" } } } }, "dh2", "B"),
        ).toBe(false);
    });
});

describe("scoreBook", () => {
    const ref: Doc[] = [
        {
            name: "Alpha Gun",
            type: "weapon",
            system: { damage: { formula: "1d10", bonus: 3 }, special: ["x"] },
        },
        { name: "Beta Thing", type: "gear", system: { weight: 2 } },
        { name: "Gamma Talent", type: "talent", system: { tier: 1 } },
    ];
    const out: Doc[] = [
        {
            name: "ALPHA GUN",
            type: "weapon",
            system: { damage: { formula: "1d10", bonus: 4 }, special: ["x"] },
        },
        { name: "Gamma Talent", type: "trait", system: {} },
        { name: "Delta Extra", type: "gear", system: {} },
    ];
    const r = scoreBook(ref, out, "dh2");

    it("matches by type and name key, and reports missing, mis-typed and extra documents", () => {
        expect(r.reference).toBe(3);
        expect(r.matched).toBe(1);
        expect(r.types["gear"]?.missing).toEqual(["Beta Thing"]);
        expect(r.types["talent"]?.misTyped).toEqual(["Gamma Talent → trait"]);
        expect(r.types["gear"]?.extra).toEqual(["Delta Extra"]);
    });

    it("scores a matched document by its mean leaf agreement and a missing one as zero", () => {
        // Leaves: name (an exact match), damage.formula, damage.bonus (wrong), special.
        expect(r.types["weapon"]?.docScore).toBeCloseTo(3 / 4);
        expect(r.types["weapon"]?.fields["damage.bonus"]).toEqual({ checks: 1, score: 0 });
        expect(r.score).toBeCloseTo(3 / 4 / 3);
    });

    it("matches a printed plural or article form of the reference name", () => {
        const p = scoreBook(
            [{ name: "Lamp Warden", type: "npc", system: {} }],
            [{ name: "Typical Lamp Wardens", type: "dh2-npc", system: {} }],
            "dh2",
        );
        expect(p.matched).toBe(1);
    });

    it("falls back to qualifier-free, suffix and spelling-distance matches, and charges a misread name", () => {
        const p = scoreBook(
            [
                { name: "Widget Gun (Mount Kind)", type: "weapon", system: {} },
                { name: "Faction Hunter Beast", type: "npc", system: {} },
                { name: "Lantern Keeper", type: "npc", system: {} },
            ],
            [
                { name: "Widget Gun", type: "weapon", system: {} },
                { name: "Hunter Beast", type: "npc", system: {} },
                { name: "Lanturn Keepr", type: "npc", system: {} },
            ],
            "dh2",
        );
        expect(p.matched).toBe(3);
        expect(p.types["weapon"]?.tiers).toEqual({ qualifier: 1 });
        expect(p.types["npc"]?.tiers).toEqual({ suffix: 1, fuzzy: 1 });
        expect(p.types["npc"]?.fields["name"]).toEqual({ checks: 2, score: 1 });
    });

    it("matches the same words in another order", () => {
        const p = scoreBook(
            [{ name: "Effects: Glow – Arm", type: "RollTable", system: {} }],
            [{ name: "Glow Effects - Arm", type: "RollTable", system: {} }],
            "dh2",
        );
        expect(p.types["RollTable"]?.tiers).toEqual({ words: 1 });
    });

    it("compares a leaf the output leaves out at the schema's initial value", () => {
        const p = scoreBook(
            [{ name: "Club", type: "weapon", system: { type: "primitive" } }],
            [{ name: "Club", type: "weapon", system: {} }],
            "dh2",
        );
        expect(p.types["weapon"]?.fields["type"]).toEqual({ checks: 1, score: 1 });
        // The damage template's type and other required choices load at their initial values too.
        const q = scoreBook(
            [{ name: "Wick Round", type: "ammunition", system: { damage: { type: "impact" } } }],
            [{ name: "Wick Round", type: "ammunition", system: {} }],
            "dh2",
        );
        expect(q.types["ammunition"]?.fields["damage.type"]).toEqual({ checks: 1, score: 1 });
        // The physical-item template's rarity, and armour's modification slots.
        const r = scoreBook(
            [{ name: "Ward Coat", type: "armour", system: { availability: "common", modificationSlots: 2 } }],
            [{ name: "Ward Coat", type: "armour", system: {} }],
            "dh2",
        );
        expect(r.types["armour"]?.fields["availability"]).toEqual({ checks: 1, score: 1 });
        expect(r.types["armour"]?.fields["modificationSlots"]).toEqual({ checks: 1, score: 1 });
    });

    it("leaves out legacy keys the schema strips on load, with every leaf beneath them", () => {
        const p = scoreBook(
            [
                {
                    name: "Steady Course",
                    type: "navigatorPower",
                    system: {
                        sustain: "Yes",
                        rollConfig: { characteristic: "perception" },
                        novice: "Hold the lamp.",
                    },
                },
            ],
            [{ name: "Steady Course", type: "navigatorPower", system: { sustain: "Yes" } }],
            "rt",
        );
        expect(Object.keys(p.types["navigatorPower"]?.fields ?? {}).sort()).toEqual(["name", "sustain"]);
    });

    it("compares a legacy NPC movement and armour line as the system loads them", () => {
        expect(asLoaded("npc", { move: "3/6/9/18", armourPoints: "H2 B4" })).toEqual({
            movement: { half: 3, full: 6, charge: 9, run: 18 },
            movementManual: true,
            armour: {
                mode: "locations",
                total: 4,
                authored: true,
                locations: { head: 2, body: 4, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 },
            },
        });
        const p = scoreBook(
            [{ name: "Lamp Thief", type: "dh2-npc", system: { move: "3/6/9/18" } }],
            [
                {
                    name: "Lamp Thief",
                    type: "dh2-npc",
                    system: { movement: { half: 3, full: 6, charge: 9, run: 18 }, movementManual: true },
                },
            ],
            "dh2",
        );
        expect(p.types["npc"]?.docScore).toBe(1);
    });

    it("leaves out legacy keys the schema drops", () => {
        const p = scoreBook(
            [{ name: "Glow", type: "psychicPower", system: { focusTime: "Half Action" } }],
            [{ name: "Glow", type: "psychicPower", system: {} }],
            "dh2",
        );
        expect(p.types["psychicPower"]?.fields["focusTime"]).toBeUndefined();
    });

    it("measures edit distance with an early stop", () => {
        expect(editDistance("kitten", "sitting", 5)).toBe(3);
        expect(editDistance("abc", "abcdefgh", 2)).toBe(3);
    });

    it("scores an actor's embedded items per type", () => {
        const p = scoreBook(
            [{ name: "A", type: "npc", system: {}, items: [{ name: "Knife", type: "weapon" }] }],
            [{ name: "A", type: "npc", system: {}, items: [] }],
            "dh2",
        );
        expect(p.types["npc"]?.fields["items.weapon"]).toEqual({ checks: 1, score: 0 });
    });
});
