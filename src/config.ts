// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from "node:path";
import type { LogLevel } from "./logger.ts";

/**
 * Runtime configuration and process exit codes.
 *
 * Paths default to the sibling-submodule layout described in spec §1: source
 * PDFs are read-only input at `../pdfs`, output lands in the `.foundry-system`
 * pack tree, and images extract under its asset tree. Every path is
 * overridable so the engine carries no assumption about a specific checkout.
 */

export const EXIT = {
    /** Clean run. */
    SUCCESS: 0,
    /** A required field was unmatched, or another recoverable error at end of run. */
    ERROR: 1,
    /** No profile supplied in non-interactive mode (fail closed, §7.3 / A1). */
    NO_PROFILE: 2,
    /** Encrypted / DRM'd input refused, not decrypted (C4 / §4 / G6). */
    ENCRYPTED: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface EngineConfig {
    /** Read-only source corpus (the engine never writes here). */
    inputDir: string;
    /** Output corpus root — the `.foundry-system` `src/packs` tree. */
    packsDir: string;
    /** Extracted embedded images (Tier A). */
    assetsDir: string;
    /** Separate subtree for Tier B rasters, excludable by path from Tier A gates. */
    rasterAssetsDir: string;
    /** Regenerable intermediates, gitignored (§2.2). */
    cacheDir: string;
    /** Bundled + user profile search root. */
    profilesDir: string;
    /** User-local enrichment lockfile (never distributed, §10.5). */
    lockfilePath: string;
    /**
     * Deployment path prefix written into document image references. Does NOT
     * feed the `_id` hash (image refs are content-addressed there), so changing
     * it never forks ids across machines.
     */
    assetRefPrefix: string;
    logLevel: LogLevel;

    // Feature flags — all default off / fail-closed.
    /** Tier B raster fallback (§6.2). Off by default. */
    rasterFallback: boolean;
    /** Tier C wiki enrichment (§10). Off unless explicitly enabled. */
    enrich: boolean;
    /** Re-resolve enrichment instead of reading the lockfile (§10.5). */
    refreshEnrichment: boolean;
    /** Hard-disable all network access (§10.3). */
    offline: boolean;
    /** Download resolved wiki images into a separate subtree (§10.7). Off by default. */
    localizeImages: boolean;
}

export interface ConfigOverrides {
    inputDir?: string;
    packsDir?: string;
    assetsDir?: string;
    rasterAssetsDir?: string;
    cacheDir?: string;
    profilesDir?: string;
    lockfilePath?: string;
    assetRefPrefix?: string;
    logLevel?: LogLevel;
    rasterFallback?: boolean;
    enrich?: boolean;
    refreshEnrichment?: boolean;
    offline?: boolean;
    localizeImages?: boolean;
}

/**
 * Build a config rooted at `repoRoot` (the engine repo). Defaults resolve the
 * sibling `.foundry-system` output tree and the `../pdfs` source corpus.
 */
export function makeConfig(repoRoot: string, overrides: ConfigOverrides = {}): EngineConfig {
    const root = resolve(repoRoot);
    const systemPacks = resolve(root, "..", ".foundry-system", "src", "packs");
    const systemAssets = resolve(root, "..", ".foundry-system", "src", "packs", "images", "extracted");
    return {
        inputDir: overrides.inputDir ?? resolve(root, "..", "pdfs"),
        packsDir: overrides.packsDir ?? systemPacks,
        assetsDir: overrides.assetsDir ?? systemAssets,
        rasterAssetsDir: overrides.rasterAssetsDir ?? resolve(systemAssets, "..", "extracted-raster"),
        cacheDir: overrides.cacheDir ?? resolve(root, ".cache"),
        profilesDir: overrides.profilesDir ?? resolve(root, "profiles"),
        lockfilePath: overrides.lockfilePath ?? resolve(root, ".cache", "enrichment.lock.yml"),
        assetRefPrefix: overrides.assetRefPrefix ?? "systems/wh40k-rpg/packs/images/extracted",
        logLevel: overrides.logLevel ?? "info",
        rasterFallback: overrides.rasterFallback ?? false,
        enrich: overrides.enrich ?? false,
        refreshEnrichment: overrides.refreshEnrichment ?? false,
        offline: overrides.offline ?? false,
        localizeImages: overrides.localizeImages ?? false,
    };
}
