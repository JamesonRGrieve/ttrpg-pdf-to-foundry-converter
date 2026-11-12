// SPDX-License-Identifier: AGPL-3.0-or-later
import { unzlibSync } from "fflate";
import type { Logger } from "../logger.ts";
import type { ImageAsset, ImageAssets, RawDoc, RawImageXObject } from "../types/ir.ts";
import { id16 } from "../util/hash.ts";
import { byteCompare, numAsc } from "../util/ordered.ts";
import { encodePngRgba } from "../util/png.ts";
import type { ImageDecoder } from "./image-fallback.ts";

/**
 * Stage 3 — Image recovery, Tier A (spec §6.1). Two rules govern byte-stability:
 *  1. Prefer lossless passthrough. DCTDecode → write JPEG bytes directly;
 *     JPXDecode → write directly. No decode/re-encode round-trip (encoders are
 *     the largest source of cross-platform byte drift).
 *  2. Flate-decoded rasters are re-encoded to PNG with the in-house encoder
 *     (`util/png.ts`): pinned zlib, fixed level, filter 0, and only
 *     IHDR/IDAT/IEND — no tIME/pHYs/gAMA/tEXt.
 *
 * Colorspace conversion is a fixed in-house transform at a stated intent — never
 * a system ICC profile (§6.1). Assets are content-addressed (§6.1): identical
 * bytes dedup to one file, and two users produce the same asset tree.
 *
 * Palette (`/Indexed`) images are expanded through their lookup table, and an
 * ICC-based image takes its component count from the profile's `/N`; gray and
 * palette samples may be 1, 2, 4 or 8 bits, any sample 16 (its high byte kept).
 * Unsupported inputs (LZW/CCITT, separation and Lab colour spaces, Flate with
 * an unknown predictor) are refused with a warning naming why, rather than
 * guessed (§6.3 / §8.6). Tier B raster fallback is a separate, opt-in path.
 */

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

/** A byte of `bytes`, 0 outside it (the predictors' "no neighbour" value). */
function byteAt(bytes: Uint8Array | null, i: number): number {
    return bytes?.[i] ?? 0;
}

/** Reverse PNG per-row predictors (predictor >= 10). Modifies rows in place. */
function unfilterPng(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    let prevRow: Uint8Array | null = null;
    for (let r = 0; r < rows; r += 1) {
        const filterType = byteAt(data, r * (rowBytes + 1));
        const rowStart = r * (rowBytes + 1) + 1;
        const cur = new Uint8Array(rowBytes);
        for (let i = 0; i < rowBytes; i += 1) {
            const raw = byteAt(data, rowStart + i);
            const left = i >= bpp ? byteAt(cur, i - bpp) : 0;
            const up = byteAt(prevRow, i);
            const upLeft = i >= bpp ? byteAt(prevRow, i - bpp) : 0;
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
            const raw = byteAt(data, r * rowBytes + i);
            const left = i >= bpp ? byteAt(out, r * rowBytes + i - bpp) : 0;
            out[r * rowBytes + i] = (raw + left) & 0xff;
        }
    }
    return out;
}

/**
 * Components per sample: one for a palette image (each sample an index), else
 * the device family's count, the count the colour space defines (an ICC
 * profile's `/N`), the predictor's `/Colors`, or three.
 */
function componentsOf(img: RawImageXObject): number {
    if ((img.palette ?? null) !== null) {
        return 1;
    }
    return COMPONENTS_BY_COLORSPACE[img.colorspace] ?? img.components ?? img.decodeParms?.colors ?? 3;
}

/** A named colour space the decoder has no conversion for (separations, Lab, patterns). */
function unconvertible(img: RawImageXObject): boolean {
    return (
        img.colorspace !== "" &&
        (img.palette ?? null) === null &&
        COMPONENTS_BY_COLORSPACE[img.colorspace] === undefined &&
        (img.components ?? null) === null
    );
}

/** Bit depths a sample may have; below 8 only for one-component (gray or palette) images. */
const SUB_BYTE_DEPTHS = new Set([1, 2, 4]);

/**
 * Samples at 8 bits each, `components` per pixel, from rows of `bpc`-bit
 * samples (each row padded to a whole byte). A sub-byte sample is scaled to
 * 0–255, unless it is a palette index; a 16-bit sample keeps its high byte.
 */
function toEightBit(
    data: Uint8Array,
    width: number,
    height: number,
    components: number,
    bpc: number,
    index: boolean,
): Uint8Array {
    if (bpc === 8) {
        return data;
    }
    const perRow = width * components;
    const rowBytes = Math.ceil((perRow * bpc) / 8);
    const out = new Uint8Array(perRow * height);
    const max = (1 << bpc) - 1;
    for (let y = 0; y < height; y += 1) {
        for (let i = 0; i < perRow; i += 1) {
            let value: number;
            if (bpc === 16) {
                value = byteAt(data, y * rowBytes + i * 2);
            } else {
                const bit = i * bpc;
                const byte = byteAt(data, y * rowBytes + (bit >> 3));
                const raw = (byte >> (8 - bpc - (bit & 7))) & max;
                value = index ? raw : Math.round((raw * 255) / max);
            }
            out[y * perRow + i] = value;
        }
    }
    return out;
}

/** Palette indices mapped to their entries (an index past the table takes its last entry). */
function expandPalette(indices: Uint8Array, palette: { components: number; lookup: Uint8Array }): Uint8Array {
    const n = palette.components;
    const last = Math.max(0, Math.floor(palette.lookup.length / n) - 1);
    const out = new Uint8Array(indices.length * n);
    indices.forEach((index, p) => {
        const entry = Math.min(index, last) * n;
        for (let c = 0; c < n; c += 1) {
            out[p * n + c] = byteAt(palette.lookup, entry + c);
        }
    });
    return out;
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
    const pixels = width * height;
    const rgba = new Uint8Array(pixels * 4);
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
    return encodePngRgba(rgba, width, height);
}

/**
 * Recover an image: in-house where it can be (byte-stable passthrough or
 * PNG re-encoding), else through `fallback` (the pinned MuPDF) when given.
 * A skipped image logs why.
 */
function recoverImage(img: RawImageXObject, log: Logger, fallback?: ImageDecoder): RasterResult | null {
    const own = decodeInHouse(img);
    if (typeof own !== "string") {
        return own;
    }
    const decoded = fallback?.(img.objectId) ?? null;
    if (decoded !== null) {
        log.debug(`image ${img.objectId}: ${own}; decoded by the fallback decoder`);
        return {
            ext: "png",
            bytes: encodeRasterToPng(decoded.samples, decoded.width, decoded.height, decoded.components),
            width: decoded.width,
            height: decoded.height,
        };
    }
    log.warn(`image ${img.objectId}: ${own}; skipped`);
    return null;
}

/** The image decoded in-house, or why it cannot be. */
function decodeInHouse(img: RawImageXObject): RasterResult | string {
    if (img.filter === "DCTDecode") {
        return { ext: "jpg", bytes: img.bytes, width: img.width, height: img.height };
    }
    if (img.filter === "JPXDecode") {
        return { ext: "jpx", bytes: img.bytes, width: img.width, height: img.height };
    }
    if (img.filter !== "FlateDecode" && img.filter !== "") {
        return `unsupported filter ${JSON.stringify(img.filter)}`;
    }
    if (unconvertible(img)) {
        return `unsupported colour space ${img.colorspace}`;
    }
    const components = componentsOf(img);
    if (!(img.bpc === 8 || img.bpc === 16 || (components === 1 && SUB_BYTE_DEPTHS.has(img.bpc)))) {
        return `unsupported bit depth ${img.bpc}`;
    }
    const outComponents = img.palette?.components ?? components;
    if (![1, 3, 4].includes(outComponents)) {
        return `unsupported component count ${outComponents}`;
    }

    let decoded: Uint8Array;
    try {
        decoded = img.filter === "FlateDecode" ? unzlibSync(img.bytes) : img.bytes;
    } catch (err) {
        return `inflate failed (${err instanceof Error ? err.message : "error"})`;
    }

    const predictor = img.decodeParms?.predictor ?? 1;
    const columns = img.decodeParms?.columns ?? img.width;
    const rowBytes = Math.ceil((columns * components * img.bpc) / 8);
    const bpp = Math.max(1, Math.ceil((components * img.bpc) / 8));
    let samples = decoded;
    if (predictor >= 10) {
        samples = unfilterPng(decoded, rowBytes, bpp);
    } else if (predictor === 2) {
        samples = unfilterTiff(decoded, rowBytes, bpp);
    } else if (predictor !== 1) {
        return `unsupported predictor ${predictor}`;
    }

    if (samples.length < Math.ceil((img.width * components * img.bpc) / 8) * img.height) {
        return "decoded sample buffer too small";
    }
    const palette = img.palette ?? null;
    const eight = toEightBit(samples, img.width, img.height, components, img.bpc, palette !== null);
    const pixels = palette === null ? eight : expandPalette(eight, palette);
    return {
        ext: "png",
        bytes: encodeRasterToPng(pixels, img.width, img.height, outComponents),
        width: img.width,
        height: img.height,
    };
}

/**
 * Every image of the document as an asset. `fallback` decodes the images
 * the in-house decoder refuses (the pinned MuPDF, `image-fallback.ts`).
 */
export function recoverImages(raw: RawDoc, log: Logger, fallback?: ImageDecoder): ImageAssets {
    const byAssetId = new Map<string, ImageAsset>();
    const objectToAsset = new Map<string, string>();

    for (const img of raw.images) {
        const recovered = recoverImage(img, log, fallback);
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
