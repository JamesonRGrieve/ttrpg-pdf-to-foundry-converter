// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate an image-only ("scanned") PDF fixture: every page of the field
// manual rendered to a grayscale image and placed alone on a page of the same
// size — no text layer at all, as a scanned book arrives. The engine must
// read it from OCR alone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";

const rendered = resolve(dirname(fileURLToPath(import.meta.url)), "..", "rendered");
/** The scan's resolution: a common flatbed setting, coarser than the engine's own render. */
const SCAN_DPI = 200;
const POINTS_PER_INCH = 72;

const manual = readFileSync(resolve(rendered, "field-manual.pdf"));
const source = mupdf.Document.openDocument(manual, "application/pdf");
const scan = new mupdf.PDFDocument();
const scale = SCAN_DPI / POINTS_PER_INCH;
for (let i = 0; i < source.countPages(); i++) {
    const page = source.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const width = x1 - x0;
    const height = y1 - y0;
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
    const image = scan.addImage(new mupdf.Image(pixmap));
    const resources = scan.addObject({ XObject: { I0: image } });
    const contents = `q ${width} 0 0 ${height} 0 0 cm /I0 Do Q`;
    scan.insertPage(-1, scan.addPage([0, 0, width, height], 0, resources, contents));
    pixmap.destroy();
    page.destroy();
}
const out = resolve(rendered, "scanned.pdf");
const bytes = scan.saveToBuffer("compress").asUint8Array();
writeFileSync(out, bytes);
process.stdout.write(`wrote ${out} (${bytes.length} bytes)\n`);
