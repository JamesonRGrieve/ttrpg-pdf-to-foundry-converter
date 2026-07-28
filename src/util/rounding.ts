// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic numeric quantization (spec §5.3). IEEE-754 `+ - * /` and
 * `Math.floor` are bit-reproducible across conforming platforms, so a
 * quantizer built only from them yields identical output everywhere. We never
 * compare raw floats — sizes/coordinates are snapped to a grid first, and
 * equality goes through an explicit epsilon.
 */

/** Quantization grid steps, in PDF points. */
export const COORD_STEP = 0.1;
export const SIZE_STEP = 0.25;
export const WIDTH_STEP = 0.1;

/** Epsilon for font-size comparison. Never use `===` on sizes (§5.3). */
export const SIZE_EPSILON = 0.05;

/** Line-banding height used by the normalization sort (§5.1). */
export const BAND_HEIGHT = 2.0;

/** Round half to even ("banker's rounding") to the nearest integer. */
export function roundHalfEven(x: number): number {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff < 0.5) {
        return floor;
    }
    if (diff > 0.5) {
        return floor + 1;
    }
    // Exact tie → round toward the even neighbour.
    return floor % 2 === 0 ? floor : floor + 1;
}

/** Decimal places implied by a power-of-ten-ish step, for stable formatting. */
function decimalsForStep(step: number): number {
    const s = step.toString();
    const dot = s.indexOf(".");
    return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Snap `value` to the nearest multiple of `step` using banker's rounding.
 * The result is re-parsed through a fixed decimal count so no representation
 * noise (e.g. `0.30000000000000004`) survives into the IR.
 */
export function quantize(value: number, step: number): number {
    const k = roundHalfEven(value / step);
    const product = k * step;
    return Number(product.toFixed(decimalsForStep(step) + 2));
}

export function quantizeCoord(value: number): number {
    return quantize(value, COORD_STEP);
}

export function quantizeSize(value: number): number {
    return quantize(value, SIZE_STEP);
}

export function quantizeWidth(value: number): number {
    return quantize(value, WIDTH_STEP);
}

/** Epsilon-based size equality (§5.3): true when within `SIZE_EPSILON` points. */
export function sizeEquals(a: number, b: number, epsilon: number = SIZE_EPSILON): boolean {
    return Math.abs(a - b) < epsilon;
}
