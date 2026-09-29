// SPDX-License-Identifier: AGPL-3.0-or-later
import { zlibSync } from "fflate";

/**
 * Deterministic PNG encoder for 8-bit RGBA rasters. Byte output depends only on
 * the pixels: every row uses filter 0 (None), the image data is compressed with
 * the pinned `fflate` zlib at a fixed level, and only IHDR / IDAT / IEND are
 * written — no timestamps, gamma, text or physical-size chunks. The same pixels
 * therefore encode to the same bytes in Node and in the browser.
 */

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const BIT_DEPTH = 8;
const COLOR_TYPE_RGBA = 6;
const BYTES_PER_PIXEL = 4;
const FILTER_NONE = 0;
const DEFLATE_LEVEL = 9;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) {
        // The index is masked to 0–255, always inside the 256-entry table.
        c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) {
        out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/** Encode `rgba` (width × height × 4 bytes, row-major) as a PNG file. */
export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (rgba.length !== width * height * BYTES_PER_PIXEL) {
        throw new Error(
            `encodePngRgba: expected ${width * height * BYTES_PER_PIXEL} bytes, got ${rgba.length}`,
        );
    }
    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    header[8] = BIT_DEPTH;
    header[9] = COLOR_TYPE_RGBA;
    // compression 0, filter method 0, interlace 0 are already zero.

    const stride = width * BYTES_PER_PIXEL;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = FILTER_NONE;
        raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const parts = [
        SIGNATURE,
        chunk("IHDR", header),
        chunk("IDAT", zlibSync(raw, { level: DEFLATE_LEVEL })),
        chunk("IEND", new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
