// SPDX-License-Identifier: AGPL-3.0-or-later
import * as mupdf from "mupdf";
import { PINS } from "../pins.ts";
import type { PdfBox, RenderedPage } from "./types.ts";

/**
 * Deterministic page rasterizer. The renderer (pinned `mupdf`), the DPI and the
 * colour space are fixed so the same PDF always yields the same pixels, which
 * keeps OCR output — and therefore everything downstream — reproducible.
 */

export const RENDER_DPI = 300;
const POINTS_PER_INCH = 72;
export const RENDERER_ID = `mupdf@${PINS.mupdf}/${RENDER_DPI}dpi/gray`;

export class PageRenderer {
    readonly #doc: mupdf.Document;

    constructor(pdfBytes: Uint8Array) {
        this.#doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    }

    get pageCount(): number {
        return this.#doc.countPages();
    }

    render(pageIndex: number, viewBox: PdfBox): RenderedPage {
        const scale = RENDER_DPI / POINTS_PER_INCH;
        const page = this.#doc.loadPage(pageIndex);
        try {
            const pixmap = page.toPixmap(
                mupdf.Matrix.scale(scale, scale),
                mupdf.ColorSpace.DeviceGray,
                false,
                true,
            );
            try {
                return {
                    pageIndex,
                    png: pixmap.asPNG(),
                    widthPx: pixmap.getWidth(),
                    heightPx: pixmap.getHeight(),
                    scale,
                    viewBox,
                };
            } finally {
                pixmap.destroy();
            }
        } finally {
            page.destroy();
        }
    }

    close(): void {
        this.#doc.destroy();
    }
}

/** Map an image-pixel box (origin top-left) back into PDF user space. */
export function pixelBoxToPdf(
    page: Pick<RenderedPage, "scale" | "viewBox">,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
): PdfBox {
    const [vx0, , , vy1] = page.viewBox;
    return [vx0 + x0 / page.scale, vy1 - y1 / page.scale, vx0 + x1 / page.scale, vy1 - y0 / page.scale];
}
