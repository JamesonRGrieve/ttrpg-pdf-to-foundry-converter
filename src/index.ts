// SPDX-License-Identifier: AGPL-3.0-or-later

/** Public engine API. The CLI (`cli.ts`) is a thin wrapper over these. */
export { makeConfig, EXIT, type EngineConfig, type ConfigOverrides, type ExitCode } from "./config.ts";
export { createLogger, type Logger, type LogLevel } from "./logger.ts";
export { runPipeline, type PipelineResult, type ProfileMeta } from "./pipeline.ts";
export { extract } from "./stages/extract.ts";
export { normalize } from "./stages/normalize.ts";
export { recoverImages } from "./stages/images.ts";
export { detect, type DetectionResult, type ProfileSuggestion } from "./stages/detect.ts";
export { apply } from "./stages/apply.ts";
export { emit, serializeDocument } from "./stages/emit.ts";
export { loadProfile, loadProfilesDir } from "./profile/load.ts";
export { HttpWikiClient } from "./enrich/mediawiki.ts";
export type { WikiClient, WikiCandidate } from "./enrich/types.ts";
export { ENGINE_VERSION, IR_VERSION, RESOLVER_VERSION } from "./version.ts";
export type { IR, RawDoc, ImageAssets } from "./types/ir.ts";
export type { Profile } from "./types/profile.ts";
export type { Entity, EntityGraph } from "./types/entity.ts";
