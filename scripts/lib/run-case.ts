// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TARGET, type Target, targetFor } from "../../src/infer/targets.ts";
import { createLogger } from "../../src/logger.ts";
import { FileIrCache } from "../../src/node/ir-cache.ts";
import { FileOcrPageStore } from "../../src/node/ocr-store.ts";
import { createNodePpOcr } from "../../src/node/ppocr-node.ts";
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
    /** Each PDF's target id, by position; absent or short → the default line. */
    targets?: string[];
}

/** The target schema a case chooses for its `index`-th PDF. */
export function caseTarget(entry: FixtureCase, index: number): Target {
    const id = entry.targets?.[index];
    const target = id === undefined ? DEFAULT_TARGET : targetFor(id);
    if (target === null) {
        throw new Error(`${entry.name}: unknown target ${JSON.stringify(id)}`);
    }
    return target;
}

/** OCR threads for fixture runs: a thread per page of the longest fixture (cases run side by side). */
const FIXTURE_OCR_WORKERS = 4;

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
    const ppocr = await createNodePpOcr();
    try {
        const result = await runModule(
            entry.pdfs.map((pdf, i) => ({
                pdf: new Uint8Array(readFileSync(resolve(repoRoot, pdf))),
                target: caseTarget(entry, i),
            })),
            {
                ocr: engine,
                scanReader: ppocr.reader,
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
        await ppocr.close();
    }
}
