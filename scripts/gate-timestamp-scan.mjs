// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G8: no ISO-8601 dates, epoch-like ints, or UUIDs in emitted entity files.
// Spurious timestamps/UUIDs are the classic source of non-reproducible output.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { listFiles, read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const violations = [];
for (const rel of listFiles(repoRoot)) {
    // Emitted entity documents live under golden/<name>/packs/**/_source/*.json.
    if (!/^golden\/.*\/_source\/.*\.json$/.test(rel)) {
        continue;
    }
    const text = read(repoRoot, rel);
    if (ISO_DATE.test(text)) {
        violations.push(`${rel}: ISO-8601 date`);
    }
    if (UUID.test(text)) {
        violations.push(`${rel}: UUID`);
    }
    const doc = JSON.parse(text);
    if (doc._stats && (doc._stats.createdTime !== 0 || doc._stats.modifiedTime !== 0)) {
        violations.push(`${rel}: _stats timestamps are not 0`);
    }
}

if (violations.length > 0) {
    process.stderr.write(`G8 timestamp scan FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
    process.exit(1);
}
process.stdout.write("G8 timestamp scan: clean\n");
