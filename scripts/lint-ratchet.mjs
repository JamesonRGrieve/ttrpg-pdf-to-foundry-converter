// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lint-warning ratchet. Counts ESLint and Biome warnings and compares them
 * with the tracked baseline (`.lint-baseline.json`): any rise fails. A fall
 * is reported; `--update` records the lower count (the baseline never rises),
 * to be committed alongside the change that earned it. Errors are not
 * ratcheted — `pnpm lint` already fails on any.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASELINE = join(ROOT, ".lint-baseline.json");
/** Upper bound for one linter run over the repo. */
const LINT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function jsonOf(command, args) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: LINT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`${command} ${args.join(" ")} did not print JSON:\n${result.stderr}`);
    }
}

const requireFromRoot = createRequire(join(ROOT, "package.json"));

/**
 * A package's own bin script, run through this Node. `node_modules/.bin` holds
 * shell shims that Windows can only start through a shell, so spawning them
 * directly fails there with ENOENT; the package's JS entry runs everywhere.
 */
function binScript(pkg, name) {
    const manifest = requireFromRoot.resolve(`${pkg}/package.json`);
    const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
    return join(dirname(manifest), typeof bin === "string" ? bin : bin[name]);
}

const eslint = jsonOf(process.execPath, [binScript("eslint", "eslint"), ".", "--format", "json"]);
const biome = jsonOf(process.execPath, [
    binScript("@biomejs/biome", "biome"),
    "lint",
    "--reporter=json",
    "--max-diagnostics=0",
    ".",
]);
const current = {
    eslintWarnings: eslint.reduce((n, file) => n + file.warningCount, 0),
    biomeWarnings: biome.summary.warnings,
};

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
if (baseline === null) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 4)}\n`);
    process.stdout.write(`lint ratchet: baseline created ${JSON.stringify(current)}\n`);
    process.exit(0);
}

let failed = false;
const lowered = { ...baseline };
for (const [metric, count] of Object.entries(current)) {
    const allowed = baseline[metric];
    if (count > allowed) {
        failed = true;
        process.stderr.write(`lint ratchet: ${metric} rose ${allowed} → ${count}\n`);
    } else if (count < allowed) {
        lowered[metric] = count;
        process.stdout.write(`lint ratchet: ${metric} fell ${allowed} → ${count}\n`);
    }
}
if (failed) {
    process.exit(1);
}
if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(lowered, null, 4)}\n`);
    process.stdout.write(`lint ratchet: baseline now ${JSON.stringify(lowered)}\n`);
} else if (JSON.stringify(lowered) !== JSON.stringify(baseline)) {
    process.stdout.write("lint ratchet: run with --update to lock in the lower counts\n");
}
process.stdout.write(`lint ratchet: ok ${JSON.stringify(current)}\n`);
