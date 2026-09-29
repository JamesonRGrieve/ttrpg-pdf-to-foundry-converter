// SPDX-License-Identifier: AGPL-3.0-or-later
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LogLevel } from "../logger.ts";

/**
 * Runtime configuration and process exit codes. The only input is a PDF; these
 * settings only say where output, assets and caches go and how much CPU OCR
 * may use. Everything defaults under the OS temp directory, so a run never
 * writes into a working tree unless told to.
 */

export const EXIT = {
    /** Clean run. */
    SUCCESS: 0,
    /** Bad arguments or a failed run. */
    ERROR: 1,
    /** Encrypted / DRM'd input refused, not decrypted. */
    ENCRYPTED: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface EngineConfig {
    /** Output pack corpus root: `<packsDir>/<line>/<pack>/_source/*.json`. */
    packsDir: string;
    /** Extracted embedded images. */
    assetsDir: string;
    /** Regenerable intermediates (IR, OCR). */
    cacheDir: string;
    /**
     * Deployment path prefix written into document image references. Does NOT
     * feed the `_id` hash (image refs are content-addressed there).
     */
    assetRefPrefix: string;
    /** OCR recognizer threads. */
    ocrWorkers: number;
    logLevel: LogLevel;
}

export type ConfigOverrides = Partial<EngineConfig>;

const DEFAULT_ROOT = join(tmpdir(), "foundry-pdf-parser");

export function makeConfig(overrides: ConfigOverrides = {}): EngineConfig {
    return {
        packsDir: resolve(overrides.packsDir ?? join(DEFAULT_ROOT, "packs")),
        assetsDir: resolve(overrides.assetsDir ?? join(DEFAULT_ROOT, "assets")),
        cacheDir: resolve(overrides.cacheDir ?? join(DEFAULT_ROOT, "cache")),
        assetRefPrefix: overrides.assetRefPrefix ?? "systems/wh40k-rpg/packs/images/extracted",
        ocrWorkers: overrides.ocrWorkers ?? Math.max(1, Math.floor(availableParallelism() / 2)),
        logLevel: overrides.logLevel ?? "info",
    };
}
