// SPDX-License-Identifier: AGPL-3.0-or-later
// Stage the pinned OCR runtime into the web app's static directory so the page
// serves everything from its own origin — no CDN, no network at run time:
//   - tesseract.js browser worker script
//   - the pinned WASM core build (plain SIMD + LSTM, see src/ocr/tesseract-config.ts)
//   - the pinned English model data
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(repoRoot, "web", "public", "vendor");

const CORE_BUILD = "tesseract-core-simd-lstm";
const MODEL_VARIANT = "4.0.0_best_int";

const files = [
    [join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(out, "tesseract", "worker.min.js")],
    [
        join(pkgDir("tesseract.js-core"), `${CORE_BUILD}.wasm.js`),
        join(out, "tesseract", `${CORE_BUILD}.wasm.js`),
    ],
    [
        join(pkgDir("@tesseract.js-data/eng"), MODEL_VARIANT, "eng.traineddata.gz"),
        join(out, "tesseract", "lang", "eng.traineddata.gz"),
    ],
];

for (const [from, to] of files) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
}
process.stdout.write(`staged ${files.length} OCR runtime files into web/public/vendor\n`);
