// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { emit, serializeDocument } from "../../src/stages/emit.ts";
import type { Entity, EntityGraph } from "../../src/types/entity.ts";

function entity(over: Partial<Entity> = {}): Entity {
    return {
        blockId: "statblock",
        documentType: "Actor",
        pack: "bestiary",
        group: "examples",
        ordinal: 0,
        fields: { name: "Glimmerfin Drake", "system.ac": 14 },
        images: {},
        enrichmentRequests: [],
        enrichmentFields: {},
        provenance: { pageIndex: 0, y: 700 },
        ...over,
    };
}

function graph(entities: Entity[]): EntityGraph {
    return { entities, warnings: [] };
}

const CFG = { assetRefPrefix: "systems/x/packs/images" };

describe("serializeDocument", () => {
    it("byte-sorts keys, indents 4, ends with a single LF newline", () => {
        const out = serializeDocument({ b: 1, a: { d: 2, c: 3 } });
        expect(out).toBe('{\n    "a": {\n        "c": 3,\n        "d": 2\n    },\n    "b": 1\n}\n');
        expect(out.endsWith("}\n")).toBe(true);
        expect(out.includes("\r")).toBe(false);
    });
});

describe("emit", () => {
    it("produces a valid Foundry _id, zeroed _stats, strided sort, and slug_id filename", () => {
        const result = emit(graph([entity({ ordinal: 2 })]), new Map(), CFG);
        expect(result.files).toHaveLength(1);
        const file = result.files[0]!;
        const doc = JSON.parse(file.contents) as Record<string, unknown>;
        expect(doc["_id"]).toMatch(/^[a-zA-Z0-9]{16}$/);
        expect(doc["_stats"]).toEqual({ createdTime: 0, modifiedTime: 0 });
        expect(doc["sort"]).toBe(200000);
        expect(file.relPath).toBe(`examples/bestiary/_source/glimmerfin-drake_${doc["_id"] as string}.json`);
    });

    it("keeps _id and filename identical whether or not enrichment fields are present (§9.1/§10.6)", () => {
        const plain = emit(graph([entity()]), new Map(), CFG).files[0]!;
        const enriched = emit(
            graph([entity({ enrichmentFields: { "flags.x.wikiImage": "https://example.invalid/i.png" } })]),
            new Map(),
            CFG,
        ).files[0]!;
        expect(enriched.relPath).toBe(plain.relPath);
        expect((JSON.parse(enriched.contents) as Record<string, unknown>)["_id"]).toBe(
            (JSON.parse(plain.contents) as Record<string, unknown>)["_id"],
        );
        // The link is present in the enriched doc only.
        expect(enriched.contents).toContain("wikiImage");
        expect(plain.contents).not.toContain("wikiImage");
    });

    it("hashes image references by content-address, so the deployment prefix never forks _ids", () => {
        const withImage = entity({ images: { img: "AbCdEf0123456789" } });
        const assetExt = new Map([["AbCdEf0123456789", "png"]]);
        const a = emit(graph([withImage]), assetExt, { assetRefPrefix: "systems/a/img" }).files[0]!;
        const b = emit(graph([withImage]), assetExt, { assetRefPrefix: "totally/different/prefix" })
            .files[0]!;
        const idA = (JSON.parse(a.contents) as Record<string, unknown>)["_id"];
        const idB = (JSON.parse(b.contents) as Record<string, unknown>)["_id"];
        expect(idA).toBe(idB);
        // But the actual stored img path DOES reflect the prefix.
        expect(a.contents).toContain("systems/a/img/AbCdEf0123456789.png");
        expect(b.contents).toContain("totally/different/prefix/AbCdEf0123456789.png");
    });

    it("disambiguates a within-pack _id collision deterministically", () => {
        // Two entities with identical content but different ordinals must not collide.
        const dup1 = entity({ ordinal: 0 });
        const dup2 = entity({ ordinal: 1 });
        const result = emit(graph([dup1, dup2]), new Map(), CFG);
        const ids = result.files.map((f) => (JSON.parse(f.contents) as Record<string, unknown>)["_id"]);
        expect(new Set(ids).size).toBe(2);
    });
});
