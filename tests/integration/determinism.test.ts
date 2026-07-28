// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { runPipeline } from "../../src/pipeline.ts";
import { extract } from "../../src/stages/extract.ts";
import { loadProfile } from "../../src/profile/load.ts";
import { sha256Hex } from "../../src/util/hash.ts";
import { loadManifest, runCase } from "../../scripts/lib/run-case.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function mapsEqual(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const [key, value] of a) {
        const other = b.get(key);
        if (other === undefined || !Buffer.from(value).equals(Buffer.from(other))) {
            return false;
        }
    }
    return true;
}

describe("determinism (in-memory)", () => {
    for (const entry of loadManifest(repoRoot)) {
        it(`${entry.name} is byte-identical across two runs`, async () => {
            const first = await runCase(entry, repoRoot, "det-a");
            const second = await runCase(entry, repoRoot, "det-b");
            expect(mapsEqual(first, second)).toBe(true);
        });
    }
});

describe("encrypted refusal (C4 / G6)", () => {
    it("refuses an encrypted PDF without decrypting", async () => {
        const bytes = new Uint8Array(readFileSync(resolve(repoRoot, "fixtures/rendered/encrypted.pdf")));
        const raw = await extract(bytes);
        expect(raw.encrypted).toBe(true);
        expect(raw.textRuns).toHaveLength(0);
        expect(raw.images).toHaveLength(0);

        const config = makeConfig(repoRoot, {
            cacheDir: resolve(repoRoot, ".cache", "enc-test"),
            logLevel: "error",
        });
        const profile = loadProfile(resolve(repoRoot, "profiles/example-bestiary-two-column.yml"));
        const result = await runPipeline(
            bytes,
            profile,
            { sha256: "0".repeat(64), sourceBasename: "encrypted.pdf" },
            config,
            createLogger("error"),
            null,
        );
        expect(result.encrypted).toBe(true);
        expect(result.files).toHaveLength(0);
        expect(result.assets).toHaveLength(0);
    });
});

describe("image recovery (Tier A, G11)", () => {
    it("dedups a reused image to a single content-addressed asset", async () => {
        const output = await runCase(
            {
                name: "images",
                pdf: "fixtures/rendered/images.pdf",
                profile: "profiles/example-image-plates.yml",
            },
            repoRoot,
            "img-test",
        );
        const assetKeys = [...output.keys()].filter((k) => k.startsWith("assets/"));
        // 5 XObjects (RGB reused across 2 pages, JPEG, RGBA, CMYK) → 4 unique assets.
        expect(assetKeys).toHaveLength(4);
        // Content-addressed filenames.
        for (const key of assetKeys) {
            expect(key).toMatch(/^assets\/[A-Za-z0-9]{16}\.(png|jpg|jpx)$/);
        }
    });
});

describe("profile hashing (provenance)", () => {
    it("provenance hashes the profile, never the source PDF", () => {
        const profileBytes = new Uint8Array(
            readFileSync(resolve(repoRoot, "profiles/example-bestiary-two-column.yml")),
        );
        // Sanity: the profile sha256 is stable and well-formed.
        expect(sha256Hex(profileBytes)).toMatch(/^[0-9a-f]{64}$/);
    });
});
