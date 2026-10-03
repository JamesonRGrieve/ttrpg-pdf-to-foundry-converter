// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from "node:worker_threads";
import { PpOcrPool, type ReaderPort, type ReadResponse } from "../ocr/ppocr/pool.ts";

/** The worker entry beside this module, as built (`.js`) or run from source (`.ts`). */
const WORKER_EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const WORKER_URL = new URL(`./ppocr-worker${WORKER_EXT}`, import.meta.url);

/** A worker thread as a pool port. */
function threadPort(): ReaderPort {
    const worker = new Worker(WORKER_URL);
    return {
        post: (request) => worker.postMessage(request),
        onResponse: (handler) => worker.on("message", (response: ReadResponse) => handler(response)),
        onFailure: (handler) => worker.on("error", handler),
        terminate: async () => {
            await worker.terminate();
        },
    };
}

/** The PP-OCR reader over `workers` worker threads. */
export function createNodePpOcrPool(workers: number): PpOcrPool {
    return new PpOcrPool(threadPort, workers);
}
