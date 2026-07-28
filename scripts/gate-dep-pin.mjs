// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G10: the lockfile is present and the determinism-critical dependencies
// (extractor, image encoder, RE2 engine, YAML serializer) are pinned EXACTLY —
// no range specifiers. A drifting extractor/encoder silently breaks byte-identity.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRITICAL = ["pdfjs-dist", "pdf-lib", "pngjs", "re2js", "yaml"];
const EXACT = /^\d+\.\d+\.\d+$/;

const violations = [];
if (!existsSync(resolve(repoRoot, "pnpm-lock.yaml"))) {
    violations.push("pnpm-lock.yaml is missing");
}
const pkg = JSON.parse(read(repoRoot, "package.json"));
const deps = pkg.dependencies ?? {};
for (const name of CRITICAL) {
    const spec = deps[name];
    if (spec === undefined) {
        violations.push(`${name} is not a direct dependency`);
    } else if (!EXACT.test(spec)) {
        violations.push(`${name} is not pinned exactly (found "${spec}")`);
    }
}

if (violations.length > 0) {
    process.stderr.write(`G10 dependency-pin FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
    process.exit(1);
}
process.stdout.write(`G10 dependency-pin: ${CRITICAL.length} critical deps pinned exactly\n`);
