// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Tesseract from "tesseract.js";
import {
    LANGUAGE,
    MODEL_PACKAGE,
    MODEL_VARIANT,
    CELL_CHARS,
    CELL_SEG_MODE,
    PAGE_SEG_MODE,
    recognitionParams,
    SPARSE_SEG_MODE,
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
    readonly sparseId: string;
    readonly cellId: string;
    readonly #scheduler: Tesseract.Scheduler;
    /** Builds a worker pool reading in a given segmentation mode (and character set). */
    readonly #pool: (segMode: string, whitelist?: string) => Promise<Tesseract.Scheduler>;
    /** The sparse-mode and cell-mode pools, built on first use (only scanned pages need them). */
    #sparse: Promise<Tesseract.Scheduler> | null = null;
    #cell: Promise<Tesseract.Scheduler> | null = null;

    private constructor(
        scheduler: Tesseract.Scheduler,
        pool: (segMode: string, whitelist?: string) => Promise<Tesseract.Scheduler>,
        dpi: number,
    ) {
        this.#scheduler = scheduler;
        this.#pool = pool;
        this.id = tesseractEngineId(dpi);
        this.sparseId = tesseractEngineId(dpi, SPARSE_SEG_MODE);
        this.cellId = tesseractEngineId(dpi, CELL_SEG_MODE, CELL_CHARS);
    }

    /** Spin up `workers` recognizer threads. */
    static async create(workers: number, dpi: number): Promise<NodeTesseractEngine> {
        const langPath = join(dirname(require.resolve(`${MODEL_PACKAGE}/package.json`)), MODEL_VARIANT);
        const pool = async (segMode: string, whitelist = ""): Promise<Tesseract.Scheduler> => {
            const scheduler = Tesseract.createScheduler();
            const created = await Promise.all(
                Array.from({ length: workers }, async () => {
                    const worker = await Tesseract.createWorker(LANGUAGE, Tesseract.OEM.LSTM_ONLY, {
                        workerPath: WORKER_PATH,
                        langPath,
                        cacheMethod: "none",
                        gzip: true,
                    });
                    await worker.setParameters(recognitionParams(dpi, segMode, whitelist));
                    return worker;
                }),
            );
            for (const worker of created) {
                scheduler.addWorker(worker);
            }
            return scheduler;
        };
        return new NodeTesseractEngine(await pool(PAGE_SEG_MODE), pool, dpi);
    }

    async recognize(page: RenderedPage): Promise<OcrWord[]> {
        return NodeTesseractEngine.#read(this.#scheduler, page);
    }

    async recognizeSparse(page: RenderedPage): Promise<OcrWord[]> {
        this.#sparse ??= this.#pool(SPARSE_SEG_MODE);
        return NodeTesseractEngine.#read(await this.#sparse, page);
    }

    async recognizeCell(page: RenderedPage): Promise<OcrWord[]> {
        this.#cell ??= this.#pool(CELL_SEG_MODE, CELL_CHARS);
        return NodeTesseractEngine.#read(await this.#cell, page);
    }

    static async #read(scheduler: Tesseract.Scheduler, page: RenderedPage): Promise<OcrWord[]> {
        const result = await scheduler.addJob(
            "recognize",
            Buffer.from(page.png),
            {},
            { blocks: true, text: false },
        );
        return wordsFromBlocks(result.data, page);
    }

    async close(): Promise<void> {
        await this.#scheduler.terminate();
        for (const pool of [this.#sparse, this.#cell]) {
            if (pool !== null) {
                await (await pool).terminate();
            }
        }
    }
}
