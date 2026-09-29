// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Public, runtime-neutral engine API (usable in Node and in browsers). The
 * Node CLI and its filesystem adapters live under `node/`.
 */
export { createLogger, type Logger, type LogLevel, type LogSink } from "./logger.ts";
export {
    runEngine,
    readCacheKey,
    type EngineOptions,
    type EngineResult,
    type RunResult,
    type AssetFile,
    type IrCache,
    type ReadDocument,
} from "./run.ts";
export { MemoryOcrPageStore, type OcrPageStore } from "./ocr/recognize.ts";
export { RENDER_DPI, RENDERER_ID } from "./ocr/render.ts";
export {
    CORE_BUILD,
    LANGUAGE,
    MODEL_PACKAGE,
    MODEL_VARIANT,
    recognitionParams,
    tesseractEngineId,
    wordsFromBlocks,
    type TesseractBlocks,
} from "./ocr/tesseract-config.ts";
export type { OcrEngine, OcrWord, OcrPage, RenderedPage } from "./ocr/types.ts";
export { emit, serializeDocument } from "./stages/emit.ts";
export { ENGINE_VERSION, IR_VERSION } from "./version.ts";
export { PINS } from "./pins.ts";
export type { IR, RawDoc, ImageAssets } from "./types/ir.ts";
export type { Entity, EntityGraph } from "./types/entity.ts";
