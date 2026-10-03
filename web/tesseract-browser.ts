// SPDX-License-Identifier: AGPL-3.0-or-later
import Tesseract from "tesseract.js";
import {
    CORE_BUILD,
    LANGUAGE,
    CELL_CHARS,
    CELL_SEG_MODE,
    PAGE_SEG_MODE,
    recognitionParams,
    SPARSE_SEG_MODE,
    tesseractEngineId,
    wordsFromBlocks,
    type OcrEngine,
    type OcrWord,
    type RenderedPage,
} from "../src/index.ts";

/**
 * Embedded OCR in the browser: the shared tesseract configuration run in a pool
 * of Web Workers. Worker script, WASM core and model data are all served from
 * this page's own origin (staged by scripts/copy-web-assets.mjs); pointing
 * `corePath` at the exact pinned build file stops tesseract.js from picking a
 * CPU-dependent core, so results match the Node engine byte for byte.
 */

export class BrowserTesseractEngine implements OcrEngine {
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

    /** `vendorBase` is the absolute URL of the staged `vendor/tesseract/` directory. */
    static async create(workers: number, dpi: number, vendorBase: string): Promise<BrowserTesseractEngine> {
        const pool = async (segMode: string, whitelist = ""): Promise<Tesseract.Scheduler> => {
            const scheduler = Tesseract.createScheduler();
            const created = await Promise.all(
                Array.from({ length: workers }, async () => {
                    const worker = await Tesseract.createWorker(LANGUAGE, Tesseract.OEM.LSTM_ONLY, {
                        workerPath: `${vendorBase}worker.min.js`,
                        corePath: `${vendorBase}${CORE_BUILD}.wasm.js`,
                        langPath: `${vendorBase}lang`,
                        cacheMethod: "none",
                        gzip: true,
                        workerBlobURL: false,
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
        return new BrowserTesseractEngine(await pool(PAGE_SEG_MODE), pool, dpi);
    }

    async recognize(page: RenderedPage): Promise<OcrWord[]> {
        return BrowserTesseractEngine.#read(this.#scheduler, page);
    }

    async recognizeSparse(page: RenderedPage): Promise<OcrWord[]> {
        this.#sparse ??= this.#pool(SPARSE_SEG_MODE);
        return BrowserTesseractEngine.#read(await this.#sparse, page);
    }

    async recognizeCell(page: RenderedPage): Promise<OcrWord[]> {
        this.#cell ??= this.#pool(CELL_SEG_MODE, CELL_CHARS);
        return BrowserTesseractEngine.#read(await this.#cell, page);
    }

    static async #read(scheduler: Tesseract.Scheduler, page: RenderedPage): Promise<OcrWord[]> {
        // A copy owns a plain ArrayBuffer, which Blob requires.
        const blob = new Blob([page.png.slice()], { type: "image/png" });
        const result = await scheduler.addJob("recognize", blob, {}, { blocks: true, text: false });
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
