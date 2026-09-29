// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { emit } from "../../src/stages/emit.ts";
import type { Entity, EntityGraph, JsonObject } from "../../src/types/entity.ts";
import { at } from "../../src/util/at.ts";

function entity(over: Partial<Entity> = {}): Entity {
    return {
        blockId: "statblock",
        documentType: "Actor",
        pack: "bestiary",
        group: "examples",
        ordinal: 0,
        fields: { name: "Glimmerfin Drake", "system.ac": 14 },
        images: {},
        provenance: { pageIndex: 0, y: 700 },
        ...over,
    };
}

function graph(entities: Entity[]): EntityGraph {
    return { entities, warnings: [] };
}

const CFG = { assetRefPrefix: "systems/x/packs/images" };

/** The documents emitted into the one pack the test entities use. */
function documents(entities: Entity[], assetExt = new Map<string, string>(), cfg = CFG): JsonObject[] {
    return emit(graph(entities), assetExt, cfg).packs.get("examples/bestiary")?.documents ?? [];
}

describe("emit", () => {
    it("produces a valid Foundry _id, zeroed _stats and a strided sort, grouped by pack", () => {
        const result = emit(graph([entity({ ordinal: 2 })]), new Map(), CFG);
        expect([...result.packs.keys()]).toEqual(["examples/bestiary"]);
        const pack = result.packs.get("examples/bestiary");
        expect(pack?.documentType).toBe("Actor");
        const doc = at(pack?.documents ?? [], 0);
        expect(doc["_id"]).toMatch(/^[a-zA-Z0-9]{16}$/);
        expect(doc["_stats"]).toEqual({ createdTime: 0, modifiedTime: 0 });
        expect(doc["sort"]).toBe(200000);
        expect(doc["name"]).toBe("Glimmerfin Drake");
    });

    it("hashes image references by content-address, so the deployment prefix never forks _ids", () => {
        const withImage = entity({ images: { img: "AbCdEf0123456789" } });
        const assetExt = new Map([["AbCdEf0123456789", "png"]]);
        const a = at(documents([withImage], assetExt, { assetRefPrefix: "systems/a/img" }), 0);
        const b = at(documents([withImage], assetExt, { assetRefPrefix: "totally/different/prefix" }), 0);
        expect(a["_id"]).toBe(b["_id"]);
        // But the actual stored img path DOES reflect the prefix.
        expect(a["img"]).toBe("systems/a/img/AbCdEf0123456789.png");
        expect(b["img"]).toBe("totally/different/prefix/AbCdEf0123456789.png");
    });

    it("disambiguates a within-pack _id collision deterministically", () => {
        // Two entities with identical content but different ordinals must not collide.
        const ids = documents([entity({ ordinal: 0 }), entity({ ordinal: 1 })]).map((d) => d["_id"]);
        expect(new Set(ids).size).toBe(2);
    });
});
