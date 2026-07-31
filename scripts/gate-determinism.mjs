// SPDX-License-Identifier: AGPL-3.0-or-later
// Gates G1 + G1b: cold-cache and warm-cache determinism at the CLI level. Run
// the engine three times over every fixture case — cold (cache wiped), warm
// (cache retained), cold again — and require byte-identical output trees.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(read(repoRoot, "fixtures/manifest.json")).cases;

function runCli(outDir, cacheDir, entry) {
    execFileSync(
        "npx",
        [
            "tsx",
            "src/cli.ts",
            "run",
            entry.pdf,
            "--profile",
            entry.profile,
            "--packs-dir",
            join(outDir, "packs"),
            "--assets-dir",
            join(outDir, "assets"),
            "--cache-dir",
            cacheDir,
            "--log-level",
            "error",
        ],
        { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
}

function tree(dir) {
    const out = new Map();
    const walk = (d) => {
        for (const e of readdirSync(d).sort()) {
            const full = join(d, e);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else {
                out.set(relative(dir, full), readFileSync(full));
            }
        }
    };
    walk(dir);
    return out;
}

function equalTrees(a, b) {
    if (a.size !== b.size) {
        return false;
    }
    for (const [k, v] of a) {
        const o = b.get(k);
        if (!o || !v.equals(o)) {
            return false;
        }
    }
    return true;
}

const tmp = mkdtempSync(join(tmpdir(), "fpp-det-"));
let failed = false;
for (const entry of cases) {
    const cold1 = join(tmp, `${entry.name}-cold1`);
    const warm = join(tmp, `${entry.name}-warm`);
    const cold2 = join(tmp, `${entry.name}-cold2`);
    const cache = join(tmp, `${entry.name}-cache`);

    rmSync(cache, { recursive: true, force: true });
    runCli(cold1, cache, entry); // cold: builds cache
    runCli(warm, cache, entry); // warm: reuses cache
    rmSync(cache, { recursive: true, force: true });
    runCli(cold2, join(tmp, `${entry.name}-cache2`), entry); // cold again, fresh cache

    const t1 = tree(cold1);
    const t2 = tree(warm);
    const t3 = tree(cold2);
    if (!equalTrees(t1, t2) || !equalTrees(t1, t3)) {
        process.stderr.write(`  ✗ ${entry.name}: cold/warm/cold output differ\n`);
        failed = true;
    } else {
        process.stdout.write(`  ✓ ${entry.name}: cold == warm == cold (${t1.size} files)\n`);
    }
}
rmSync(tmp, { recursive: true, force: true });

if (failed) {
    process.stderr.write("G1/G1b determinism FAILED\n");
    process.exit(1);
}
process.stdout.write("G1/G1b determinism: clean\n");
