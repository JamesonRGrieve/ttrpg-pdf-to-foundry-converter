// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifest, runCase } from "../../scripts/lib/run-case.ts";
import { createLogger } from "../../src/logger.ts";
import { MemoryOcrPageStore } from "../../src/ocr/recognize.ts";
import type { OcrEngine } from "../../src/ocr/types.ts";
import { runEngine } from "../../src/run.ts";
import { extract } from "../../src/stages/extract.ts";

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
        it(`${entry.name} is byte-identical across two cold runs`, async () => {
            const first = await runCase(entry, repoRoot, "det-a");
            const second = await runCase(entry, repoRoot, "det-b");
            expect(mapsEqual(first, second)).toBe(true);
        });
    }
});

describe("encrypted refusal", () => {
    it("refuses an encrypted PDF without decrypting or recognizing anything", async () => {
        const bytes = new Uint8Array(readFileSync(resolve(repoRoot, "fixtures/rendered/encrypted.pdf")));
        const raw = await extract(bytes);
        expect(raw.encrypted).toBe(true);
        expect(raw.textRuns).toHaveLength(0);
        expect(raw.images).toHaveLength(0);

        let recognized = 0;
        const ocr: OcrEngine = {
            id: "refusal-probe",
            recognize: async () => {
                recognized += 1;
                return [];
            },
            close: async () => undefined,
        };
        const result = await runEngine(bytes, {
            ocr,
            ocrStore: new MemoryOcrPageStore(),
            maxInFlight: 1,
            assetRefPrefix: "x",
            log: createLogger("error"),
        });
        expect(result.encrypted).toBe(true);
        expect(recognized).toBe(0);
    });
});

describe("image recovery (Tier A)", () => {
    it("dedups a reused image to a single content-addressed asset", async () => {
        const output = await runCase(
            { name: "images", pdf: "fixtures/rendered/images.pdf" },
            repoRoot,
            "img-test",
        );
        const assetKeys = [...output.keys()].filter((k) => k.startsWith("assets/"));
        // 5 XObjects (RGB reused across 2 pages, JPEG, RGBA, CMYK) → 4 unique assets.
        expect(assetKeys).toHaveLength(4);
        for (const key of assetKeys) {
            expect(key).toMatch(/^assets\/[A-Za-z0-9]{16}\.(png|jpg|jpx)$/);
        }
    });
});
