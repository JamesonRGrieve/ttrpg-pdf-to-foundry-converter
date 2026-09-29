#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Run the wh40k-rpg system's own pack validators against the engine's output
 * modules.
 *
 * The system is the schema authority, so this imports its validators rather than
 * restating their rules:
 *   - src/packs/validate-schema.cjs   canonical item schema + reference graph (warn-only)
 *   - src/packs/validate-actors.cjs   actor completeness (warn-only)
 *   - scripts/validate-pack-schema.mjs Zod content gate (fail-loud)
 * Those read the system's authoring layout (`<group>/<pack>/_source/*.json`), so
 * each module's packs are expanded into that layout in a temp directory first.
 * The modules themselves are checked too (fail-loud): every pack is declared
 * for the system with a `.db` file, and every document's type is one the
 * system registers for the pack's document type.
 *
 * Usage:
 *   node scripts/validate-output.mjs <modules-dir> [--system <foundry-system-dir>] [--verbose] [--json <file>]
 *
 * Exits 1 when the Zod gate or the module check reports any failure; the
 * warn-only validators are summarized (per-rule counts) for ratcheting.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { moduleDocuments, moduleManifests } from "./lib/modules.mjs";

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

// Module structure: packs declared for the system, each with its .db file;
// document types the system registers.
const registered =
    JSON.parse(readFileSync(join(systemDir, "src", "system.json"), "utf8")).documentTypes ?? {};
const moduleFailures = [];
for (const { dir, manifest } of moduleManifests(root)) {
    for (const pack of manifest.packs ?? []) {
        if (pack.system !== "wh40k-rpg") {
            moduleFailures.push(`${manifest.id}/${pack.name}: not declared for the wh40k-rpg system`);
        }
        if (!existsSync(join(dir, `${pack.path}.db`))) {
            moduleFailures.push(`${manifest.id}/${pack.name}: no ${pack.path}.db`);
        }
    }
}
const docs = moduleDocuments(root);
for (const { module, pack, type, doc } of docs) {
    // Only document classes the system subtypes (Item, Actor) carry a `type`;
    // a RollTable or JournalEntry has none to register.
    if (registered[type] !== undefined && !(String(doc.type) in registered[type])) {
        moduleFailures.push(
            `${module}/${pack}: ${String(doc.name)} has unregistered ${type} type "${String(doc.type)}"`,
        );
    }
}

// Expand every pack into the system's authoring layout for its validators.
const expanded = mkdtempSync(join(tmpdir(), "fpp-validate-"));
for (const { pack, doc } of docs) {
    const dir = join(expanded, "output", pack, "_source");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(doc._id)}.json`), `${JSON.stringify(doc, null, 4)}\n`);
}

const schema = validatePackSources({ rootDir: expanded, verbose: values.verbose, log });
const actors = validateActorPacks({ rootDir: expanded, verbose: values.verbose, log });

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
const files = sourceFiles(expanded);
for (const file of files) {
    const errs = validateDoc(JSON.parse(readFileSync(file, "utf8")));
    if (errs.length > 0) {
        zodFailures.push({ file: relative(expanded, file), errors: errs });
    }
}
rmSync(expanded, { recursive: true, force: true });

for (const line of lines) {
    process.stdout.write(`${line}\n`);
}
process.stdout.write(
    `=== module check ===\n${moduleManifests(root).length} module(s), ${moduleFailures.length} failure(s)\n`,
);
for (const f of values.verbose ? moduleFailures : moduleFailures.slice(0, 20)) {
    process.stdout.write(`  ${f}\n`);
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
        modules: { failures: moduleFailures.length },
    };
    writeFileSync(values.json, `${JSON.stringify(summary, null, 4)}\n`);
}

process.exit(zodFailures.length > 0 || moduleFailures.length > 0 ? 1 : 0);
