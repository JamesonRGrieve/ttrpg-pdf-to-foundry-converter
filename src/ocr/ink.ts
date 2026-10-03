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
    return strokeOf(image, box, (v) => v <= threshold);
}

/** Share of a box's pixels at each end of its gray range taken as its extremes (specks aside). */
const EXTREME_SHARE = 0.02;
/** Least gray difference between a box's ground and its print for it to hold print at all. */
const MIN_PRINT_CONTRAST = 32;

/** How a box's print is told from its ground. */
export interface PrintTest {
    /** Light print on a dark ground (a header bar, a banner), else dark on light. */
    light: boolean;
    /** Whether a gray level is print. Never true when the box holds no print. */
    ink: (value: number) => boolean;
}

/**
 * The print in a box, against its ground: the ground is the box's median
 * gray (it covers most of a word's box), the print lies toward whichever end
 * of its gray range is farther from the ground, and a pixel is print when it
 * lies past halfway from the ground to that end. Unlike one threshold between
 * a box's two largest gray populations, this keeps a tinted row's ground (and
 * the paper showing between rows) out of the print.
 */
export function printTest(image: GrayImage, box: PixelBox): PrintTest {
    const b = clip(box, image);
    const hist = new Array<number>(LEVELS).fill(0);
    let total = 0;
    for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
            const v = pixelAt(image, x, y);
            hist[v] = (hist[v] ?? 0) + 1;
            total += 1;
        }
    }
    const levelAt = (share: number): number => {
        let seen = 0;
        for (let level = 0; level < LEVELS; level++) {
            seen += hist[level] ?? 0;
            if (seen > share * total) {
                return level;
            }
        }
        return PAPER;
    };
    const ground = levelAt(0.5);
    const darkest = levelAt(EXTREME_SHARE);
    const lightest = levelAt(1 - EXTREME_SHARE);
    const light = lightest - ground > ground - darkest;
    const contrast = light ? lightest - ground : ground - darkest;
    if (total === 0 || contrast < MIN_PRINT_CONTRAST) {
        return { light, ink: () => false };
    }
    const threshold = light ? (ground + lightest) / 2 : (ground + darkest) / 2;
    return { light, ink: light ? (v) => v > threshold : (v) => v < threshold };
}

/**
 * Stroke width of a word's print whichever its polarity (see `printTest`):
 * dark print on a light ground, or light print on a dark one.
 */
export function printStrokeWidth(image: GrayImage, box: PixelBox): number {
    return strokeOf(image, box, printTest(image, box).ink);
}

/** Whether a word's print is dark on a light ground or light on a dark one (see `printTest`). */
export function printPolarity(image: GrayImage, box: PixelBox): "dark" | "light" {
    return printTest(image, box).light ? "light" : "dark";
}

/** A printed line's measured lines, in pixel rows. */
export interface CoreBand {
    /** Top of the capitals and ascenders. */
    capTop: number;
    /** Top of the lower-case body, where the ink thickens; null when the line shows none (capitals, digits). */
    xTop: number | null;
    /** Row just below the print's body: the baseline. */
    baseline: number;
}

/** The value at quantile `q` (0–1) of `values`. */
function quantileOf(values: number[], q: number): number {
    const sorted = values.sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** Quantile of the inked columns' top rows taken as the cap line (above it, accents and specks). */
export const CAP_QUANTILE = 0.1;
/** Rows over which the ink density's rise is taken. */
const RISE_ROWS = 2;
/** The x-height lies at least this share of the cap height below the cap line… */
const X_FROM_CAP = 0.2;
/** …and at least this share above the baseline. */
const X_FROM_BASELINE = 0.3;
/** A row holding at most this share of the densest row's ink is blank (specks aside). */
const BLANK_ROW_SHARE = 0.02;
/** A rise in ink density this share of the densest row's marks the lower-case body's top. */
const MIN_RISE_SHARE = 0.25;

/**
 * The lines of the print in a line box, measured within the line's own
 * band of print (around its densest row, up to a blank row). The baseline is
 * the median of the inked columns' lowest rows (descenders are few), the cap
 * line a low quantile (`capQuantile`) of their highest. Lower-case text thickens sharply where its body
 * begins — every bowl and stem starts at the x-height, while only the thin
 * ascenders rise above it — so the x-height is the row between the two where
 * the ink density rises most, when it rises enough. Null when the box holds
 * no print.
 */
export function coreBand(image: GrayImage, box: PixelBox, capQuantile = CAP_QUANTILE): CoreBand | null {
    const b = clip(box, image);
    const test = printTest(image, box);
    const rows = new Array<number>(Math.max(0, b.y1 - b.y0)).fill(0);
    for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
            if (test.ink(pixelAt(image, x, y))) {
                rows[y - b.y0] = (rows[y - b.y0] ?? 0) + 1;
            }
        }
    }
    const densest = Math.max(0, ...rows);
    if (densest === 0) {
        return null;
    }
    // The line's own print: the rows around its densest one, up to a blank
    // row. A detected line box is padded, and print beyond a blank row is a
    // neighbouring line's (the descenders of the line above).
    const blank = (i: number): boolean => (rows[i] ?? 0) <= BLANK_ROW_SHARE * densest;
    let first = rows.indexOf(densest);
    let last = first;
    while (first > 0 && !blank(first - 1)) {
        first--;
    }
    while (last < rows.length - 1 && !blank(last + 1)) {
        last++;
    }
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (let x = b.x0; x < b.x1; x++) {
        let top = -1;
        let bottom = -1;
        for (let y = b.y0 + first; y <= b.y0 + last; y++) {
            if (test.ink(pixelAt(image, x, y))) {
                top = top < 0 ? y : top;
                bottom = y;
            }
        }
        if (top >= 0) {
            tops.push(top);
            bottoms.push(bottom);
        }
    }
    const capTop = quantileOf(tops, capQuantile);
    const baseline = quantileOf(bottoms, 0.5) + 1;
    const height = baseline - capTop;
    let xTop: number | null = null;
    let bestRise = MIN_RISE_SHARE * densest;
    for (let y = Math.ceil(capTop + X_FROM_CAP * height); y <= baseline - X_FROM_BASELINE * height; y++) {
        const rise = (rows[y - b.y0] ?? 0) - (rows[y - b.y0 - RISE_ROWS] ?? 0);
        if (rise > bestRise) {
            bestRise = rise;
            xTop = y;
        }
    }
    return { capTop, xTop, baseline };
}

/**
 * A box narrowed to the columns that hold print, with the print's polarity
 * taken from `context` (the whole line). A word's box is bounded in blank
 * space (a detected line is padded beyond its print; a word between its
 * neighbours' midpoints), so print at its very edge is a neighbour's glyph
 * running over: it is skipped to the first blank column. Unchanged when the
 * box holds no print of its own.
 */
export function trimToInk(image: GrayImage, box: PixelBox, context: PixelBox): PixelBox {
    const test = printTest(image, context);
    const b = clip(box, image);
    const inked = (x: number): boolean => {
        for (let y = b.y0; y < b.y1; y++) {
            if (test.ink(pixelAt(image, x, y))) {
                return true;
            }
        }
        return false;
    };
    let x0 = b.x0;
    while (x0 < b.x1 && inked(x0)) {
        x0++;
    }
    while (x0 < b.x1 && !inked(x0)) {
        x0++;
    }
    let x1 = b.x1;
    while (x1 > x0 && inked(x1 - 1)) {
        x1--;
    }
    while (x1 > x0 && !inked(x1 - 1)) {
        x1--;
    }
    return x0 < x1 ? { ...box, x0, x1 } : box;
}

function strokeOf(image: GrayImage, box: PixelBox, isInk: (value: number) => boolean): number {
    const b = clip(box, image);
    const ink = (x: number, y: number): boolean =>
        x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && isInk(pixelAt(image, x, y));
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

/** The pixels of `box` (clipped to the image) as an image of their own. */
export function cropGray(image: GrayImage, box: PixelBox): GrayImage {
    const { x0, y0, x1, y1 } = clip(box, image);
    const width = Math.max(0, x1 - x0);
    const height = Math.max(0, y1 - y0);
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            pixels[y * width + x] = pixelAt(image, x0 + x, y0 + y);
        }
    }
    return { pixels, width, height, stride: width };
}

/** Side (pixels) of the square window each pixel's local threshold is taken over. */
export const SAUVOLA_WINDOW = 31;
/** How far below the local mean, in proportion to the local contrast, ink must sit. */
export const SAUVOLA_K = 0.2;
/** The gray range the local contrast is measured against (half the 8-bit span). */
const SAUVOLA_RANGE = 128;

/**
 * Sauvola's local binarization: each pixel is ink when darker than
 * `mean × (1 + k × (sd / R − 1))` over the window around it. Unlike one
 * global threshold, it keeps dark print on a mottled, tinted or patterned
 * ground (a scanned page's parchment texture, a statblock's boxed cells)
 * while dropping the ground. Sums are taken over integral images, so the
 * cost does not grow with the window; the arithmetic is IEEE double, exact
 * in every runtime.
 */
export function sauvola(image: GrayImage): GrayImage {
    const { width, height } = image;
    const w1 = width + 1;
    const sum = new Float64Array(w1 * (height + 1));
    const squares = new Float64Array(w1 * (height + 1));
    for (let y = 0; y < height; y++) {
        let row = 0;
        let rowSquares = 0;
        for (let x = 0; x < width; x++) {
            const v = pixelAt(image, x, y);
            row += v;
            rowSquares += v * v;
            const i = (y + 1) * w1 + (x + 1);
            sum[i] = (sum[i - w1] ?? 0) + row;
            squares[i] = (squares[i - w1] ?? 0) + rowSquares;
        }
    }
    const half = Math.floor(SAUVOLA_WINDOW / 2);
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - half);
        const y1 = Math.min(height, y + half + 1);
        for (let x = 0; x < width; x++) {
            const x0 = Math.max(0, x - half);
            const x1 = Math.min(width, x + half + 1);
            const n = (x1 - x0) * (y1 - y0);
            const area = (a: Float64Array): number =>
                (a[y1 * w1 + x1] ?? 0) -
                (a[y0 * w1 + x1] ?? 0) -
                (a[y1 * w1 + x0] ?? 0) +
                (a[y0 * w1 + x0] ?? 0);
            const mean = area(sum) / n;
            const sd = Math.sqrt(Math.max(0, area(squares) / n - mean * mean));
            const threshold = mean * (1 + SAUVOLA_K * (sd / SAUVOLA_RANGE - 1));
            pixels[y * width + x] = pixelAt(image, x, y) > threshold ? PAPER : 0;
        }
    }
    return { pixels, width, height, stride: width };
}
