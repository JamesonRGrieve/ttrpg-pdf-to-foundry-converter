// SPDX-License-Identifier: AGPL-3.0-or-later
import * as ort from "onnxruntime-web/wasm";
import { createPpOcr } from "../src/ocr/ppocr/ort-session.ts";
import { PpOcrPool, type ReaderPort, type ReadRequest, type ReadResponse } from "../src/ocr/ppocr/pool.ts";
import { PPOCR_MODELS, type PpOcrReader } from "../src/ocr/ppocr/reader.ts";

/**
 * The PP-OCR reader in the browser: onnxruntime-web's plain WebAssembly build
 * (the same binary the Node engine runs) and the pinned model files, all
 * served from this app's own origin (staged by scripts/copy-web-assets.mjs) —
 * no CDN, no network beyond it. Pages are spread over Web Workers, each a
 * whole reader. The runtime and models are fetched once, by the page's
 * engine worker, and handed to each reader worker.
 */

/** Where the runtime and models are staged, under the app's base URL. */
export const PPOCR_VENDOR_PATH = "vendor/ppocr/";
/** The runtime's WebAssembly build, staged beside the models. */
const ORT_WASM = "ort-wasm-simd-threaded.wasm";

/** Everything a reader worker needs, fetched once. */
export interface PpOcrAssets {
    wasm: ArrayBuffer;
    detector: Uint8Array;
    recognizer: Uint8Array;
    keys: string;
}

/** A reader worker's messages: its assets first, then pages to read. */
export type ReaderWorkerMessage = { assets: PpOcrAssets } | ReadRequest;

async function fetched(base: string, name: string): Promise<ArrayBuffer> {
    const response = await fetch(new URL(name, base));
    if (!response.ok) {
        throw new Error(`could not load ${name}: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
}

/** The runtime and models staged under `vendorBase`. */
export async function loadPpOcrAssets(vendorBase: string): Promise<PpOcrAssets> {
    const [wasm, detector, recognizer, keys] = await Promise.all([
        fetched(vendorBase, ORT_WASM),
        fetched(vendorBase, PPOCR_MODELS.detector),
        fetched(vendorBase, PPOCR_MODELS.recognizer),
        fetched(vendorBase, PPOCR_MODELS.alphabet),
    ]);
    return {
        wasm,
        detector: new Uint8Array(detector),
        recognizer: new Uint8Array(recognizer),
        keys: new TextDecoder().decode(keys),
    };
}

/** The PP-OCR reader over `assets`, and a closer for its sessions. */
export async function createBrowserPpOcr(
    assets: PpOcrAssets,
): Promise<{ reader: PpOcrReader; close: () => Promise<void> }> {
    ort.env.wasm.wasmBinary = assets.wasm;
    return createPpOcr(ort, { detector: assets.detector, recognizer: assets.recognizer, keys: assets.keys });
}

/** A PP-OCR Web Worker as a pool port, given its assets as soon as they are loaded. */
function webWorkerPort(assets: Promise<PpOcrAssets>): ReaderPort {
    const worker = new Worker(new URL("./ppocr.worker.ts", import.meta.url), { type: "module" });
    let fail: (err: Error) => void = () => undefined;
    // Pages wait for the assets: the worker reads in order of arrival.
    const ready = assets.then((loaded) =>
        worker.postMessage({ assets: loaded } satisfies ReaderWorkerMessage),
    );
    ready.catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
    return {
        post: (request) => {
            ready.then(
                () => worker.postMessage(request satisfies ReaderWorkerMessage),
                () => undefined,
            );
        },
        onResponse: (handler) =>
            worker.addEventListener("message", (event: MessageEvent<ReadResponse>) => handler(event.data)),
        onFailure: (handler) => {
            fail = handler;
            worker.addEventListener("error", (event) => handler(new Error(event.message || "worker error")));
        },
        terminate: async () => {
            worker.terminate();
        },
    };
}

/** The PP-OCR reader over `workers` Web Workers, its assets loaded from `vendorBase` on first use. */
export function createBrowserPpOcrPool(workers: number, vendorBase: string): PpOcrPool {
    let assets: Promise<PpOcrAssets> | null = null;
    return new PpOcrPool(() => {
        assets ??= loadPpOcrAssets(vendorBase);
        return webWorkerPort(assets);
    }, workers);
}
