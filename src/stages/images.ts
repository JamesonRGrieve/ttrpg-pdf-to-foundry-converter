// SPDX-License-Identifier: AGPL-3.0-or-later
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import type { Logger } from "../logger.ts";
import type { ImageAsset, ImageAssets, RawDoc, RawImageXObject } from "../types/ir.ts";
import { id16 } from "../util/hash.ts";
import { byteCompare, numAsc } from "../util/ordered.ts";

/**
 * Stage 3 — Image recovery, Tier A (spec §6.1). Two rules govern byte-stability:
 *  1. Prefer lossless passthrough. DCTDecode → write JPEG bytes directly;
 *     JPXDecode → write directly. No decode/re-encode round-trip (encoders are
 *     the largest source of cross-platform byte drift).
 *  2. Flate-decoded rasters are re-encoded to PNG with a PINNED encoder, fixed
 *     compression level, fixed filter strategy, and all ancillary chunks
 *     stripped (pngjs writes only IHDR/IDAT/IEND — no tIME/pHYs/gAMA/tEXt).
 *
 * Colorspace conversion is a fixed in-house transform at a stated intent — never
 * a system ICC profile (§6.1). Assets are content-addressed (§6.1): identical
 * bytes dedup to one file, and two users produce the same asset tree.
 *
 * Unsupported inputs (LZW/CCITT, indexed palettes, sub-byte depths, Flate with a
 * TIFF/unknown predictor we don't model) are refused with a warning rather than
 * guessed (§6.3 / §8.6). Tier B raster fallback is a separate, opt-in path.
 */

const PNG_ENCODE_OPTIONS = {
    // Fixed for determinism. filterType 0 (None) + fixed deflate settings.
    deflateLevel: 9,
    deflateStrategy: 3,
    filterType: 0,
} as const;

const COMPONENTS_BY_COLORSPACE: Readonly<Record<string, number>> = {
    DeviceGray: 1,
    CalGray: 1,
    G: 1,
    DeviceRGB: 3,
    CalRGB: 3,
    RGB: 3,
    DeviceCMYK: 4,
    CMYK: 4,
};

interface RasterResult {
    ext: string;
    bytes: Uint8Array;
    width: number;
    height: number;
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) {
        return a;
    }
    return pb <= pc ? b : c;
}

/** Reverse PNG per-row predictors (predictor >= 10). Modifies rows in place. */
function unfilterPng(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    let prevRow: Uint8Array | null = null;
    for (let r = 0; r < rows; r += 1) {
        const filterType = data[r * (rowBytes + 1)]!;
        const rowStart = r * (rowBytes + 1) + 1;
        const cur = new Uint8Array(rowBytes);
        for (let i = 0; i < rowBytes; i += 1) {
            const raw = data[rowStart + i]!;
            const left = i >= bpp ? cur[i - bpp]! : 0;
            const up = prevRow ? prevRow[i]! : 0;
            const upLeft = prevRow && i >= bpp ? prevRow[i - bpp]! : 0;
            let value: number;
            switch (filterType) {
                case 0:
                    value = raw;
                    break;
                case 1:
                    value = raw + left;
                    break;
                case 2:
                    value = raw + up;
                    break;
                case 3:
                    value = raw + Math.floor((left + up) / 2);
                    break;
                case 4:
                    value = raw + paeth(left, up, upLeft);
                    break;
                default:
                    value = raw;
                    break;
            }
            cur[i] = value & 0xff;
        }
        out.set(cur, r * rowBytes);
        prevRow = cur;
    }
    return out;
}

/** Reverse TIFF horizontal differencing (predictor 2), 8-bit components. */
function unfilterTiff(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
    const rows = Math.floor(data.length / rowBytes);
    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r += 1) {
        for (let i = 0; i < rowBytes; i += 1) {
            const raw = data[r * rowBytes + i]!;
            const left = i >= bpp ? out[r * rowBytes + i - bpp]! : 0;
            out[r * rowBytes + i] = (raw + left) & 0xff;
        }
    }
    return out;
}

function componentsOf(img: RawImageXObject): number {
    return COMPONENTS_BY_COLORSPACE[img.colorspace] ?? img.decodeParms?.colors ?? 3;
}

/** Fixed-intent CMYK→RGB (naive complement). No ICC, ever (§6.1). */
function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
    const r = Math.round(((255 - c) * (255 - k)) / 255);
    const g = Math.round(((255 - m) * (255 - k)) / 255);
    const b = Math.round(((255 - y) * (255 - k)) / 255);
    return [r, g, b];
}

function encodeRasterToPng(
    samples: Uint8Array,
    width: number,
    height: number,
    components: number,
): Uint8Array {
    const png = new PNG({ width, height, colorType: 6, inputColorType: 6, bitDepth: 8 });
    const rgba = png.data;
    const pixels = width * height;
    for (let p = 0; p < pixels; p += 1) {
        const si = p * components;
        let r: number;
        let g: number;
        let b: number;
        if (components === 1) {
            r = g = b = samples[si] ?? 0;
        } else if (components === 4) {
            [r, g, b] = cmykToRgb(
                samples[si] ?? 0,
                samples[si + 1] ?? 0,
                samples[si + 2] ?? 0,
                samples[si + 3] ?? 0,
            );
        } else {
            r = samples[si] ?? 0;
            g = samples[si + 1] ?? 0;
            b = samples[si + 2] ?? 0;
        }
        const di = p * 4;
        rgba[di] = r;
        rgba[di + 1] = g;
        rgba[di + 2] = b;
        rgba[di + 3] = 255;
    }
    return new Uint8Array(PNG.sync.write(png, PNG_ENCODE_OPTIONS));
}

function recoverImage(img: RawImageXObject, log: Logger): RasterResult | null {
    if (img.filter === "DCTDecode") {
        return { ext: "jpg", bytes: img.bytes, width: img.width, height: img.height };
    }
    if (img.filter === "JPXDecode") {
        return { ext: "jpx", bytes: img.bytes, width: img.width, height: img.height };
    }
    if (img.filter !== "FlateDecode" && img.filter !== "") {
        log.warn(`image ${img.objectId}: unsupported filter ${JSON.stringify(img.filter)}; skipped`);
        return null;
    }
    if (img.bpc !== 8) {
        log.warn(`image ${img.objectId}: unsupported bit depth ${img.bpc}; skipped`);
        return null;
    }
    const components = componentsOf(img);
    if (![1, 3, 4].includes(components)) {
        log.warn(`image ${img.objectId}: unsupported component count ${components}; skipped`);
        return null;
    }

    let decoded: Uint8Array;
    try {
        decoded = img.filter === "FlateDecode" ? new Uint8Array(inflateSync(img.bytes)) : img.bytes;
    } catch (err) {
        log.warn(
            `image ${img.objectId}: inflate failed (${err instanceof Error ? err.message : "error"}); skipped`,
        );
        return null;
    }

    const predictor = img.decodeParms?.predictor ?? 1;
    const columns = img.decodeParms?.columns ?? img.width;
    const rowBytes = columns * components;
    const bpp = components;
    let samples = decoded;
    if (predictor >= 10) {
        samples = unfilterPng(decoded, rowBytes, bpp);
    } else if (predictor === 2) {
        samples = unfilterTiff(decoded, rowBytes, bpp);
    } else if (predictor !== 1) {
        log.warn(`image ${img.objectId}: unsupported predictor ${predictor}; skipped`);
        return null;
    }

    if (samples.length < img.width * img.height * components) {
        log.warn(`image ${img.objectId}: decoded sample buffer too small; skipped`);
        return null;
    }
    return {
        ext: "png",
        bytes: encodeRasterToPng(samples, img.width, img.height, components),
        width: img.width,
        height: img.height,
    };
}

export function recoverImages(raw: RawDoc, log: Logger): ImageAssets {
    const byAssetId = new Map<string, ImageAsset>();
    const objectToAsset = new Map<string, string>();

    for (const img of raw.images) {
        const recovered = recoverImage(img, log);
        if (recovered === null) {
            continue;
        }
        const assetId = id16(recovered.bytes);
        objectToAsset.set(img.objectId, assetId);
        const existing = byAssetId.get(assetId);
        if (existing) {
            existing.sourceObjectIds.push(img.objectId);
            existing.sourceObjectIds.sort(byteCompare);
        } else {
            byAssetId.set(assetId, {
                assetId,
                ext: recovered.ext,
                tier: "A",
                bytes: recovered.bytes,
                width: recovered.width,
                height: recovered.height,
                placement: null,
                sourceObjectIds: [img.objectId],
            });
        }
    }

    const placements = raw.placements
        .map((p) => {
            const assetId = objectToAsset.get(p.objectId);
            return assetId === undefined ? null : { assetId, pageIndex: p.pageIndex, bbox: p.bbox };
        })
        .filter(
            (
                p,
            ): p is { assetId: string; pageIndex: number; bbox: readonly [number, number, number, number] } =>
                p !== null,
        )
        .sort((a, b) => {
            if (a.pageIndex !== b.pageIndex) {
                return numAsc(a.pageIndex, b.pageIndex);
            }
            if (a.bbox[0] !== b.bbox[0]) {
                return numAsc(a.bbox[0], b.bbox[0]);
            }
            return byteCompare(a.assetId, b.assetId);
        });

    const assets = [...byAssetId.values()].sort((a, b) => byteCompare(a.assetId, b.assetId));
    return { assets, placements };
}
