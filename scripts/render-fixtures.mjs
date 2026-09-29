// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Render the synthetic fixture PDFs from their sources, reproducibly:
 * every `fixtures/src/*.typ` through Typst with a fixed creation timestamp,
 * plus the hand-built encrypted fixture. Same sources + same Typst version =
 * byte-identical PDFs. After re-rendering, regenerate goldens with
 * `pnpm golden:update`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = join(ROOT, "fixtures", "src");
const OUT = join(ROOT, "fixtures", "rendered");
/** Fixed PDF creation date (UNIX epoch) so re-renders are byte-identical. */
const CREATION_TIMESTAMP = "0";
/** Upper bound for one fixture compile; they take well under a second. */
const COMPILE_TIMEOUT_MS = 60_000;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", timeout: COMPILE_TIMEOUT_MS });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
    }
}

for (const source of readdirSync(SRC)
    .filter((f) => f.endsWith(".typ"))
    .sort()) {
    const target = join(OUT, `${basename(source, ".typ")}.pdf`);
    run("typst", [
        "compile",
        "--root",
        SRC,
        "--creation-timestamp",
        CREATION_TIMESTAMP,
        join(SRC, source),
        target,
    ]);
    process.stdout.write(`rendered ${target}\n`);
}
run(process.execPath, [join(SRC, "gen-encrypted.mjs")]);
