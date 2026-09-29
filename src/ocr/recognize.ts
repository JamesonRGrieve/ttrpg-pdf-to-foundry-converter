// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from "../logger.ts";
import type { RawPage } from "../types/ir.ts";
import { sha256Hex } from "../util/hash.ts";
import { PageRenderer, RENDERER_ID } from "./render.ts";
import type { OcrEngine, OcrPage, OcrWord } from "./types.ts";

/**
 * Render every page and recognize it with `engine`. Finished pages go to an
 * injected store (a directory on disk for the CLI, memory in the browser), so a
 * long book survives interruption and re-runs skip finished pages. Rendering
 * runs on the calling thread; recognition runs on the engine's workers, with at
 * most `maxInFlight` rendered pages held at once.
 *
 * Store keys combine the PDF content hash with the renderer and engine ids, so
 * a pin change can never serve stale OCR. The hash never leaves the store.
 */

export interface OcrPageStore {
    read(key: string, pageIndex: number): Promise<OcrWord[] | null>;
    write(key: string, pageIndex: number, words: OcrWord[]): Promise<void>;
}

/** A store that lives only as long as the run (the browser's default). */
export class MemoryOcrPageStore implements OcrPageStore {
    readonly #pages = new Map<string, OcrWord[]>();

    async read(key: string, pageIndex: number): Promise<OcrWord[] | null> {
        return this.#pages.get(`${key}/${pageIndex}`) ?? null;
    }

    async write(key: string, pageIndex: number, words: OcrWord[]): Promise<void> {
        this.#pages.set(`${key}/${pageIndex}`, words);
    }
}

export interface RecognizeOptions {
    store: OcrPageStore;
    maxInFlight: number;
    log: Logger;
    /** Called after each page is recognized (progress reporting). */
    onPage?: (done: number, total: number) => void;
}

/** Progress is logged at this page interval. */
const LOG_EVERY = 25;

export function ocrStoreKey(pdfBytes: Uint8Array, engine: OcrEngine): string {
    return sha256Hex(`${sha256Hex(pdfBytes)}|${RENDERER_ID}|${engine.id}`).slice(0, 32);
}

export async function recognizeDocument(
    pdfBytes: Uint8Array,
    pages: readonly RawPage[],
    engine: OcrEngine,
    opts: RecognizeOptions,
): Promise<OcrPage[]> {
    const key = ocrStoreKey(pdfBytes, engine);
    const results = new Map<number, OcrWord[]>();
    const pending: RawPage[] = [];
    for (const page of pages) {
        const cached = await opts.store.read(key, page.pageIndex);
        if (cached === null) {
            pending.push(page);
        } else {
            results.set(page.pageIndex, cached);
        }
    }
    if (pending.length > 0) {
        opts.log.info(`OCR: ${pending.length}/${pages.length} pages to recognize (${engine.id})`);
    }

    const renderer = new PageRenderer(pdfBytes);
    const inFlight = new Set<Promise<void>>();
    try {
        let done = 0;
        for (const page of pending) {
            const rendered = renderer.render(page.pageIndex, page.viewBox);
            const task = engine.recognize(rendered).then(async (words) => {
                await opts.store.write(key, page.pageIndex, words);
                results.set(page.pageIndex, words);
                done += 1;
                opts.onPage?.(done, pending.length);
                if (done % LOG_EVERY === 0 || done === pending.length) {
                    opts.log.info(`OCR: ${done}/${pending.length} pages recognized`);
                }
            });
            const tracked = task.finally(() => inFlight.delete(tracked));
            inFlight.add(tracked);
            if (inFlight.size >= opts.maxInFlight) {
                await Promise.race(inFlight);
            }
        }
        await Promise.all(inFlight);
    } catch (err) {
        // Let every in-flight page settle so no rejection escapes unobserved.
        await Promise.allSettled(inFlight);
        throw err;
    } finally {
        renderer.close();
    }

    return pages.map((p) => ({ pageIndex: p.pageIndex, words: results.get(p.pageIndex) ?? [] }));
}
