// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Line } from "../../src/infer/schema.ts";
import { danglingTarget, targetedInputs } from "../../src/node/target-args.ts";
import type { EmittedPack } from "../../src/stages/emit.ts";
import { homologate, type LineDocuments } from "../../src/stages/homologate.ts";
import type { JsonObject } from "../../src/types/entity.ts";

/** A line's reading of one pack holding the given documents. */
function reading(
    line: Line,
    docs: JsonObject[],
    category = "items-skills",
    documentType: EmittedPack["documentType"] = "Item",
): LineDocuments {
    const name = `${line}-book-${category}`;
    return { line, packs: [{ group: line, pack: name, documentType, documents: docs }] };
}

/** A skill as one line prints it. */
function skill(line: Line, id: string, characteristic: string, uses: string): JsonObject {
    return {
        _id: id,
        name: "Lamp Lore",
        type: "skill",
        sort: 100,
        system: {
            characteristic,
            aptitudes: ["Intelligence"],
            uses: { [line]: uses },
            description: { [line]: { value: `<p>${line} prose</p>` } },
            source: { [line]: { provenance: "raw", book: `${line} book`, page: "7" } },
            gameSystems: [line],
        },
    };
}

const docsOf = (r: LineDocuments | undefined): JsonObject[] => r?.packs[0]?.documents ?? [];

describe("homologation", () => {
    it("merges a skill printed in two lines into the newer line's document", () => {
        const [older, newer] = homologate([
            reading("rt", [skill("rt", "rtid", "intelligence", "Tend lamps.")]),
            reading("dh2", [skill("dh2", "dh2id", "intelligence", "Trim wicks.")]),
        ]);
        const [a] = docsOf(older);
        const [b] = docsOf(newer);
        // One document, in both lines' packs, keeping the newest line's identity.
        expect(a).toEqual(b);
        expect(a?.["_id"]).toBe("dh2id");
        expect(a?.["system"]).toEqual({
            characteristic: "intelligence",
            aptitudes: ["Intelligence"],
            uses: { dh2: "Trim wicks.", rt: "Tend lamps." },
            description: { dh2: { value: "<p>dh2 prose</p>" }, rt: { value: "<p>rt prose</p>" } },
            source: {
                dh2: { provenance: "raw", book: "dh2 book", page: "7" },
                rt: { provenance: "raw", book: "rt book", page: "7" },
            },
            gameSystems: ["dh2", "rt"],
        });
    });

    it("keeps a value each line prints differently per line", () => {
        const rt = skill("rt", "rtid", "intelligence", "Tend lamps.");
        const dh2 = skill("dh2", "dh2id", "intelligence", "Trim wicks.");
        Object(dh2["system"])["aptitudes"] = ["Intelligence", "Knowledge"];
        const [merged] = docsOf(homologate([reading("rt", [rt]), reading("dh2", [dh2])])[0]);
        expect(Object(merged?.["system"])["aptitudes"]).toEqual({
            dh2: ["Intelligence", "Knowledge"],
            rt: ["Intelligence"],
        });
    });

    it("keeps a skill's characteristic per line when the lines test it differently", () => {
        const [merged] = docsOf(
            homologate([
                reading("rt", [skill("rt", "rtid", "fellowship", "Haggle.")]),
                reading("dh2", [skill("dh2", "dh2id", "intelligence", "Appraise.")]),
            ])[0],
        );
        const system = Object(merged?.["system"]);
        expect(system["characteristic"]).toEqual({ dh2: "intelligence", rt: "fellowship" });
    });

    it("never merges by name alone", () => {
        // Identity fields disagree: a pistol and a basic weapon of one name are two weapons.
        const weapon = (line: Line, id: string, cls: string): JsonObject => ({
            ...skill(line, id, "x", "y"),
            type: "weapon",
            system: { class: cls, source: { [line]: { provenance: "raw", book: "b", page: "1" } } },
        });
        const apart = homologate([
            reading("rt", [weapon("rt", "rtid", "pistol")], "items-weapons"),
            reading("dh2", [weapon("dh2", "dh2id", "basic")], "items-weapons"),
        ]);
        expect(docsOf(apart[0])[0]?.["_id"]).toBe("rtid");
        expect(docsOf(apart[1])[0]?.["_id"]).toBe("dh2id");
        // A kind with no identity fields listed is never merged.
        const gear = (line: Line, id: string): JsonObject => ({ ...skill(line, id, "x", "y"), type: "gear" });
        const kept = homologate([reading("rt", [gear("rt", "g1")]), reading("dh2", [gear("dh2", "g2")])]);
        expect(docsOf(kept[0])[0]?.["_id"]).toBe("g1");
        // Two readings from one line leave the entity alone.
        const twice = homologate([
            reading("dh2", [skill("dh2", "a", "intelligence", "u")]),
            reading("dh2", [skill("dh2", "b", "intelligence", "u")]),
            reading("rt", [skill("rt", "c", "intelligence", "u")]),
        ]);
        expect(twice.map((r) => docsOf(r)[0]?.["_id"])).toEqual(["a", "b", "c"]);
    });

    it("merges line-registered actor types of one kind", () => {
        const npc = (line: Line, id: string): JsonObject => ({
            _id: id,
            name: "Lamplighter",
            type: `${line}-npc`,
            system: { source: { [line]: { provenance: "raw", book: "b", page: "1" } }, gameSystems: [line] },
        });
        const [older] = homologate([
            reading("rt", [npc("rt", "r")], "actors-bestiary", "Actor"),
            reading("bc", [npc("bc", "b")], "actors-bestiary", "Actor"),
        ]);
        const [merged] = docsOf(older);
        expect(merged?.["_id"]).toBe("b");
        expect(merged?.["type"]).toBe("bc-npc");
        expect(Object.keys(Object(Object(merged?.["system"])["source"]))).toEqual(["bc", "rt"]);
    });

    it("does not depend on the order the readings are given", () => {
        const a = reading("rt", [skill("rt", "rtid", "intelligence", "Tend lamps.")]);
        const b = reading("dh2", [skill("dh2", "dh2id", "intelligence", "Trim wicks.")]);
        const forward = homologate([a, b]).map((r) => JSON.stringify(docsOf(r)));
        const backward = homologate([b, a]).map((r) => JSON.stringify(docsOf(r)));
        expect(new Set(forward)).toEqual(new Set(backward));
    });
});

describe("per-input targets", () => {
    it("applies each --target to the inputs after it", () => {
        expect(
            targetedInputs([
                { kind: "positional", value: "a.pdf" },
                { kind: "option", name: "target", value: "rt" },
                { kind: "positional", value: "b.pdf" },
                { kind: "positional", value: "c.pdf" },
                { kind: "option", name: "out-dir", value: "/tmp/x" },
                { kind: "option", name: "target", value: "dw" },
                { kind: "positional", value: "d.pdf" },
            ]),
        ).toEqual([
            { input: "a.pdf", targetId: undefined },
            { input: "b.pdf", targetId: "rt" },
            { input: "c.pdf", targetId: "rt" },
            { input: "d.pdf", targetId: "dw" },
        ]);
    });

    it("finds a --target given after every input", () => {
        const pdf = { kind: "positional", value: "a.pdf" } as const;
        const target = { kind: "option", name: "target", value: "rt" } as const;
        expect(danglingTarget([pdf, target])).toBe(true);
        expect(danglingTarget([target, pdf])).toBe(false);
        expect(danglingTarget([pdf])).toBe(false);
    });
});
