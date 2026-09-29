// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TARGET } from "../../src/infer/targets.ts";
import { createLogger } from "../../src/logger.ts";
import { FileIrCache } from "../../src/node/ir-cache.ts";
import { FileOcrPageStore } from "../../src/node/ocr-store.ts";
import { NodeTesseractEngine } from "../../src/node/tesseract-node.ts";
import { RENDER_DPI } from "../../src/ocr/render.ts";
import { runModule } from "../../src/run.ts";

/**
 * Shared fixture-case runner used by `update-golden`, the golden vitest and the
 * determinism tests. Runs the full engine (OCR included) in memory over a
 * case's PDFs and returns the module as a relPath → bytes map, so golden
 * generation and comparison exercise the exact same code path.
 */

export interface FixtureCase {
    name: string;
    /** The PDFs converted together into one module. */
    pdfs: string[];
}

/** OCR threads for fixture runs: fixtures are a few pages. */
const FIXTURE_OCR_WORKERS = 2;

export function loadManifest(repoRoot: string): FixtureCase[] {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/manifest.json"), "utf8")) as {
        cases: FixtureCase[];
    };
    return manifest.cases;
}

/** The case's module as `<module id>/<relPath>` → bytes. */
export async function runCase(
    entry: FixtureCase,
    repoRoot: string,
    cacheNamespace = "golden",
): Promise<Map<string, Uint8Array>> {
    // Transient intermediates go to the OS temp dir, never the working tree.
    const cacheDir = join(tmpdir(), "foundry-pdf-parser-tests", cacheNamespace, entry.name);
    const engine = await NodeTesseractEngine.create(FIXTURE_OCR_WORKERS, RENDER_DPI);
    try {
        const result = await runModule(
            entry.pdfs.map((pdf) => new Uint8Array(readFileSync(resolve(repoRoot, pdf)))),
            {
                target: DEFAULT_TARGET,
                ocr: engine,
                ocrStore: new FileOcrPageStore(cacheDir),
                irCache: new FileIrCache(cacheDir),
                maxInFlight: FIXTURE_OCR_WORKERS * 2,
                log: createLogger("error"),
            },
        );
        if (result.module === null || result.refused.length > 0) {
            throw new Error(`${entry.name}: unexpectedly encrypted`);
        }
        const enc = new TextEncoder();
        return new Map(
            result.module.files.map((f) => [
                f.relPath,
                typeof f.contents === "string" ? enc.encode(f.contents) : f.contents,
            ]),
        );
    } finally {
        await engine.close();
    }
}
