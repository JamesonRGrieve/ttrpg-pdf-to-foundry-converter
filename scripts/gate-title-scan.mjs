import { dirname, resolve } from "node:path";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G9: repo-wide grep against the maintained denylist of commercial titles /
// publishers must return zero hits (C7). The denylist file excludes itself.
import { fileURLToPath } from "node:url";
import { isText, listFiles, read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DENYLIST = "scripts/denylist.txt";

// Corpus-audit tooling (scripts/audit-*, im-*, owbc-*, the per-line book manifests,
// crop helpers) drives the engine against a PRIVATE commercial corpus, so it names
// the product lines it audits by necessity. It is exempt from the title scan; the
// shippable engine (src/, generic fixtures, docs) is not. Keep this list tight so a
// real leak in engine source is never masked — every pattern is scripts/-scoped and
// matches no committed engine file (gate-*, lib/, denylist.txt, dump-ir, update-golden).
const AUDIT_TOOLING = [
    // Book manifests: every .json directly under scripts/ is an audit manifest (the
    // committed engine ships no .json there — only *.mjs / *.ts / lib/ / denylist.txt).
    /^scripts\/[^/]+\.json$/,
    // Audit/authoring helpers, incl. the per-line agent script prefixes.
    /^scripts\/audit-/,
    /^scripts\/validate-/,
    /^scripts\/crop-/,
    /^scripts\/(im|owbc|dh1supp|dwsupp|rtsupp|bcsupp|owsupp|dh2supp)-/,
];

const terms = read(repoRoot, DENYLIST)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.toLowerCase());

// Whole-word matching: a denylisted phrase must not merely occur inside other
// words (e.g. across an identifier boundary like "readonly warnings").
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = terms.map((term) => ({
    term,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "u"),
}));

const violations = [];
for (const rel of listFiles(repoRoot)) {
    if (rel === DENYLIST || !isText(rel) || AUDIT_TOOLING.some((re) => re.test(rel))) {
        continue;
    }
    const text = read(repoRoot, rel).toLowerCase();
    for (const { term, re } of patterns) {
        if (re.test(text)) {
            violations.push(`${rel}: contains denylisted "${term}"`);
        }
    }
}

if (violations.length > 0) {
    process.stderr.write(`G9 title scan FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
    process.exit(1);
}
process.stdout.write(`G9 title scan: clean (${terms.length} terms)\n`);
