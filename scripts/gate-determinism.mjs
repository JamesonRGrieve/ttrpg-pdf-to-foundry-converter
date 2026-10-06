// SPDX-License-Identifier: AGPL-3.0-or-later
// Gates G1 + G1b: cold-cache and warm-cache determinism at the CLI level. Run
// the engine three times over every fixture case — cold (cache wiped), warm
// (cache retained), cold again — and require byte-identical output trees.
// Cases run side by side (a case's warm run after its first cold run, which
// builds the cache it reuses), the machine's cores shared between them.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliCommand } from "./lib/cli.mjs";
import { posixRelative, read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(read(repoRoot, "fixtures/manifest.json")).cases;
/** CLI runs in flight at once: two per case (a cold run beside the cold-then-warm pair). */
const CONCURRENT_RUNS = 2 * cases.length;
const OCR_WORKERS = Math.max(1, Math.floor(availableParallelism() / CONCURRENT_RUNS));
const run = promisify(execFile);

/**
 * The case's PDFs, each preceded by its target when the case gives targets
 * (`--target` applies to the PDFs after it, so a case giving any gives all).
 */
function targetedPdfs(entry) {
    if (entry.targets === undefined) {
        return entry.pdfs;
    }
    if (entry.targets.length !== entry.pdfs.length) {
        throw new Error(`${entry.name}: targets must give every PDF's line`);
    }
    return entry.pdfs.flatMap((pdf, i) => ["--target", entry.targets[i], pdf]);
}

async function runCli(outDir, cacheDir, entry) {
    const [command, args] = cliCommand([
        "infer",
        ...targetedPdfs(entry),
        "--out-dir",
        outDir,
        "--cache-dir",
        cacheDir,
        "--ocr-workers",
        String(OCR_WORKERS),
        "--log-level",
        "error",
    ]);
    const { stderr } = await run(command, args, { cwd: repoRoot });
    if (stderr.length > 0) {
        process.stderr.write(stderr);
    }
}

function tree(dir) {
    const out = new Map();
    const walk = (d) => {
        for (const e of readdirSync(d).sort()) {
            const full = join(d, e);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else {
                out.set(posixRelative(dir, full), readFileSync(full));
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

/** One case's three runs; whether their output trees are identical (and how many files). */
async function checkCase(tmp, entry) {
    const cold1 = join(tmp, `${entry.name}-cold1`);
    const warm = join(tmp, `${entry.name}-warm`);
    const cold2 = join(tmp, `${entry.name}-cold2`);
    const cache = join(tmp, `${entry.name}-cache`);
    await Promise.all([
        // cold: builds the cache, then warm: reuses it
        runCli(cold1, cache, entry).then(() => runCli(warm, cache, entry)),
        // cold again, on a cache of its own
        runCli(cold2, join(tmp, `${entry.name}-cache2`), entry),
    ]);
    const t1 = tree(cold1);
    return { same: equalTrees(t1, tree(warm)) && equalTrees(t1, tree(cold2)), files: t1.size };
}

const tmp = mkdtempSync(join(tmpdir(), "fpp-det-"));
let failed = false;
const results = await Promise.all(cases.map((entry) => checkCase(tmp, entry)));
cases.forEach((entry, i) => {
    const { same, files } = results[i];
    if (same) {
        process.stdout.write(`  ✓ ${entry.name}: cold == warm == cold (${files} files)\n`);
    } else {
        process.stderr.write(`  ✗ ${entry.name}: cold/warm/cold output differ\n`);
        failed = true;
    }
});
rmSync(tmp, { recursive: true, force: true });

if (failed) {
    process.stderr.write("G1/G1b determinism FAILED\n");
    process.exit(1);
}
process.stdout.write("G1/G1b determinism: clean\n");
