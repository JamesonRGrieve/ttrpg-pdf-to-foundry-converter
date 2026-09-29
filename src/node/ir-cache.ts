// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IrCache, ReadDocument } from "../run.ts";
import type { IR, ImageAsset, ImageAssets } from "../types/ir.ts";
import { ENGINE_VERSION, IR_VERSION } from "../version.ts";

/**
 * On-disk cache of the read document (IR + image assets), keyed by the
 * engine (`readCacheKey`: PDF content, engine/IR versions, OCR identity).
 *
 * A pure optimization: deleting it and re-running produces identical output.
 * There is no entry point that starts from an intermediate — the cache is only
 * read when the complete PDF hashes to the same key. The key never leaves the
 * cache directory.
 */

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

export class FileIrCache implements IrCache {
    constructor(private readonly cacheDir: string) {}

    async read(key: string): Promise<ReadDocument | null> {
        const dir = join(this.cacheDir, key);
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

    async write(key: string, value: ReadDocument): Promise<void> {
        const dir = join(this.cacheDir, key);
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
}
