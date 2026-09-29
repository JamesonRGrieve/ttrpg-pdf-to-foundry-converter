// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Tesseract from "tesseract.js";
import {
    LANGUAGE,
    MODEL_PACKAGE,
    MODEL_VARIANT,
    recognitionParams,
    tesseractEngineId,
    wordsFromBlocks,
} from "../ocr/tesseract-config.ts";
import type { OcrEngine, OcrWord, RenderedPage } from "../ocr/types.ts";

/**
 * Embedded OCR in Node: the shared tesseract configuration run in a pool of
 * worker threads. The worker entry (`tesseract-worker.cjs`) pins the WASM core;
 * model data is read from the pinned package on disk — never fetched.
 */

const require = createRequire(import.meta.url);
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "tesseract-worker.cjs");

export class NodeTesseractEngine implements OcrEngine {
    readonly id: string;
    readonly #scheduler: Tesseract.Scheduler;

    private constructor(scheduler: Tesseract.Scheduler, dpi: number) {
        this.#scheduler = scheduler;
        this.id = tesseractEngineId(dpi);
    }

    /** Spin up `workers` recognizer threads. */
    static async create(workers: number, dpi: number): Promise<NodeTesseractEngine> {
        const scheduler = Tesseract.createScheduler();
        const langPath = join(dirname(require.resolve(`${MODEL_PACKAGE}/package.json`)), MODEL_VARIANT);
        const created = await Promise.all(
            Array.from({ length: workers }, async () => {
                const worker = await Tesseract.createWorker(LANGUAGE, Tesseract.OEM.LSTM_ONLY, {
                    workerPath: WORKER_PATH,
                    langPath,
                    cacheMethod: "none",
                    gzip: true,
                });
                await worker.setParameters(recognitionParams(dpi));
                return worker;
            }),
        );
        for (const worker of created) {
            scheduler.addWorker(worker);
        }
        return new NodeTesseractEngine(scheduler, dpi);
    }

    async recognize(page: RenderedPage): Promise<OcrWord[]> {
        const result = await this.#scheduler.addJob(
            "recognize",
            Buffer.from(page.png),
            {},
            { blocks: true, text: false },
        );
        return wordsFromBlocks(result.data, page);
    }

    async close(): Promise<void> {
        await this.#scheduler.terminate();
    }
}
