// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact versions of the determinism-critical dependencies (text extractor,
 * renderer, OCR engine + model, hashing, compression). They key the OCR/IR
 * caches and are stamped into pack provenance, so an upgrade can never be
 * mistaken for the build that produced existing output. Kept in lock-step with
 * `package.json` by `scripts/gate-dep-pin.mjs`.
 */
export const PINS = {
    "pdfjs-dist": "4.10.38",
    "pdf-lib": "1.17.1",
    mupdf: "1.28.1",
    "tesseract.js": "7.0.0",
    "tesseract.js-core": "7.0.0",
    "@tesseract.js-data/eng": "1.0.0",
    "@noble/hashes": "2.4.0",
    fflate: "0.8.3",
} as const;
