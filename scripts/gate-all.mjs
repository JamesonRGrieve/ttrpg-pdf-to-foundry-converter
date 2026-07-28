// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every non-test CI gate in sequence. The vitest suite (golden G4,
// determinism, image dedup G11, enrichment isolation G14, schema G7) runs
// separately via `pnpm test`; these are the file-scan and CLI-behavior gates.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const gates = [
    "gate-dep-pin.mjs",
    "gate-timestamp-scan.mjs",
    "gate-title-scan.mjs",
    "gate-wiki-scan.mjs",
    "gate-refusals.mjs",
    "gate-determinism.mjs",
];

let failed = false;
for (const gate of gates) {
    process.stdout.write(`\n=== ${gate} ===\n`);
    try {
        execFileSync("node", [resolve(here, gate)], { cwd: repoRoot, stdio: "inherit" });
    } catch {
        failed = true;
    }
}

process.stdout.write(failed ? "\nGATES FAILED\n" : "\nALL GATES PASSED\n");
process.exit(failed ? 1 : 0);
