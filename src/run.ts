// SPDX-License-Identifier: AGPL-3.0-or-later
import { infer } from "./infer/pipeline.ts";
import type { Logger } from "./logger.ts";
import { arbitrate } from "./ocr/arbitrate.ts";
import { recognizeDocument, type OcrPageStore } from "./ocr/recognize.ts";
import { RENDERER_ID } from "./ocr/render.ts";
import type { OcrEngine } from "./ocr/types.ts";
import { emit, serializeDocument, type EmittedFile } from "./stages/emit.ts";
import { EXTRACTOR_ID, extract } from "./stages/extract.ts";
import { recoverImages } from "./stages/images.ts";
import { normalize } from "./stages/normalize.ts";
import type { IR, ImageAssets } from "./types/ir.ts";
import { sha256Hex } from "./util/hash.ts";
import { byteCompare } from "./util/ordered.ts";
import { ENGINE_VERSION, IR_VERSION } from "./version.ts";

/**
 * The engine: complete PDF in, Foundry compendium documents out.
 *
 *   extract text layer + images → render & OCR every page → arbitrate the text
 *   layer against OCR → normalize → structural inference → emit
 *
 * Runtime-neutral: it runs unchanged in Node (the CLI) and in a browser (the
 * upload page). Storage and OCR are injected. The result is computed in memory
 * — documents, assets and provenance as bytes — so callers decide where it
 * goes. The PDF's content hash keys local caches only; it is never emitted.
 */

export interface AssetFile {
    /** Path relative to the asset tree root. */
    relPath: string;
    bytes: Uint8Array;
}

export interface EngineResult {
    encrypted: false;
    files: EmittedFile[];
    assets: AssetFile[];
    warnings: string[];
    cacheHit: boolean;
}

export type RunResult = EngineResult | { encrypted: true };

/** The extract → OCR → normalize → images result, cacheable per PDF. */
export interface ReadDocument {
    ir: IR;
    assets: ImageAssets;
}

export interface IrCache {
    read(key: string): Promise<ReadDocument | null>;
    write(key: string, value: ReadDocument): Promise<void>;
}

export interface EngineOptions {
    ocr: OcrEngine;
    ocrStore: OcrPageStore;
    /** Pages rendered ahead of recognition (bounds memory). */
    maxInFlight: number;
    /** Deployment path prefix written into document image references. */
    assetRefPrefix: string;
    log: Logger;
    irCache?: IrCache;
    onOcrPage?: (done: number, total: number) => void;
}

/** Cache key for the read document: PDF content + engine/IR versions + OCR identity. */
export function readCacheKey(pdfBytes: Uint8Array, ocr: OcrEngine): string {
    return sha256Hex(
        `${sha256Hex(pdfBytes)}|eng:${ENGINE_VERSION}|ir:${IR_VERSION}|ocr:${RENDERER_ID}|${ocr.id}`,
    ).slice(0, 32);
}

async function readDocument(
    pdfBytes: Uint8Array,
    opts: EngineOptions,
): Promise<(ReadDocument & { cacheHit: boolean }) | null> {
    const key = readCacheKey(pdfBytes, opts.ocr);
    const cached = opts.irCache === undefined ? null : await opts.irCache.read(key);
    if (cached !== null) {
        opts.log.info("using cached IR + image assets");
        return { ...cached, cacheHit: true };
    }
    const raw = await extract(pdfBytes);
    if (raw.encrypted) {
        return null;
    }
    const ocr = await recognizeDocument(pdfBytes, raw.pages, opts.ocr, {
        store: opts.ocrStore,
        maxInFlight: opts.maxInFlight,
        log: opts.log,
        ...(opts.onOcrPage === undefined ? {} : { onPage: opts.onOcrPage }),
    });
    const ir = normalize(arbitrate(raw, ocr));
    const assets = recoverImages(raw, opts.log);
    await opts.irCache?.write(key, { ir, assets });
    return { ir, assets, cacheHit: false };
}

export async function runEngine(pdfBytes: Uint8Array, opts: EngineOptions): Promise<RunResult> {
    const read = await readDocument(pdfBytes, opts);
    if (read === null) {
        return { encrypted: true };
    }
    const inferred = infer(read.ir, opts.log);
    const assetExt = new Map(read.assets.assets.map((a) => [a.assetId, a.ext] as const));
    const emitted = emit(inferred.graph, assetExt, { assetRefPrefix: opts.assetRefPrefix });

    const provenance = {
        engineVersion: ENGINE_VERSION,
        irVersion: IR_VERSION,
        extractor: EXTRACTOR_ID,
        renderer: RENDERER_ID,
        ocr: opts.ocr.id,
        lineKey: inferred.line,
        pageOffset: inferred.pageNumbering.offset,
    };
    const provenanceFiles: EmittedFile[] = [...emitted.provenanceByPack.values()].map((p) => ({
        relPath: `${p.group}/${p.pack}/provenance.json`,
        contents: serializeDocument({ ...provenance, pack: p.pack, documents: p.count }),
    }));

    return {
        encrypted: false,
        files: [...emitted.files, ...provenanceFiles].sort((a, b) => byteCompare(a.relPath, b.relPath)),
        assets: read.assets.assets
            .map((a) => ({ relPath: `${a.assetId}.${a.ext}`, bytes: a.bytes }))
            .sort((a, b) => byteCompare(a.relPath, b.relPath)),
        warnings: emitted.warnings,
        cacheHit: read.cacheHit,
    };
}
