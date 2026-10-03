// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GrayImage, PixelBox } from "../ink.ts";

/**
 * Text-line detection for the PP-OCR reader (a DB — differentiable
 * binarization — network). The network maps a page to a per-pixel text
 * probability; the line boxes are the connected regions of probable text,
 * grown back to the text's full extent (the network is trained on regions
 * shrunk from the true outline). This file holds the pre- and post-processing,
 * so it is plain arithmetic, identical in every runtime; the network itself
 * runs in the injected session.
 */

/** The detector reads the page at this fraction of the rendered resolution (300 → 150 dpi). */
export const DETECT_SCALE = 2;
/** The network's input sides must be multiples of this. */
const STRIDE = 32;
/** Per-channel normalization the detector was trained with (ImageNet mean and deviation). */
const MEAN = [0.485, 0.456, 0.406] as const;
const DEVIATION = [0.229, 0.224, 0.225] as const;
const CHANNELS = 3;
const PAPER = 255;
/** A pixel is text when its probability exceeds this. */
const PIXEL_THRESHOLD = 0.3;
/** A region is a line when its mean probability reaches this. */
const REGION_THRESHOLD = 0.6;
/** Regions are grown by their area × this ratio over their perimeter (the training shrink, undone). */
const UNCLIP_RATIO = 1.5;
/** Regions thinner than this (detector pixels) are specks. */
const MIN_SIDE = 3;

export interface DetectionInput {
    /** Planar RGB, normalized, `[1, 3, height, width]`. */
    data: Float32Array;
    width: number;
    height: number;
}

/**
 * The detector's input: the page reduced by `DETECT_SCALE` (each output pixel
 * the mean of its block), padded with paper to multiples of the network's
 * stride, normalized per channel.
 */
export function detectionInput(image: GrayImage): DetectionInput {
    const w = Math.floor(image.width / DETECT_SCALE);
    const h = Math.floor(image.height / DETECT_SCALE);
    const width = Math.ceil(w / STRIDE) * STRIDE;
    const height = Math.ceil(h / STRIDE) * STRIDE;
    const plane = width * height;
    const data = new Float32Array(CHANNELS * plane);
    const block = DETECT_SCALE * DETECT_SCALE;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let v = PAPER;
            if (x < w && y < h) {
                let sum = 0;
                for (let dy = 0; dy < DETECT_SCALE; dy++) {
                    for (let dx = 0; dx < DETECT_SCALE; dx++) {
                        const sy = y * DETECT_SCALE + dy;
                        const sx = x * DETECT_SCALE + dx;
                        sum += image.pixels[sy * image.stride + sx] ?? PAPER;
                    }
                }
                v = sum / block;
            }
            for (let c = 0; c < CHANNELS; c++) {
                data[c * plane + y * width + x] = (v / PAPER - (MEAN[c] ?? 0)) / (DEVIATION[c] ?? 1);
            }
        }
    }
    return { data, width, height };
}

/**
 * The text lines in a detector output (`probability`, `width` × `height`), as
 * boxes in the rendered page's pixels, top to bottom then left to right.
 * Each 4-connected region of text pixels whose mean probability is high
 * enough becomes its bounding box, grown by area × ratio / perimeter on every
 * side and scaled back up to the page.
 */
export function textBoxes(
    probability: Float32Array,
    width: number,
    height: number,
    page: { width: number; height: number },
): PixelBox[] {
    const label = new Int32Array(width * height).fill(-1);
    const boxes: PixelBox[] = [];
    const stack: number[] = [];
    let regions = 0;
    for (let start = 0; start < width * height; start++) {
        if (label[start] !== -1 || (probability[start] ?? 0) <= PIXEL_THRESHOLD) {
            continue;
        }
        regions += 1;
        const region = regions;
        label[start] = region;
        stack.push(start);
        let x0 = width;
        let y0 = height;
        let x1 = -1;
        let y1 = -1;
        let sum = 0;
        let count = 0;
        while (stack.length > 0) {
            const i = stack.pop() ?? 0;
            const x = i % width;
            const y = (i - x) / width;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
            sum += probability[i] ?? 0;
            count += 1;
            const neighbours = [
                x > 0 ? i - 1 : -1,
                x < width - 1 ? i + 1 : -1,
                y > 0 ? i - width : -1,
                y < height - 1 ? i + width : -1,
            ];
            for (const n of neighbours) {
                if (n >= 0 && label[n] === -1 && (probability[n] ?? 0) > PIXEL_THRESHOLD) {
                    label[n] = region;
                    stack.push(n);
                }
            }
        }
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        if (Math.min(w, h) < MIN_SIDE || sum / count < REGION_THRESHOLD) {
            continue;
        }
        const grow = (w * h * UNCLIP_RATIO) / (2 * (w + h));
        boxes.push({
            x0: Math.max(0, Math.floor((x0 - grow) * DETECT_SCALE)),
            y0: Math.max(0, Math.floor((y0 - grow) * DETECT_SCALE)),
            x1: Math.min(page.width, Math.ceil((x1 + 1 + grow) * DETECT_SCALE)),
            y1: Math.min(page.height, Math.ceil((y1 + 1 + grow) * DETECT_SCALE)),
        });
    }
    return boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}
