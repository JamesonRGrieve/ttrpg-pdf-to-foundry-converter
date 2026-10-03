// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every non-test CI gate, side by side (they share nothing), and prints
// each one's output in turn. The vitest suite (golden G4, determinism, image
// dedup G11) runs separately via `pnpm test`; these are the file-scan and
// CLI-behavior gates.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const gates = [
    "gate-dep-pin.mjs",
    "gate-timestamp-scan.mjs",
    "gate-title-scan.mjs",
    "gate-refusals.mjs",
    "gate-determinism.mjs",
];

const run = promisify(execFile);
/** Gate output beyond the default buffer still fits. */
const OUTPUT_BYTES = 64 * 1024 * 1024;
const outcomes = await Promise.all(
    gates.map((gate) =>
        run("node", [resolve(here, gate)], { cwd: repoRoot, maxBuffer: OUTPUT_BYTES }).then(
            ({ stdout, stderr }) => ({ gate, passed: true, stdout, stderr }),
            (err) => ({ gate, passed: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) }),
        ),
    ),
);
let failed = false;
for (const { gate, passed, stdout, stderr } of outcomes) {
    process.stdout.write(`\n=== ${gate} ===\n${stdout}`);
    process.stderr.write(stderr);
    failed ||= !passed;
}

process.stdout.write(failed ? "\nGATES FAILED\n" : "\nALL GATES PASSED\n");
process.exit(failed ? 1 : 0);
