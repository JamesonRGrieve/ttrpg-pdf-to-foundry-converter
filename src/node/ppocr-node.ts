// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as ort from "onnxruntime-web";
import { createPpOcr } from "../ocr/ppocr/ort-session.ts";
import { PPOCR_MODELS, type PpOcrReader } from "../ocr/ppocr/reader.ts";

/**
 * The PP-OCR reader in Node (onnxruntime-web's Node entry, the plain
 * WebAssembly build). Model files are read from the pinned package on disk,
 * never fetched.
 */

const require = createRequire(import.meta.url);
const MODEL_DIR = join(dirname(require.resolve("@gutenye/ocr-models/node")), "assets");

/** The PP-OCR reader over the pinned models, and a closer for its sessions. */
export async function createNodePpOcr(): Promise<{ reader: PpOcrReader; close: () => Promise<void> }> {
    const file = (name: string): Uint8Array => new Uint8Array(readFileSync(join(MODEL_DIR, name)));
    return createPpOcr(ort, {
        detector: file(PPOCR_MODELS.detector),
        recognizer: file(PPOCR_MODELS.recognizer),
        keys: readFileSync(join(MODEL_DIR, PPOCR_MODELS.alphabet), "utf8"),
    });
}
