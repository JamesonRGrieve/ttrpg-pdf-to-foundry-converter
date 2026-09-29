// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
import { zipSync } from "fflate";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { createLogger, MemoryOcrPageStore, RENDER_DPI, runEngine } from "../src/index.ts";
import type { PackSummary, RunRequest, WorkerMessage } from "./protocol.ts";
import { BrowserTesseractEngine } from "./tesseract-browser.ts";

/**
 * Runs the engine entirely in this browser tab, off the main thread. Nothing
 * leaves the machine: the PDF arrives as bytes from the page, and the packs
 * go back as a zip.
 */

declare const self: DedicatedWorkerGlobalScope;

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Fixed zip entry timestamp, so the archive's bytes depend only on its
 * contents. Zip stores local wall-clock time, so the date is built from local
 * fields (the same stored value in every timezone) at noon on a day inside the
 * format's 1980–2099 range.
 */
const ZIP_MTIME = new Date(1980, 0, 2, 12, 0, 0);
const ASSET_REF_PREFIX = "systems/wh40k-rpg/packs/images/extracted";
/** Leave a core for the page and the renderer. */
const ocrWorkers = Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2));

function post(message: WorkerMessage, transfer: Transferable[] = []): void {
    self.postMessage(message, transfer);
}

async function run(request: RunRequest): Promise<void> {
    const log = createLogger("info", "", (_level, line) => post({ type: "log", line }));
    const vendorBase = new URL(`${import.meta.env.BASE_URL}vendor/tesseract/`, self.location.origin).href;
    const ocr = await BrowserTesseractEngine.create(ocrWorkers, RENDER_DPI, vendorBase);
    try {
        const result = await runEngine(new Uint8Array(request.pdf), {
            ocr,
            ocrStore: new MemoryOcrPageStore(),
            maxInFlight: ocrWorkers * 2,
            assetRefPrefix: ASSET_REF_PREFIX,
            log,
            onOcrPage: (done, total) => post({ type: "progress", done, total }),
        });
        if (result.encrypted) {
            post({ type: "refused" });
            return;
        }
        const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
        const encoder = new TextEncoder();
        const packs = new Map<string, number>();
        for (const file of result.files) {
            entries[`packs/${file.relPath}`] = [encoder.encode(file.contents), { mtime: ZIP_MTIME }];
            if (file.relPath.includes("/_source/")) {
                const pack = file.relPath.split("/").slice(0, 2).join("/");
                packs.set(pack, (packs.get(pack) ?? 0) + 1);
            }
        }
        for (const asset of result.assets) {
            entries[`assets/${asset.relPath}`] = [asset.bytes, { mtime: ZIP_MTIME }];
        }
        const zip = zipSync(entries, { level: 9 });
        const summary: PackSummary[] = [...packs.entries()]
            .map(([pack, documents]) => ({ pack, documents }))
            .sort((a, b) => (a.pack < b.pack ? -1 : 1));
        post(
            {
                type: "result",
                zip: zip.buffer,
                packs: summary,
                documents: summary.reduce((n, p) => n + p.documents, 0),
                assets: result.assets.length,
                warnings: result.warnings.length,
            },
            [zip.buffer],
        );
    } finally {
        await ocr.close();
    }
}

self.addEventListener("message", (event: MessageEvent<RunRequest>) => {
    run(event.data).catch((err: unknown) => {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    });
});
// Imported modules finish their top-level awaits before this line runs; a
// request posted earlier would have found no listener, so announce readiness.
post({ type: "ready" });
