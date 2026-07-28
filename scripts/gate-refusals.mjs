// SPDX-License-Identifier: AGPL-3.0-or-later
// Gates G5 (no-profile → exit 2, empty output) and G6 (encrypted → exit 3, no
// output). Both prove the engine fails closed by RUNNING the shipped CLI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runExpectExit(args, expected, label) {
    let code = 0;
    try {
        execFileSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: repoRoot, stdio: "ignore" });
    } catch (err) {
        code = typeof err.status === "number" ? err.status : 1;
    }
    if (code !== expected) {
        process.stderr.write(`  ✗ ${label}: expected exit ${expected}, got ${code}\n`);
        return false;
    }
    process.stdout.write(`  ✓ ${label}: exit ${expected}\n`);
    return true;
}

const tmp = mkdtempSync(join(tmpdir(), "fpp-refuse-"));
const outDir = join(tmp, "out");
let ok = true;

// G5: no --profile → exit 2, no output.
ok =
    runExpectExit(
        [
            "run",
            "fixtures/rendered/statblock-two-column.pdf",
            "--packs-dir",
            outDir,
            "--cache-dir",
            join(tmp, "c1"),
        ],
        2,
        "G5 no-profile",
    ) && ok;

// G6: encrypted → exit 3, no output.
ok =
    runExpectExit(
        [
            "run",
            "fixtures/rendered/encrypted.pdf",
            "--profile",
            "profiles/example-bestiary-two-column.yml",
            "--packs-dir",
            outDir,
            "--cache-dir",
            join(tmp, "c2"),
        ],
        3,
        "G6 encrypted",
    ) && ok;

if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    process.stderr.write("  ✗ output was written despite a refusal\n");
    ok = false;
}

if (!ok) {
    process.stderr.write("G5/G6 refusal gates FAILED\n");
    process.exit(1);
}
process.stdout.write("G5/G6 refusal gates: clean\n");
