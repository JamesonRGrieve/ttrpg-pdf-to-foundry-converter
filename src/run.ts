// SPDX-License-Identifier: AGPL-3.0-or-later
import { infer } from "./infer/pipeline.ts";
import { LINES, type Line } from "./infer/schema.ts";
import type { TargetSchema } from "./infer/targets.ts";
import type { Logger } from "./logger.ts";
import { arbitrate } from "./ocr/arbitrate.ts";
import { recognizeDocument, type OcrPageStore } from "./ocr/recognize.ts";
import { RENDERER_ID } from "./ocr/render.ts";
import type { OcrEngine } from "./ocr/types.ts";
import { emit, type EmittedPack } from "./stages/emit.ts";
import { EXTRACTOR_ID, extract } from "./stages/extract.ts";
import { homologate } from "./stages/homologate.ts";
import { recoverImages } from "./stages/images.ts";
import { type BuiltModule, buildModule, MODULE_ASSET_PLACEHOLDER } from "./stages/module.ts";
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
    /** The document's packs, each with its documents. */
    packs: EmittedPack[];
    assets: AssetFile[];
    /** What the document calls itself, slugged (names its packs). */
    book: string;
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
    /** The user's choice of output schema (game line); never inferred from the document. */
    target: TargetSchema;
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
    const inferred = infer(read.ir, opts.log, opts.target);
    const assetExt = new Map(read.assets.assets.map((a) => [a.assetId, a.ext] as const));
    const emitted = emit(inferred.graph, assetExt, { assetRefPrefix: opts.assetRefPrefix });
    return {
        encrypted: false,
        packs: [...emitted.packs.values()].sort((a, b) => byteCompare(a.pack, b.pack)),
        assets: read.assets.assets
            .map((a) => ({ relPath: `${a.assetId}.${a.ext}`, bytes: a.bytes }))
            .sort((a, b) => byteCompare(a.relPath, b.relPath)),
        book: inferred.book,
        warnings: emitted.warnings,
        cacheHit: read.cacheHit,
    };
}

/** Progress through a run of several documents. */
export interface ModuleProgress {
    /** Zero-based index of the document being read. */
    document: number;
    documents: number;
    /** Pages recognized of that document, and its page count. */
    page: number;
    pages: number;
}

export type ModuleOptions = Omit<EngineOptions, "assetRefPrefix" | "onOcrPage" | "target"> & {
    onProgress?: (progress: ModuleProgress) => void;
};

/** One PDF and the output schema the user chose for it. */
export interface ModuleDocument {
    pdf: Uint8Array;
    target: TargetSchema;
}

export interface ModuleResult {
    /** The module, or null when every document was refused. */
    module: BuiltModule | null;
    /** Indexes (into the input list) of documents refused as encrypted. */
    refused: number[];
    warnings: string[];
}

/** Human-readable label of a pack from its name (`<line>-<book>-<category>`). */
function packLabel(pack: string, line: string): string {
    const rest = pack.startsWith(`${line}-`) ? pack.slice(line.length + 1) : pack;
    return rest
        .split("-")
        .filter((w) => w.length > 0)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

/**
 * Convert several PDFs, each in the target schema the user chose for it, into
 * one Foundry module. An entity printed in several lines' PDFs becomes one
 * homologated document. The module's bytes depend only on the documents'
 * content and targets, not the order given.
 */
export async function runModule(
    documents: readonly ModuleDocument[],
    opts: ModuleOptions,
): Promise<ModuleResult> {
    const results: (EngineResult & { line: Line })[] = [];
    const refused: number[] = [];
    for (const [index, { pdf, target }] of documents.entries()) {
        const { onProgress, ...engineOpts } = opts;
        const result = await runEngine(pdf, {
            ...engineOpts,
            target,
            assetRefPrefix: MODULE_ASSET_PLACEHOLDER,
            ...(onProgress === undefined
                ? {}
                : {
                      onOcrPage: (page: number, pages: number) =>
                          onProgress({ document: index, documents: documents.length, page, pages }),
                  }),
        });
        if (result.encrypted) {
            refused.push(index);
        } else {
            results.push({ ...result, line: target.line });
        }
    }
    const warnings = results.flatMap((r) => r.warnings);
    if (results.length === 0) {
        return { module: null, refused, warnings };
    }
    const homologated = homologate(results.map((r) => ({ line: r.line, packs: r.packs })));
    const lines = new Set(results.map((r) => r.line));
    const module = buildModule({
        packs: homologated.flatMap(({ line, packs }) =>
            packs.map((p) => ({
                name: p.pack,
                label: packLabel(p.pack, line),
                documentType: p.documentType,
                documents: p.documents,
            })),
        ),
        assets: results.flatMap((r) => r.assets),
        sources: results.map((r) => r.book),
        provenance: {
            engineVersion: ENGINE_VERSION,
            irVersion: IR_VERSION,
            extractor: EXTRACTOR_ID,
            renderer: RENDERER_ID,
            ocr: opts.ocr.id,
            // One line reads as before; several list in the system's line order.
            target: LINES.filter((l) => lines.has(l)).join(","),
        },
    });
    return { module, refused, warnings };
}
