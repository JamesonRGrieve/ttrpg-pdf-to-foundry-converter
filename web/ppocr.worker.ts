// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
import { answerRead } from "../src/ocr/ppocr/pool.ts";
import type { PpOcrReader } from "../src/ocr/ppocr/reader.ts";
import { createBrowserPpOcr, type ReaderWorkerMessage } from "./ppocr-browser.ts";

/**
 * One PP-OCR Web Worker (see `PpOcrPool`): given its runtime and models in
 * its first message, its own reader, then one page per message.
 */

declare const self: DedicatedWorkerGlobalScope;

let reader: Promise<PpOcrReader> | null = null;
self.addEventListener("message", (event: MessageEvent<ReaderWorkerMessage>) => {
    const message = event.data;
    if ("assets" in message) {
        reader = createBrowserPpOcr(message.assets).then((ppocr) => ppocr.reader);
        return;
    }
    const pending = reader ?? Promise.reject(new Error("page sent before the reader's assets"));
    pending
        .then((r) => answerRead(r, message))
        .then(
            (response) => self.postMessage(response),
            (err: unknown) =>
                self.postMessage({ id: message.id, error: err instanceof Error ? err.message : String(err) }),
        );
});
