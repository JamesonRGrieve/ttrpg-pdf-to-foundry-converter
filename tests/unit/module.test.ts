// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    buildModule,
    MODULE_ASSET_PLACEHOLDER,
    type ModuleInput,
    SYSTEM_ID,
} from "../../src/stages/module.ts";
import { RELEASE_FEED_URL } from "../../src/version.ts";

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
        provenance: { release: "2000-01-02-03-04", target: "dh2" },
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
            `${module.id}/scripts/update-check.js`,
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

    it("versions the module by the converter release, on the manifest and every pack", () => {
        const module = buildModule(input());
        const manifest = JSON.parse(text(module.files[1]?.contents ?? "")) as {
            title: string;
            version: string;
            esmodules: string[];
            packs: { flags: Record<string, { release: string }> }[];
        };
        expect(manifest.version).toBe("2000-01-02-03-04");
        expect(manifest.title).toBe("PDF Compendium: lamps (2000-01-02-03-04)");
        expect(manifest.packs.map((p) => p.flags["foundry-pdf-parser"]?.release)).toEqual([
            "2000-01-02-03-04",
            "2000-01-02-03-04",
        ]);
        expect(manifest.esmodules).toEqual(["scripts/update-check.js"]);
    });

    it("ships an update check that reads only the published release and can be hidden", () => {
        const script = text(
            buildModule(input()).files.find((f) => f.relPath.endsWith("update-check.js"))?.contents ?? "",
        );
        expect(script).toContain(RELEASE_FEED_URL);
        expect(script).toContain('name="hide"');
        expect(script).toContain("game.user?.isGM");
        // The script parses (the template it is built from broke no syntax).
        expect(() => new Function(script)).not.toThrow();
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
