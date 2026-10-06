// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G6: an encrypted PDF is refused (exit 3) and nothing is written. Proven
// by RUNNING the shipped CLI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCommand } from "./lib/cli.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_ENCRYPTED = 3;

const tmp = mkdtempSync(join(tmpdir(), "fpp-refuse-"));
const outDir = join(tmp, "out");
let code = 0;
try {
    const [command, args] = cliCommand([
        "infer",
        "fixtures/rendered/encrypted.pdf",
        "--out-dir",
        outDir,
        "--cache-dir",
        join(tmp, "cache"),
    ]);
    execFileSync(command, args, { cwd: repoRoot, stdio: "ignore" });
} catch (err) {
    code = typeof err.status === "number" ? err.status : 1;
}

let ok = true;
if (code !== EXIT_ENCRYPTED) {
    process.stderr.write(`  ✗ G6 encrypted: expected exit ${EXIT_ENCRYPTED}, got ${code}\n`);
    ok = false;
}
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    process.stderr.write("  ✗ output was written despite the refusal\n");
    ok = false;
}
// The scratch directory goes whatever the outcome: /tmp may be held in memory.
rmSync(tmp, { recursive: true, force: true });
if (!ok) {
    process.stderr.write("G6 refusal gate FAILED\n");
    process.exit(1);
}
process.stdout.write(
    `G6 refusal gate: encrypted input refused with exit ${EXIT_ENCRYPTED}, nothing written\n`,
);
