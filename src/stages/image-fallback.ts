// SPDX-License-Identifier: AGPL-3.0-or-later
import * as mupdf from "mupdf";

/**
 * Decoding the images the in-house decoder refuses (CCITT fax, JBIG2, LZW,
 * run-length, filter chains, separation colour spaces…) through the pinned
 * MuPDF the page renderer already uses. The pixels come back as 8-bit gray
 * or RGB samples; the caller encodes them with its own byte-stable PNG
 * encoder, so the output depends only on the pinned MuPDF build.
 */

/** Decoded image pixels: `components` 8-bit samples per pixel, rows packed. */
export interface DecodedPixels {
    width: number;
    height: number;
    components: 1 | 3;
    samples: Uint8Array;
}

/** Decodes an image XObject by its object id (`"<num> <gen> R"`), or null when it cannot. */
export type ImageDecoder = (objectId: string) => DecodedPixels | null;

/** An image decoder over one PDF; `close` releases the document. */
export interface ImageFallback {
    decode: ImageDecoder;
    close(): void;
}

/** Open `pdfBytes` in MuPDF for decoding its images. */
export function openImageFallback(pdfBytes: Uint8Array): ImageFallback {
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    const pdf = doc.asPDF();
    const decode: ImageDecoder = (objectId) => {
        const num = Number(/^(\d+)\s/u.exec(objectId)?.[1]);
        if (pdf === null || !Number.isInteger(num) || num <= 0) {
            return null;
        }
        let image: mupdf.Image | null = null;
        let pixmap: mupdf.Pixmap | null = null;
        let converted: mupdf.Pixmap | null = null;
        try {
            image = pdf.loadImage(pdf.newIndirect(num));
            pixmap = image.toPixmap();
            const space = pixmap.getColorSpace();
            const gray = space?.isGray() === true;
            const rgb = space?.isRGB() === true;
            // Anything else (CMYK, a separation, an indexed space MuPDF did not expand) becomes RGB.
            converted = gray || rgb ? null : pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
            const source = converted ?? pixmap;
            const components: 1 | 3 = gray && converted === null ? 1 : 3;
            const width = source.getWidth();
            const height = source.getHeight();
            const stride = source.getStride();
            // A pixel's bytes, alpha included; only its colour samples are kept.
            const perPixel = width > 0 ? Math.floor(stride / width) : 0;
            if (perPixel < components) {
                return null;
            }
            // Copied out first: the view is into WASM memory, which later calls may grow and move.
            const pixels = new Uint8Array(source.getPixels());
            const samples = new Uint8Array(width * height * components);
            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    for (let c = 0; c < components; c += 1) {
                        samples[(y * width + x) * components + c] =
                            pixels[y * stride + x * perPixel + c] ?? 0;
                    }
                }
            }
            return { width, height, components, samples };
        } catch {
            return null;
        } finally {
            converted?.destroy();
            pixmap?.destroy();
            image?.destroy();
        }
    };
    return { decode, close: () => doc.destroy() };
}
