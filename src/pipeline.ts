// SPDX-License-Identifier: AGPL-3.0-or-later
import { stringify as stringifyYaml } from "yaml";
import type { EngineConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { IR, ImageAssets } from "./types/ir.ts";
import type { Profile } from "./types/profile.ts";
import type { WikiClient } from "./enrich/types.ts";
import { cacheKey, readCache, writeCache } from "./cache/cache.ts";
import { apply } from "./stages/apply.ts";
import { emit, type EmittedFile } from "./stages/emit.ts";
import { enrich } from "./stages/enrich.ts";
import { EXTRACTOR_ID, extract } from "./stages/extract.ts";
import { recoverImages } from "./stages/images.ts";
import { normalize } from "./stages/normalize.ts";
import { ENGINE_VERSION, IR_VERSION, RESOLVER_VERSION } from "./version.ts";
import { byteCompare } from "./util/ordered.ts";

/**
 * Pipeline orchestrator (spec §3). Runs `[1] Extract → [2] Normalize →
 * [3] Images → [5] Apply → [6] Enrich → [7] Emit`. Stages 1-3 are cached as a
 * deterministic function of the complete PDF (§2.2); stages 5-7 read only the
 * IR and image assets (§3).
 *
 * The result is computed in memory (files/assets/provenance as bytes) and
 * written separately, so determinism gates and tests can compare outputs
 * without touching disk. Tier A output (entities + assets) is byte-identical
 * whether or not enrichment ran (§2.3 / §10.6).
 */

export interface ProfileMeta {
    sha256: string;
    sourceBasename: string;
}

export interface AssetFile {
    /** Path relative to the asset tree root. */
    relPath: string;
    bytes: Uint8Array;
}

export interface ProvenanceFile {
    /** Path relative to the packs root. */
    relPath: string;
    contents: string;
}

export interface PipelineResult {
    encrypted: boolean;
    files: EmittedFile[];
    assets: AssetFile[];
    provenance: ProvenanceFile[];
    enrichmentReport: string | null;
    warnings: string[];
    errors: string[];
    requestCount: number;
    cacheHit: boolean;
}

function provenanceRecord(
    group: string,
    pack: string,
    profile: Profile,
    meta: ProfileMeta,
    enrichEnabled: boolean,
    lockfileSha: string | null,
): string {
    const record = {
        engine_version: ENGINE_VERSION,
        ir_version: IR_VERSION,
        extractor: EXTRACTOR_ID,
        profile_id: profile.profile_id,
        profile_version: profile.version,
        profile_sha256: meta.sha256,
        source_basename: meta.sourceBasename,
        enrichment: {
            enabled: enrichEnabled,
            resolver_version: enrichEnabled ? RESOLVER_VERSION : null,
            lockfile_sha256: enrichEnabled ? lockfileSha : null,
        },
        pack: `${group}/${pack}`,
    };
    return stringifyYaml(record);
}

export async function runPipeline(
    pdfBytes: Uint8Array,
    profile: Profile,
    meta: ProfileMeta,
    config: EngineConfig,
    log: Logger,
    client: WikiClient | null,
): Promise<PipelineResult> {
    const key = cacheKey(pdfBytes);
    log.debug(`cache key ${key}`);

    let ir: IR;
    let assets: ImageAssets;
    let cacheHit = false;
    const cached = readCache(config.cacheDir, key);
    if (cached !== null) {
        ({ ir, assets } = cached);
        cacheHit = true;
        log.info("using cached IR + image assets");
    } else {
        const raw = await extract(pdfBytes);
        if (raw.encrypted) {
            return {
                encrypted: true,
                files: [],
                assets: [],
                provenance: [],
                enrichmentReport: null,
                warnings: [],
                errors: ["refused: encrypted PDF; supply a decrypted file"],
                requestCount: 0,
                cacheHit: false,
            };
        }
        ir = normalize(raw);
        assets = recoverImages(raw, log);
        writeCache(config.cacheDir, key, { ir, assets });
    }

    const applied = apply(profile, ir, assets);
    let enrichmentReport: string | null = null;
    let requestCount = 0;
    if (config.enrich && client !== null) {
        const result = await enrich(
            applied.graph,
            client,
            { lockfilePath: config.lockfilePath, refresh: config.refreshEnrichment },
            log,
        );
        enrichmentReport = result.report;
        requestCount = result.requestCount;
    }

    const assetExt = new Map(assets.assets.map((a) => [a.assetId, a.ext] as const));
    const emitted = emit(applied.graph, assetExt, { assetRefPrefix: config.assetRefPrefix });

    const provenance: ProvenanceFile[] = [...emitted.provenanceByPack.values()]
        .map((p) => ({
            relPath: `${p.group}/${p.pack}/provenance.yml`,
            contents: provenanceRecord(p.group, p.pack, profile, meta, config.enrich, null),
        }))
        .sort((a, b) => byteCompare(a.relPath, b.relPath));

    const assetFiles: AssetFile[] = assets.assets
        .map((a) => ({ relPath: `${a.assetId}.${a.ext}`, bytes: a.bytes }))
        .sort((a, b) => byteCompare(a.relPath, b.relPath));

    return {
        encrypted: false,
        files: emitted.files,
        assets: assetFiles,
        provenance,
        enrichmentReport,
        warnings: emitted.warnings,
        errors: applied.errors,
        requestCount,
        cacheHit,
    };
}
