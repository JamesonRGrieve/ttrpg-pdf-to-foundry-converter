// SPDX-License-Identifier: AGPL-3.0-or-later
// Copy non-TypeScript runtime files that `tsc` does not emit into dist/.
// The Node OCR worker entry is CommonJS (it plugs into tesseract.js's own
// CommonJS worker runtime) and is loaded by path at runtime.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["node/tesseract-worker.cjs"];

for (const rel of FILES) {
    const to = resolve(repoRoot, "dist", rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(resolve(repoRoot, "src", rel), to);
}
process.stdout.write(`copied ${FILES.length} runtime file(s) into dist/\n`);
