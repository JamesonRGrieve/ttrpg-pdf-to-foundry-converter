// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { makeConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { runPipeline } from "../../src/pipeline.ts";
import { loadProfile } from "../../src/profile/load.ts";
import { sha256Hex } from "../../src/util/hash.ts";

/**
 * Shared fixture-case runner used by both `update-golden` and the golden vitest.
 * Runs the pipeline in memory (Tier A only, enrichment off) and returns the
 * full output as a relPath → bytes map, so golden generation and golden
 * comparison exercise the exact same code path.
 */

export interface FixtureCase {
    name: string;
    pdf: string;
    profile: string;
}

export function loadManifest(repoRoot: string): FixtureCase[] {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/manifest.json"), "utf8")) as {
        cases: FixtureCase[];
    };
    return manifest.cases;
}

export async function runCase(
    entry: FixtureCase,
    repoRoot: string,
    cacheNamespace = "golden",
): Promise<Map<string, Uint8Array>> {
    const config = makeConfig(repoRoot, {
        // Transient intermediates go to the OS temp dir, never the working tree.
        // The cache is content-keyed, so namespaced temp paths are collision-free.
        cacheDir: join(tmpdir(), "foundry-pdf-parser-tests", cacheNamespace, entry.name),
        enrich: false,
        logLevel: "error",
    });
    const profilePath = resolve(repoRoot, entry.profile);
    const profileBytes = new Uint8Array(readFileSync(profilePath));
    const profile = loadProfile(profilePath);
    const pdfBytes = new Uint8Array(readFileSync(resolve(repoRoot, entry.pdf)));
    const result = await runPipeline(
        pdfBytes,
        profile,
        { sha256: sha256Hex(profileBytes), sourceBasename: basename(entry.pdf) },
        config,
        createLogger("error"),
        null,
    );
    if (result.encrypted) {
        throw new Error(`${entry.name}: unexpectedly encrypted`);
    }
    const out = new Map<string, Uint8Array>();
    const enc = new TextEncoder();
    for (const file of result.files) {
        out.set(`packs/${file.relPath}`, enc.encode(file.contents));
    }
    for (const prov of result.provenance) {
        out.set(`packs/${prov.relPath}`, enc.encode(prov.contents));
    }
    for (const asset of result.assets) {
        out.set(`assets/${asset.relPath}`, asset.bytes);
    }
    return out;
}
