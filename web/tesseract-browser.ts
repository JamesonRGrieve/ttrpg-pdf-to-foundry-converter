// SPDX-License-Identifier: AGPL-3.0-or-later
import Tesseract from "tesseract.js";
import {
    CORE_BUILD,
    LANGUAGE,
    recognitionParams,
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
    readonly #scheduler: Tesseract.Scheduler;

    private constructor(scheduler: Tesseract.Scheduler, dpi: number) {
        this.#scheduler = scheduler;
        this.id = tesseractEngineId(dpi);
    }

    /** `vendorBase` is the absolute URL of the staged `vendor/tesseract/` directory. */
    static async create(workers: number, dpi: number, vendorBase: string): Promise<BrowserTesseractEngine> {
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
                await worker.setParameters(recognitionParams(dpi));
                return worker;
            }),
        );
        for (const worker of created) {
            scheduler.addWorker(worker);
        }
        return new BrowserTesseractEngine(scheduler, dpi);
    }

    async recognize(page: RenderedPage): Promise<OcrWord[]> {
        // A copy owns a plain ArrayBuffer, which Blob requires.
        const blob = new Blob([page.png.slice()], { type: "image/png" });
        const result = await this.#scheduler.addJob("recognize", blob, {}, { blocks: true, text: false });
        return wordsFromBlocks(result.data, page);
    }

    async close(): Promise<void> {
        await this.#scheduler.terminate();
    }
}
