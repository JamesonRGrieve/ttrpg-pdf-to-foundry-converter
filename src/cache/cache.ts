// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IR, ImageAsset, ImageAssets } from "../types/ir.ts";
import { ENGINE_VERSION, IR_VERSION } from "../version.ts";
import { sha256Hex } from "../util/hash.ts";

/**
 * Intermediate cache (spec §2.2). Stages 1-3 (extract→normalize→images) are a
 * deterministic function of the complete PDF, so their result (IR + image
 * assets) is cached under a key of `sha256(pdf) + engine_version + ir_version`.
 * Any change to those invalidates the cache.
 *
 * The cache is a pure optimization: deleting it and re-running produces
 * identical output (G1 vs G1b). There is NO entry point that starts from an
 * intermediate (§2.2 rule 3) — the cache is only ever read when the complete
 * PDF hashes to the same key. The content hash is used locally only; it is
 * never emitted, never written to a tracked path, never logged to a shared sink
 * (C2).
 */

export function cacheKey(pdfBytes: Uint8Array): string {
    return sha256Hex(`${sha256Hex(pdfBytes)}|eng:${ENGINE_VERSION}|ir:${IR_VERSION}`).slice(0, 32);
}

interface CachedAssetMeta {
    assetId: string;
    ext: string;
    tier: "A" | "B";
    width: number | null;
    height: number | null;
    sourceObjectIds: string[];
}

interface CacheManifest {
    engineVersion: string;
    irVersion: number;
    assets: CachedAssetMeta[];
    placements: ImageAssets["placements"];
}

export interface CachedIntermediate {
    ir: IR;
    assets: ImageAssets;
}

function keyDir(cacheDir: string, key: string): string {
    return join(cacheDir, key);
}

export function readCache(cacheDir: string, key: string): CachedIntermediate | null {
    const dir = keyDir(cacheDir, key);
    const irPath = join(dir, "ir.json");
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(irPath) || !existsSync(manifestPath)) {
        return null;
    }
    const ir = JSON.parse(readFileSync(irPath, "utf8")) as IR;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CacheManifest;
    if (manifest.engineVersion !== ENGINE_VERSION || manifest.irVersion !== IR_VERSION) {
        return null;
    }
    const assets: ImageAsset[] = manifest.assets.map((meta) => ({
        assetId: meta.assetId,
        ext: meta.ext,
        tier: meta.tier,
        bytes: new Uint8Array(readFileSync(join(dir, "assets", `${meta.assetId}.${meta.ext}`))),
        width: meta.width,
        height: meta.height,
        placement: null,
        sourceObjectIds: meta.sourceObjectIds,
    }));
    return { ir, assets: { assets, placements: manifest.placements } };
}

export function writeCache(cacheDir: string, key: string, value: CachedIntermediate): void {
    const dir = keyDir(cacheDir, key);
    const assetsDir = join(dir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(dir, "ir.json"), JSON.stringify(value.ir), "utf8");
    const manifest: CacheManifest = {
        engineVersion: ENGINE_VERSION,
        irVersion: IR_VERSION,
        assets: value.assets.assets.map((a) => ({
            assetId: a.assetId,
            ext: a.ext,
            tier: a.tier,
            width: a.width,
            height: a.height,
            sourceObjectIds: a.sourceObjectIds,
        })),
        placements: value.assets.placements,
    };
    for (const asset of value.assets.assets) {
        writeFileSync(join(assetsDir, `${asset.assetId}.${asset.ext}`), asset.bytes);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
}

/** Remove the entire cache tree (used by `clean` and cold-cache CI runs). */
export function clearCache(cacheDir: string): void {
    if (existsSync(cacheDir)) {
        for (const entry of readdirSync(cacheDir)) {
            rmSync(join(cacheDir, entry), { recursive: true, force: true });
        }
    }
}
