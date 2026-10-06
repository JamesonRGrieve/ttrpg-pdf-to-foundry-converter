// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    buildModule,
    MODULE_ASSET_PLACEHOLDER,
    type ModuleInput,
    SYSTEM_ID,
} from "../../src/stages/module.ts";

const doc = (id: string, name: string, img?: string) => ({
    _id: id,
    name,
    ...(img === undefined ? {} : { img }),
});

function input(over: Partial<ModuleInput> = {}): ModuleInput {
    return {
        system: SYSTEM_ID,
        packs: [
            {
                name: "dh2-lamps-items-gear",
                label: "Lamps Items Gear",
                documentType: "Item",
                documents: [
                    doc("bbbbbbbbbbbbbbbb", "Wick"),
                    doc("aaaaaaaaaaaaaaaa", "Lantern", `${MODULE_ASSET_PLACEHOLDER}/x1.png`),
                ],
            },
            {
                name: "dh2-lamps-actors-bestiary",
                label: "Lamps Actors Bestiary",
                documentType: "Actor",
                documents: [doc("cccccccccccccccc", "Moth")],
            },
        ],
        assets: [{ relPath: "x1.png", bytes: new Uint8Array([1, 2, 3]) }],
        sources: ["lamps"],
        provenance: { engineVersion: "9.9.9", target: "dh2" },
        ...over,
    };
}

const text = (contents: string | Uint8Array): string =>
    typeof contents === "string" ? contents : new TextDecoder().decode(contents);

describe("module packaging", () => {
    it("writes a manifest exposing each pack to the system, NeDB packs and the assets", () => {
        const module = buildModule(input());
        expect(module.id).toMatch(/^pdf-compendium-[0-9a-f]{12}$/);
        expect(module.files.map((f) => f.relPath)).toEqual([
            `${module.id}/assets/x1.png`,
            `${module.id}/module.json`,
            `${module.id}/packs/dh2-lamps-actors-bestiary.db`,
            `${module.id}/packs/dh2-lamps-items-gear.db`,
        ]);
        const manifest = JSON.parse(text(module.files[1]?.contents ?? "")) as Record<string, unknown>;
        expect(manifest["id"]).toBe(module.id);
        expect(manifest["relationships"]).toEqual({ systems: [{ id: SYSTEM_ID, type: "system" }] });
        expect(manifest["packs"]).toEqual([
            expect.objectContaining({
                name: "dh2-lamps-actors-bestiary",
                path: "packs/dh2-lamps-actors-bestiary",
                type: "Actor",
                system: SYSTEM_ID,
            }),
            expect.objectContaining({ name: "dh2-lamps-items-gear", type: "Item", system: SYSTEM_ID }),
        ]);
    });

    it("writes one document per line, by _id, with images pointed into the module", () => {
        const module = buildModule(input());
        const gear = module.files.find((f) => f.relPath.endsWith("dh2-lamps-items-gear.db"));
        const lines = text(gear?.contents ?? "")
            .trimEnd()
            .split("\n");
        expect(lines.map((l) => (JSON.parse(l) as { name: string }).name)).toEqual(["Lantern", "Wick"]);
        expect(lines[0]).toContain(`"img":"modules/${module.id}/assets/x1.png"`);
    });

    it("gives the same bytes whatever order the documents arrive in, and merges a pack read twice", () => {
        const base = input();
        const [gear, bestiary] = base.packs;
        if (gear === undefined || bestiary === undefined) {
            throw new Error("two packs expected");
        }
        const reordered = buildModule({
            ...base,
            packs: [bestiary, { ...gear, documents: [...gear.documents].reverse() }, gear],
        });
        expect(reordered).toEqual(buildModule(base));
    });

    it("gives distinct content distinct module ids, so modules install side by side", () => {
        const other = input({ assets: [{ relPath: "x2.png", bytes: new Uint8Array([9]) }] });
        expect(buildModule(other).id).not.toBe(buildModule(input()).id);
    });
});
