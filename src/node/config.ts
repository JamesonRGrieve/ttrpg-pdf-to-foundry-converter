// SPDX-License-Identifier: AGPL-3.0-or-later
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LogLevel } from "../logger.ts";

/**
 * Runtime configuration and process exit codes. The only input is a PDF; these
 * settings only say where output, assets and caches go and how much CPU OCR
 * may use. Modules default under the OS temp directory. The cache defaults to
 * `.tmp/cache` in the working directory: it grows large, and a RAM-backed
 * temp directory would hold it in memory.
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
    /** Where the module is written: `<modulesDir>/<module id>/…` (a Foundry `Data/modules` directory works). */
    modulesDir: string;
    /** Regenerable intermediates (IR, OCR). */
    cacheDir: string;
    /** OCR recognizer threads. */
    ocrWorkers: number;
    logLevel: LogLevel;
}

export type ConfigOverrides = Partial<EngineConfig>;

const DEFAULT_ROOT = join(tmpdir(), "foundry-pdf-parser");
/** The default cache, relative to the working directory. */
const DEFAULT_CACHE_DIR = join(".tmp", "cache");

export function makeConfig(overrides: ConfigOverrides = {}): EngineConfig {
    return {
        modulesDir: resolve(overrides.modulesDir ?? join(DEFAULT_ROOT, "modules")),
        cacheDir: resolve(overrides.cacheDir ?? DEFAULT_CACHE_DIR),
        ocrWorkers: overrides.ocrWorkers ?? Math.max(1, Math.floor(availableParallelism() / 2)),
        logLevel: overrides.logLevel ?? "info",
    };
}
