#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Run the wh40k-rpg system's own pack validators against an engine output tree.
 *
 * The system is the schema authority, so this imports its validators rather than
 * restating their rules:
 *   - src/packs/validate-schema.cjs   canonical item schema + reference graph (warn-only)
 *   - src/packs/validate-actors.cjs   actor completeness (warn-only)
 *   - scripts/validate-pack-schema.mjs Zod content gate (fail-loud)
 *
 * Usage:
 *   node scripts/validate-output.mjs <output-root> [--system <foundry-system-dir>] [--verbose] [--json <file>]
 *
 * Exits 1 when the Zod gate reports any failing document; the warn-only
 * validators are summarized (per-rule counts) for ratcheting.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        system: { type: "string" },
        verbose: { type: "boolean", default: false },
        json: { type: "string" },
    },
});

const outputRoot = positionals[0];
if (outputRoot === undefined) {
    process.stderr.write(
        "usage: validate-output.mjs <output-root> [--system <dir>] [--verbose] [--json <file>]\n",
    );
    process.exit(2);
}
const root = resolve(outputRoot);
const systemDir = resolve(values.system ?? join(import.meta.dirname, "..", "..", ".foundry-system"));
if (!existsSync(join(systemDir, "src", "packs", "validate-schema.cjs"))) {
    process.stderr.write(`system validators not found under ${systemDir}\n`);
    process.exit(2);
}

const require = createRequire(import.meta.url);
const { validatePackSources } = require(join(systemDir, "src", "packs", "validate-schema.cjs"));
const { validateActorPacks } = require(join(systemDir, "src", "packs", "validate-actors.cjs"));
const { validateDoc } = await import(
    pathToFileURL(join(systemDir, "scripts", "validate-pack-schema.mjs")).href
);

const lines = [];
const log = (msg) => lines.push(msg);

const schema = validatePackSources({ rootDir: root, verbose: values.verbose, log });
const actors = validateActorPacks({ rootDir: root, verbose: values.verbose, log });

function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...sourceFiles(full));
        } else if (entry.name.endsWith(".json") && full.includes(`${sep}_source${sep}`)) {
            out.push(full);
        }
    }
    return out.sort();
}

const zodFailures = [];
const files = sourceFiles(root);
for (const file of files) {
    const errs = validateDoc(JSON.parse(readFileSync(file, "utf8")));
    if (errs.length > 0) {
        zodFailures.push({ file: relative(root, file), errors: errs });
    }
}

for (const line of lines) {
    process.stdout.write(`${line}\n`);
}
process.stdout.write(
    `=== zod content gate ===\nscanned ${files.length} document(s), ${zodFailures.length} failed\n`,
);
for (const f of values.verbose ? zodFailures : zodFailures.slice(0, 20)) {
    process.stdout.write(`  ${f.file}\n    - ${f.errors.join("\n    - ")}\n`);
}

if (values.json !== undefined) {
    const summary = {
        documents: files.length,
        schema: { filesWithWarnings: schema.filesWithWarnings, byRule: schema.byRule },
        actors: { byRule: actors.byRule ?? {} },
        zod: { failed: zodFailures.length },
    };
    writeFileSync(values.json, `${JSON.stringify(summary, null, 4)}\n`);
}

process.exit(zodFailures.length > 0 ? 1 : 0);
