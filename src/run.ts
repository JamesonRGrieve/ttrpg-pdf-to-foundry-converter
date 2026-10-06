// SPDX-License-Identifier: AGPL-3.0-or-later
import { inferDnd5e } from "./infer/dnd5e/index.ts";
import { infer } from "./infer/pipeline.ts";
import type { Line } from "./infer/schema.ts";
import { type SystemId, type Target, TARGET_IDS, targetId } from "./infer/targets.ts";
import type { Logger } from "./logger.ts";
import { arbitrate } from "./ocr/arbitrate.ts";
import type { PageReader } from "./ocr/ppocr/reader.ts";
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
import { ENGINE_VERSION, IR_VERSION, RELEASE } from "./version.ts";

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
    /** The user's choice of output schema (game line or ruleset); never inferred from the document. */
    target: Target;
    ocr: OcrEngine;
    /** Reads pages with no text layer (scans) first; see `recognizeDocument`. */
    scanReader: PageReader;
    ocrStore: OcrPageStore;
    /** Pages rendered ahead of recognition (bounds memory). */
    maxInFlight: number;
    /** Deployment path prefix written into document image references. */
    assetRefPrefix: string;
    log: Logger;
    irCache?: IrCache;
    onOcrPage?: (done: number, total: number) => void;
}

/**
 * Cache key for the read document: PDF content + engine/IR versions + OCR
 * identity (each recognizer mode's id; how the scan passes use them is code,
 * covered by the IR version).
 */
export function readCacheKey(pdfBytes: Uint8Array, ocr: OcrEngine, scanReader: PageReader): string {
    return sha256Hex(
        `${sha256Hex(pdfBytes)}|eng:${ENGINE_VERSION}|ir:${IR_VERSION}|ocr:${RENDERER_ID}|${ocr.id}|${ocr.sparseId}|${ocr.cellId}|${scanReader.id}`,
    ).slice(0, 32);
}

async function readDocument(
    pdfBytes: Uint8Array,
    opts: EngineOptions,
): Promise<(ReadDocument & { cacheHit: boolean }) | null> {
    const key = readCacheKey(pdfBytes, opts.ocr, opts.scanReader);
    const cached = opts.irCache === undefined ? null : await opts.irCache.read(key);
    if (cached !== null) {
        opts.log.info("using cached IR + image assets");
        return { ...cached, cacheHit: true };
    }
    const raw = await extract(pdfBytes);
    if (raw.encrypted) {
        return null;
    }
    const ocr = await recognizeDocument(
        pdfBytes,
        raw.pages,
        opts.ocr,
        {
            store: opts.ocrStore,
            maxInFlight: opts.maxInFlight,
            log: opts.log,
            ...(opts.onOcrPage === undefined ? {} : { onPage: opts.onOcrPage }),
        },
        {
            pages: new Set(raw.pages.filter((p) => !p.hasTextLayer).map((p) => p.pageIndex)),
            reader: opts.scanReader,
        },
    );
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
    const inferred =
        opts.target.system === "dnd5e"
            ? inferDnd5e(read.ir, opts.log, opts.target)
            : infer(read.ir, opts.log, opts.target);
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
    target: Target;
}

/** The one game system a run's targets write for; a module belongs to a single system. */
export function moduleSystem(documents: readonly ModuleDocument[]): SystemId {
    const systems = [...new Set(documents.map((d) => d.target.system))];
    const [system] = systems;
    if (system === undefined || systems.length > 1) {
        throw new Error(
            `one module holds one game system's packs; convert the PDFs for ${systems.join(" and ")} in separate runs`,
        );
    }
    return system;
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
    const system = moduleSystem(documents);
    const results: (EngineResult & { target: Target })[] = [];
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
            results.push({ ...result, target });
        }
    }
    const warnings = results.flatMap((r) => r.warnings);
    if (results.length === 0) {
        return { module: null, refused, warnings };
    }
    // wh40k-rpg lines share entities across lines (homologated); dnd5e rulesets keep their own.
    const wh40k: { line: Line; packs: EmittedPack[] }[] = results.flatMap((r) =>
        r.target.system === "wh40k-rpg" ? [{ line: r.target.line, packs: r.packs }] : [],
    );
    const grouped: { group: string; packs: EmittedPack[] }[] =
        system === "wh40k-rpg"
            ? homologate(wh40k).map(({ line, packs }) => ({ group: line, packs }))
            : results.map((r) => ({ group: targetId(r.target), packs: r.packs }));
    const ids = new Set(results.map((r) => targetId(r.target)));
    const module = buildModule({
        system,
        packs: grouped.flatMap(({ group, packs }) =>
            packs.map((p) => ({
                name: p.pack,
                label: packLabel(p.pack, group),
                documentType: p.documentType,
                documents: p.documents,
            })),
        ),
        assets: results.flatMap((r) => r.assets),
        sources: results.map((r) => r.book),
        provenance: {
            release: RELEASE,
            engineVersion: ENGINE_VERSION,
            irVersion: IR_VERSION,
            extractor: EXTRACTOR_ID,
            renderer: RENDERER_ID,
            ocr: `${opts.ocr.id}|${opts.scanReader.id}`,
            // One target reads as its id; several list in the system's order.
            target: TARGET_IDS.filter((id) => ids.has(id)).join(","),
        },
    });
    return { module, refused, warnings };
}
