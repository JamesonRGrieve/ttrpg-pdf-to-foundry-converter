// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ink measurements on a rendered page, for pages whose only text is what OCR
 * reads off the image. A text layer names each run's weight; a scanned page does
 * not, so weight is measured from the printed strokes instead. Both functions
 * are integer pixel arithmetic over 8-bit grayscale, so they are exact and
 * identical in every runtime.
 */

/** A pixel rectangle, origin top-left, `x1`/`y1` exclusive. */
export interface PixelBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Grayscale pixels, one byte per pixel, `stride` bytes per row. */
export interface GrayImage {
    pixels: Uint8Array;
    width: number;
    height: number;
    stride: number;
}

const LEVELS = 256;
const PAPER = 255;

function clip(box: PixelBox, image: GrayImage): PixelBox {
    return {
        x0: Math.max(0, Math.floor(box.x0)),
        y0: Math.max(0, Math.floor(box.y0)),
        x1: Math.min(image.width, Math.ceil(box.x1)),
        y1: Math.min(image.height, Math.ceil(box.y1)),
    };
}

function pixelAt(image: GrayImage, x: number, y: number): number {
    return image.pixels[y * image.stride + x] ?? PAPER;
}

/**
 * Otsu's threshold over a box: the gray level that best separates ink from
 * paper there. Pixels at or below it are ink. Local rather than global, so a
 * tinted or unevenly exposed page still separates cleanly.
 */
export function otsuThreshold(image: GrayImage, box: PixelBox): number {
    const b = clip(box, image);
    const hist = new Array<number>(LEVELS).fill(0);
    let total = 0;
    let sum = 0;
    for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
            const v = pixelAt(image, x, y);
            hist[v] = (hist[v] ?? 0) + 1;
            total += 1;
            sum += v;
        }
    }
    let best = -1;
    let threshold = LEVELS / 2;
    let below = 0;
    let belowSum = 0;
    for (let level = 0; level < LEVELS; level++) {
        const count = hist[level] ?? 0;
        below += count;
        belowSum += level * count;
        const above = total - below;
        if (below === 0 || above === 0) {
            continue;
        }
        const spread = below * above * (belowSum / below - (sum - belowSum) / above) ** 2;
        if (spread > best) {
            best = spread;
            threshold = level;
        }
    }
    return threshold;
}

/**
 * Mean stroke width of the ink in a box, in pixels: twice the ink area over
 * its boundary length. A stroke of width w and length L has area wL and
 * boundary ≈ 2L, so the ratio recovers w whatever the letters are — the
 * measure that tells a bold word from a regular one of the same size.
 * 0 when the box holds no ink.
 */
export function strokeWidth(image: GrayImage, box: PixelBox, threshold: number): number {
    const b = clip(box, image);
    const ink = (x: number, y: number): boolean =>
        x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && pixelAt(image, x, y) <= threshold;
    let area = 0;
    let boundary = 0;
    for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
            if (!ink(x, y)) {
                continue;
            }
            area += 1;
            if (!ink(x - 1, y) || !ink(x + 1, y) || !ink(x, y - 1) || !ink(x, y + 1)) {
                boundary += 1;
            }
        }
    }
    return boundary === 0 ? 0 : (2 * area) / boundary;
}
