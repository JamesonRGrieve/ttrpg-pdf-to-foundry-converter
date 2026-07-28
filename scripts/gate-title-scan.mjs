// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G9: repo-wide grep against the maintained denylist of commercial titles /
// publishers must return zero hits (C7). The denylist file excludes itself.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isText, listFiles, read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DENYLIST = "scripts/denylist.txt";

const terms = read(repoRoot, DENYLIST)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.toLowerCase());

const violations = [];
for (const rel of listFiles(repoRoot)) {
    if (rel === DENYLIST || !isText(rel)) {
        continue;
    }
    const text = read(repoRoot, rel).toLowerCase();
    for (const term of terms) {
        if (text.includes(term)) {
            violations.push(`${rel}: contains denylisted "${term}"`);
        }
    }
}

if (violations.length > 0) {
    process.stderr.write(`G9 title scan FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
    process.exit(1);
}
process.stdout.write(`G9 title scan: clean (${terms.length} terms)\n`);
