// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Public, runtime-neutral engine API (usable in Node and in browsers). The
 * Node CLI and its filesystem adapters live under `node/`.
 */
export { createLogger, type Logger, type LogLevel, type LogSink } from "./logger.ts";
export {
    runEngine,
    runModule,
    readCacheKey,
    type ModuleDocument,
    type ModuleOptions,
    type ModuleProgress,
    type ModuleResult,
    type EngineOptions,
    type EngineResult,
    type RunResult,
    type AssetFile,
    type IrCache,
    type ReadDocument,
} from "./run.ts";
export { MemoryOcrPageStore, type OcrPageStore } from "./ocr/recognize.ts";
export { LINES, type Line } from "./infer/schema.ts";
export {
    DEFAULT_TARGET,
    DND5E_TARGETS,
    type Dnd5eTarget,
    type SystemId,
    type Target,
    TARGET_IDS,
    TARGETS,
    targetFor,
    targetId,
    type TargetSchema,
} from "./infer/targets.ts";
export { RENDER_DPI, RENDERER_ID } from "./ocr/render.ts";
export {
    CORE_BUILD,
    LANGUAGE,
    MODEL_PACKAGE,
    CELL_CHARS,
    CELL_SEG_MODE,
    MODEL_VARIANT,
    PAGE_SEG_MODE,
    recognitionParams,
    SPARSE_SEG_MODE,
    tesseractEngineId,
    wordsFromBlocks,
    type TesseractBlocks,
} from "./ocr/tesseract-config.ts";
export type { OcrEngine, OcrWord, OcrPage, RenderedPage } from "./ocr/types.ts";
export { emit, type EmittedPack } from "./stages/emit.ts";
export { buildModule, type BuiltModule, type ModuleFile, SYSTEM_ID } from "./stages/module.ts";
export { CONVERTER_URL, ENGINE_VERSION, IR_VERSION, RELEASE, RELEASE_FEED_URL } from "./version.ts";
export { PINS } from "./pins.ts";
export type { IR, RawDoc, ImageAssets } from "./types/ir.ts";
export type { Entity, EntityGraph } from "./types/entity.ts";
