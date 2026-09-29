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
import { runEngine } from "../../src/run.ts";

/**
 * Shared fixture-case runner used by `update-golden`, the golden vitest and the
 * determinism tests. Runs the full engine (OCR included) in memory and returns
 * the output as a relPath → bytes map, so golden generation and comparison
 * exercise the exact same code path.
 */

export interface FixtureCase {
    name: string;
    pdf: string;
}

/** OCR threads for fixture runs: fixtures are a few pages. */
const FIXTURE_OCR_WORKERS = 2;
const ASSET_REF_PREFIX = "systems/wh40k-rpg/packs/images/extracted";

export function loadManifest(repoRoot: string): FixtureCase[] {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/manifest.json"), "utf8")) as {
        cases: FixtureCase[];
    };
    return manifest.cases;
}

/** Engine output as `packs/<relPath>` and `assets/<relPath>` → bytes. */
export async function runCase(
    entry: FixtureCase,
    repoRoot: string,
    cacheNamespace = "golden",
): Promise<Map<string, Uint8Array>> {
    // Transient intermediates go to the OS temp dir, never the working tree.
    const cacheDir = join(tmpdir(), "foundry-pdf-parser-tests", cacheNamespace, entry.name);
    const engine = await NodeTesseractEngine.create(FIXTURE_OCR_WORKERS, RENDER_DPI);
    try {
        const result = await runEngine(new Uint8Array(readFileSync(resolve(repoRoot, entry.pdf))), {
            target: DEFAULT_TARGET,
            ocr: engine,
            ocrStore: new FileOcrPageStore(cacheDir),
            irCache: new FileIrCache(cacheDir),
            maxInFlight: FIXTURE_OCR_WORKERS * 2,
            assetRefPrefix: ASSET_REF_PREFIX,
            log: createLogger("error"),
        });
        if (result.encrypted) {
            throw new Error(`${entry.name}: unexpectedly encrypted`);
        }
        const out = new Map<string, Uint8Array>();
        const enc = new TextEncoder();
        for (const file of result.files) {
            out.set(`packs/${file.relPath}`, enc.encode(file.contents));
        }
        for (const asset of result.assets) {
            out.set(`assets/${asset.relPath}`, asset.bytes);
        }
        return out;
    } finally {
        await engine.close();
    }
}
