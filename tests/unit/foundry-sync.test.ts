// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    canonicalContent,
    documentKeys,
    type ExistingDocument,
    type IncomingDocument,
    PACKAGE_ID,
    planPack,
    pointAtWorld,
    REMOVAL_KEPT,
    readConvertedModule,
    type SourceDocument,
} from "../../foundry/sync.ts";

const doc = (id: string, name: string, extra: Record<string, unknown> = {}): SourceDocument => ({
    _id: id.padEnd(16, "x"),
    name,
    type: "weapon",
    ...extra,
});

const incoming = (source: SourceDocument, hash: string, key?: string): IncomingDocument => ({
    key: key ?? documentKeys("Item", [source])[0] ?? "",
    sourceHash: hash,
    source,
});

/** A world document imported with `hash`, edited since or not. */
const imported = (id: string, name: string, hash: string, edited = false): ExistingDocument => ({
    _id: id.padEnd(16, "w"),
    name,
    flags: { key: `Item|weapon|${name.toLowerCase()}`, sourceHash: hash, fingerprint: "fp", release: "r1" },
    currentFingerprint: edited ? "fp-edited" : "fp",
});

describe("planning an import into a world pack", () => {
    it("keys documents by type and name, numbering repeats", () => {
        expect(documentKeys("Item", [doc("a", "Lamp  Gun"), doc("b", "lamp gun"), doc("c", "Wick")])).toEqual(
            ["Item|weapon|lamp gun", "Item|weapon|lamp gun#2", "Item|weapon|wick"],
        );
    });

    it("creates new documents, leaves unchanged ones, replaces unedited changed ones and removes dropped ones", () => {
        const plan = planPack(
            [
                incoming(doc("n1", "New Lamp"), "h-new"),
                incoming(doc("s1", "Same Lamp"), "h-same"),
                incoming(doc("c1", "Changed Lamp"), "h2"),
            ],
            [
                imported("s", "Same Lamp", "h-same"),
                imported("c", "Changed Lamp", "h1"),
                imported("d", "Dropped Lamp", "h3"),
            ],
        );
        expect(plan.create.map((d) => d.source.name)).toEqual(["New Lamp"]);
        expect(plan.unchanged).toBe(1);
        expect(plan.replace.map((r) => [r.existingId, r.incoming.source.name])).toEqual([
            ["cwwwwwwwwwwwwwww", "Changed Lamp"],
        ]);
        expect(plan.remove).toEqual(["dwwwwwwwwwwwwwww"]);
        expect(plan.conflicts).toEqual([]);
        // References follow each document to the id it lives under in the world.
        expect(plan.idMap.get("c1xxxxxxxxxxxxxx")).toBe("cwwwwwwwwwwwwwww");
        expect(plan.idMap.get("n1xxxxxxxxxxxxxx")).toBe("n1xxxxxxxxxxxxxx");
    });

    it("raises an edited document the converter changed or dropped as a conflict", () => {
        const plan = planPack(
            [incoming(doc("c1", "Changed Lamp"), "h2")],
            [imported("c", "Changed Lamp", "h1", true), imported("d", "Dropped Lamp", "h3", true)],
        );
        expect(plan.conflicts.map((c) => [c.kind, c.name])).toEqual([
            ["changed", "Changed Lamp"],
            ["removed", "Dropped Lamp"],
        ]);
        expect(plan.replace).toEqual([]);
        expect(plan.remove).toEqual([]);
    });

    it("does not ask again about an edit already kept, nor touch the user's own documents", () => {
        const kept = { ...imported("d", "Dropped Lamp", REMOVAL_KEPT, true) };
        const own: ExistingDocument = {
            _id: "u".repeat(16),
            name: "Homemade",
            flags: null,
            currentFingerprint: "x",
        };
        // An edited document whose converter output has not changed since it was kept stays quiet.
        const plan = planPack(
            [incoming(doc("c1", "Changed Lamp"), "h1")],
            [imported("c", "Changed Lamp", "h1", true), kept, own],
        );
        expect(plan.conflicts).toEqual([]);
        expect(plan.remove).toEqual([]);
        expect(plan.unchanged).toBe(1);
    });

    it("gives a new document another id when a user's document holds its id", () => {
        const own: ExistingDocument = {
            _id: "n1xxxxxxxxxxxxxx",
            name: "Homemade",
            flags: null,
            currentFingerprint: "x",
        };
        const plan = planPack([incoming(doc("n1", "New Lamp"), "h")], [own]);
        const id = plan.idMap.get("n1xxxxxxxxxxxxxx");
        expect(id).toHaveLength(16);
        expect(id).not.toBe("n1xxxxxxxxxxxxxx");
    });
});

describe("fingerprints and pointing documents at the world", () => {
    it("reduces a document to its content: keys sorted, ids, stats, placement and the package's flags dropped", () => {
        const a = {
            name: "Lamp",
            _id: "1",
            _stats: { modifiedTime: 1 },
            sort: 5,
            flags: { [PACKAGE_ID]: { key: "k" }, other: 1 },
            items: [{ _id: "2", b: 1, a: 2 }],
        };
        const b = { items: [{ a: 2, b: 1, _id: "9" }], flags: { other: 1 }, name: "Lamp", _id: "3", sort: 9 };
        expect(canonicalContent(a)).toBe(canonicalContent(b));
        expect(canonicalContent({ ...b, name: "Wick" })).not.toBe(canonicalContent(b));
    });

    it("points compendium references and asset paths at the world", () => {
        const source = {
            img: "modules/pdf-compendium-dh2-abc/assets/plate.png",
            system: {
                text: "@UUID[Compendium.pdf-compendium-dh2-abc.dh2-lamps-items-weapons.Item.AAAAAAAAAAAAAAAA]",
            },
        };
        const map = new Map([["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"]]);
        expect(
            pointAtWorld(source, "pdf-compendium-dh2-abc", map, "worlds/w/ttrpg-pdf-converter/assets"),
        ).toEqual({
            img: "worlds/w/ttrpg-pdf-converter/assets/plate.png",
            system: { text: "@UUID[Compendium.world.dh2-lamps-items-weapons.Item.BBBBBBBBBBBBBBBB]" },
        });
    });
});

describe("reading a converted module's files", () => {
    it("reads packs from module.json and their NeDB files, and the images", () => {
        const manifest = {
            id: "pdf-compendium-dh2-abc",
            title: "PDF Compendium: lamps (r1)",
            version: "r1",
            packs: [
                {
                    name: "dh2-lamps-items-weapons",
                    label: "Lamps Items Weapons",
                    type: "Item",
                    path: "packs/dh2-lamps-items-weapons",
                    flags: { "wh40k-rpg": { line: "dh2" } },
                },
            ],
        };
        const module = readConvertedModule([
            { relPath: "pdf-compendium-dh2-abc/module.json", contents: JSON.stringify(manifest) },
            {
                relPath: "pdf-compendium-dh2-abc/packs/dh2-lamps-items-weapons.db",
                contents: `${JSON.stringify(doc("a", "Lamp Gun"))}\n${JSON.stringify(doc("b", "Wick Pistol"))}\n`,
            },
            { relPath: "pdf-compendium-dh2-abc/assets/plate.png", contents: new Uint8Array([1, 2]) },
        ]);
        expect(module.release).toBe("r1");
        expect(module.packs[0]?.documents.map((d) => d.name)).toEqual(["Lamp Gun", "Wick Pistol"]);
        expect(module.packs[0]?.flags).toEqual({ "wh40k-rpg": { line: "dh2" } });
        expect([...module.assets.keys()]).toEqual(["plate.png"]);
    });
});
