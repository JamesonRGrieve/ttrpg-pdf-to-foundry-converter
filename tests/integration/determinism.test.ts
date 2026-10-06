// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifest, runCase } from "../../scripts/lib/run-case.ts";
import { DEFAULT_TARGET } from "../../src/infer/targets.ts";
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

/**
 * A case runs the whole engine twice, recognizing a scanned fixture's pages in every pass when cold.
 * The cases run concurrently, so on a small CI runner (macOS: 3 cores) the scanned case's two OCR
 * passes share the machine with every other case; it has needed more than 120 s there.
 */
const CASE_TIMEOUT_MS = 300_000;

// Cases run side by side: each is its own engine run, sharing nothing.
describe.concurrent("determinism (in-memory)", () => {
    for (const entry of loadManifest(repoRoot)) {
        it(`${entry.name} is byte-identical across two cold runs`, { timeout: CASE_TIMEOUT_MS }, async () => {
            const first = await runCase(entry, repoRoot, "det-a");
            const second = await runCase(entry, repoRoot, "det-b");
            expect(mapsEqual(first, second)).toBe(true);
        });
    }
});

// These extract real PDFs, so they share the suite's load with the concurrent cases above.
describe("encrypted refusal", { timeout: CASE_TIMEOUT_MS }, () => {
    it("refuses an encrypted PDF without decrypting or recognizing anything", async () => {
        const bytes = new Uint8Array(readFileSync(resolve(repoRoot, "fixtures/rendered/encrypted.pdf")));
        const raw = await extract(bytes);
        expect(raw.encrypted).toBe(true);
        expect(raw.textRuns).toHaveLength(0);
        expect(raw.images).toHaveLength(0);

        let recognized = 0;
        const ocr: OcrEngine = {
            id: "refusal-probe",
            sparseId: "refusal-probe-sparse",
            recognize: async () => {
                recognized += 1;
                return [];
            },
            recognizeSparse: async () => {
                recognized += 1;
                return [];
            },
            cellId: "refusal-probe-cell",
            recognizeCell: async () => {
                recognized += 1;
                return [];
            },
            close: async () => undefined,
        };
        const scanReader = {
            id: "refusal-probe-reader",
            read: async () => {
                recognized += 1;
                return [];
            },
        };
        const result = await runEngine(bytes, {
            target: DEFAULT_TARGET,
            ocr,
            scanReader,
            ocrStore: new MemoryOcrPageStore(),
            maxInFlight: 1,
            assetRefPrefix: "x",
            log: createLogger("error"),
        });
        expect(result.encrypted).toBe(true);
        expect(recognized).toBe(0);
    });

    it("reads a PDF whose encryption only restricts permissions (no password to open)", async () => {
        const fixture = (name: string): Uint8Array =>
            new Uint8Array(readFileSync(resolve(repoRoot, "fixtures/rendered", name)));
        const open = await extract(fixture("field-manual.pdf"));
        const restricted = await extract(fixture("restricted.pdf"));
        expect(restricted.encrypted).toBe(false);
        expect(restricted.textRuns.map((r) => r.text)).toEqual(open.textRuns.map((r) => r.text));
    });
});

describe("image recovery (Tier A)", () => {
    it("dedups a reused image to a single content-addressed asset", async () => {
        const output = await runCase(
            { name: "images", pdfs: ["fixtures/rendered/images.pdf"] },
            repoRoot,
            "img-test",
        );
        const assetKeys = [...output.keys()].filter((k) => k.includes("/assets/"));
        // 5 XObjects (RGB reused across 2 pages, JPEG, RGBA, CMYK) → 4 unique assets.
        expect(assetKeys).toHaveLength(4);
        for (const key of assetKeys) {
            expect(key).toMatch(/^pdf-compendium-dh2-[0-9a-f]{12}\/assets\/[A-Za-z0-9]{16}\.(png|jpg|jpx)$/);
        }
    });
});
