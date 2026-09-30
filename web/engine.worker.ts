// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
import { zipSync } from "fflate";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import {
    createLogger,
    MemoryOcrPageStore,
    type ModuleDocument,
    RENDER_DPI,
    runModule,
    targetFor,
} from "../src/index.ts";
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
/** Leave a core for the page and the renderer. */
const ocrWorkers = Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2));

function post(message: WorkerMessage, transfer: Transferable[] = []): void {
    self.postMessage(message, transfer);
}

async function run(request: RunRequest): Promise<void> {
    const log = createLogger("info", "", (_level, line) => post({ type: "log", line }));
    const documents: ModuleDocument[] = [];
    for (const { pdf, target: id } of request.documents) {
        const target = targetFor(id);
        if (target === null) {
            post({ type: "error", message: `unknown target schema ${JSON.stringify(id)}` });
            return;
        }
        documents.push({ pdf: new Uint8Array(pdf), target });
    }
    const vendorBase = new URL(`${import.meta.env.BASE_URL}vendor/tesseract/`, self.location.origin).href;
    const ocr = await BrowserTesseractEngine.create(ocrWorkers, RENDER_DPI, vendorBase);
    try {
        const result = await runModule(documents, {
            ocr,
            ocrStore: new MemoryOcrPageStore(),
            maxInFlight: ocrWorkers * 2,
            log,
            onProgress: (progress) => post({ type: "progress", ...progress }),
        });
        if (result.module === null) {
            post({ type: "refused", refused: result.refused });
            return;
        }
        const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
        const encoder = new TextEncoder();
        const summary: PackSummary[] = [];
        for (const file of result.module.files) {
            const bytes = typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents;
            entries[file.relPath] = [bytes, { mtime: ZIP_MTIME }];
            const pack = /\/packs\/(?<name>[^/]+)\.db$/u.exec(file.relPath)?.groups?.["name"];
            if (pack !== undefined && typeof file.contents === "string") {
                summary.push({
                    pack,
                    documents: file.contents.split("\n").filter((l) => l.length > 0).length,
                });
            }
        }
        const zip = zipSync(entries, { level: 9 });
        post(
            {
                type: "result",
                zip: zip.buffer,
                moduleId: result.module.id,
                packs: summary,
                documents: summary.reduce((n, p) => n + p.documents, 0),
                assets: result.module.files.filter((f) => f.relPath.includes("/assets/")).length,
                warnings: result.warnings.length,
                refused: result.refused,
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
