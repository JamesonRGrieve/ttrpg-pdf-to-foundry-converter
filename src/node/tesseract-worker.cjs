// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";

/*
 * tesseract.js worker entry with a PINNED WASM core. The stock Node entry picks
 * its core by CPU feature detection and prefers relaxed-SIMD, whose arithmetic
 * is implementation-defined and can differ between CPUs — that would make OCR,
 * and therefore engine output, machine-dependent. Plain wasm SIMD is fully
 * specified, so every machine gets identical recognition results.
 *
 * Network access is disabled: model data is loaded from a local path only.
 */
const { parentPort } = require("node:worker_threads");
const worker = require("tesseract.js/src/worker-script");
const cache = require("tesseract.js/src/worker-script/node/cache");
const gunzip = require("tesseract.js/src/worker-script/node/gunzip");
const core = require("tesseract.js-core/tesseract-core-simd-lstm");

parentPort.on("message", (packet) => {
    worker.dispatchHandlers(packet, (obj) => parentPort.postMessage(obj));
});

worker.setAdapter({
    getCore: async () => core,
    gunzip,
    fetch: async () => {
        throw new Error("OCR worker network access is disabled");
    },
    ...cache,
});
