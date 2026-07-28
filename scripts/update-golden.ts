// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, runCase } from "./lib/run-case.ts";

/**
 * Regenerate `golden/<name>/` for every fixture case. Run this in a DEDICATED
 * commit whenever an intended change (IR bump, profile edit, extractor bump)
 * legitimately moves the golden bytes — never to silence a failing gate.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const entry of loadManifest(repoRoot)) {
    const goldenDir = resolve(repoRoot, "golden", entry.name);
    rmSync(goldenDir, { recursive: true, force: true });
    const output = await runCase(entry, repoRoot);
    for (const [relPath, bytes] of output) {
        const full = resolve(goldenDir, relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, bytes);
    }
    process.stdout.write(`golden ${entry.name}: ${output.size} files\n`);
}
