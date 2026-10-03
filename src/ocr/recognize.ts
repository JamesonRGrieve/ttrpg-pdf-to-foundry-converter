// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from "../logger.ts";
import type { RawPage } from "../types/ir.ts";
import { sha256Hex } from "../util/hash.ts";
import { encodePngRgba } from "../util/png.ts";
import { type GridCellToRead, gridCellsToRead } from "./grid-cells.ts";
import { cropGray, type GrayImage, SAUVOLA_K, SAUVOLA_WINDOW, sauvola } from "./ink.ts";
import type { PageReader } from "./ppocr/reader.ts";
import { PageRenderer, RENDERER_ID } from "./render.ts";
import { confidentWord } from "./scan-lines.ts";
import type { OcrEngine, OcrPage, OcrWord, PdfBox, RenderedPage } from "./types.ts";

/**
 * Render every page and recognize it with `engine`. Finished pages go to an
 * injected store (a directory on disk for the CLI, memory in the browser), so a
 * long book survives interruption and re-runs skip finished pages. Rendering
 * runs on the calling thread; recognition runs on the engine's workers, with at
 * most `maxInFlight` rendered pages held at once.
 *
 * Store keys combine the PDF content hash with the renderer and engine ids, so
 * a pin change can never serve stale OCR. The hash never leaves the store.
 */

export interface OcrPageStore {
    read(key: string, pageIndex: number): Promise<OcrWord[] | null>;
    write(key: string, pageIndex: number, words: OcrWord[]): Promise<void>;
}

/** A store that lives only as long as the run (the browser's default). */
export class MemoryOcrPageStore implements OcrPageStore {
    readonly #pages = new Map<string, OcrWord[]>();

    async read(key: string, pageIndex: number): Promise<OcrWord[] | null> {
        return this.#pages.get(`${key}/${pageIndex}`) ?? null;
    }

    async write(key: string, pageIndex: number, words: OcrWord[]): Promise<void> {
        this.#pages.set(`${key}/${pageIndex}`, words);
    }
}

export interface RecognizeOptions {
    store: OcrPageStore;
    maxInFlight: number;
    log: Logger;
    /** Called after each page is recognized (progress reporting). */
    onPage?: (done: number, total: number) => void;
}

/** Progress is logged at this page interval. */
const LOG_EVERY = 25;

export function ocrStoreKey(pdfBytes: Uint8Array, engine: OcrEngine): string {
    return passKey(pdfBytes, engine.id);
}

function passKey(pdfBytes: Uint8Array, engineId: string): string {
    return sha256Hex(`${sha256Hex(pdfBytes)}|${RENDERER_ID}|${engineId}`).slice(0, 32);
}

/** The lightest gray level (paper). */
const PAPER = 255;
/** Each pass merged into a scanned page numbers its lines from a multiple of this, so passes' lines never join. */
const PASS_LINE_BASE = 1_000_000;
/** The passes a scanned page is read in before its grid cells (reader, automatic, sparse, binarized, inverted). */
const SCAN_PASSES = 5;
/** Line ordinals of re-read grid cells start after every pass's. */
const CELL_LINE_BASE = SCAN_PASSES * PASS_LINE_BASE;
/** A cell is cropped with this share of its height as margin on every side. */
const CELL_MARGIN = 0.5;

/** The pages with no text layer (scans) and the reader that reads them first. */
export interface ScanReading {
    pages: ReadonlySet<number>;
    reader: PageReader;
}

/**
 * Recognize every page of a document. Each page is read in the engine's
 * automatic mode — for a page with a text layer, the reading arbitration
 * checks that layer against. A page with no text layer (a scan) has only its
 * readings, so it takes several: first the scan reader's (`ScanReading`),
 * then the automatic one, then the engine's sparse mode (text the layout
 * analysis passes over as picture: a statblock's boxed grid, a folio in a
 * decorated corner) on the page as rendered and binarized, then the automatic
 * mode on the page inverted (light print on a dark ground). Each later reading
 * adds its confident words printed where the earlier ones found nothing (or
 * nothing but marks too unsure to keep). Last, the cells of numeric grids read
 * only in part (`gridCellsToRead`) are cropped and read one at a time, each as
 * a single line of digits.
 */
export async function recognizeDocument(
    pdfBytes: Uint8Array,
    pages: readonly RawPage[],
    engine: OcrEngine,
    opts: RecognizeOptions,
    scanReading?: ScanReading,
): Promise<OcrPage[]> {
    const main = await recognizePass(pdfBytes, pages, engine.id, (p) => engine.recognize(p), opts);
    const scanned = scanReading?.pages ?? new Set<number>();
    const scans = pages.filter((p) => scanned.has(p.pageIndex));
    const ids = scanPassIds(engine);
    const passes =
        scanReading === undefined || scans.length === 0
            ? []
            : [
                  await recognizePass(
                      pdfBytes,
                      scans,
                      scanReading.reader.id,
                      (p) => scanReading.reader.read(p),
                      opts,
                  ),
                  main,
                  await recognizePass(pdfBytes, scans, ids.sparse, (p) => engine.recognizeSparse(p), opts),
                  await recognizePass(
                      pdfBytes,
                      scans,
                      ids.binarized,
                      (p) => engine.recognizeSparse(binarized(p)),
                      opts,
                  ),
                  await recognizePass(
                      pdfBytes,
                      scans,
                      ids.inverted,
                      (p) => engine.recognize(inverted(p)),
                      opts,
                  ),
              ];
    const merged = pages.map((p) => {
        if (!scanned.has(p.pageIndex)) {
            return { pageIndex: p.pageIndex, words: main.get(p.pageIndex) ?? [], cells: [] };
        }
        const [first, ...later] = passes;
        const read = first?.get(p.pageIndex) ?? [];
        let words = [...read];
        later.forEach((pass, i) => {
            for (const w of pass.get(p.pageIndex) ?? []) {
                const under = words.filter((m) => overlaps(m.box, w.box));
                if (
                    confidentWord(w) &&
                    under.every((m) => !confidentWord(m)) &&
                    !read.some((m) => !under.includes(m) && besideOnLine(m.box, w.box))
                ) {
                    words = [
                        ...words.filter((m) => !under.includes(m)),
                        { ...w, ...rowPrint(w, read), line: (i + 1) * PASS_LINE_BASE + w.line },
                    ];
                }
            }
        });
        return { pageIndex: p.pageIndex, words, cells: [] };
    });

    const cells = new Map(
        merged
            .filter((p) => scanned.has(p.pageIndex))
            .map((p) => [p.pageIndex, gridCellsToRead(p.words)] as const)
            .filter(([, c]) => c.length > 0),
    );
    if (cells.size === 0) {
        return merged;
    }
    const cellReads = await recognizePass(
        pdfBytes,
        pages.filter((p) => cells.has(p.pageIndex)),
        // The cells chosen key the stored reads, so a change in which cells are read never serves stale ones.
        `${ids.cells}#${sha256Hex(JSON.stringify([...cells].map(([i, c]) => [i, c.map((cell) => cell.box)])))}`,
        async (page) => {
            const out: OcrWord[] = [];
            for (const [i, cell] of (cells.get(page.pageIndex) ?? []).entries()) {
                const read = await engine.recognizeCell(cellPage(page, cell.box));
                out.push(...read.map((w) => ({ ...w, line: i })));
            }
            return out;
        },
        opts,
    );
    return merged.map((p) =>
        withCellReads(p, cells.get(p.pageIndex) ?? [], cellReads.get(p.pageIndex) ?? []),
    );
}

/**
 * A page with each re-read grid cell's reading as one word set on the cell's
 * box, in place of whatever the earlier passes placed inside the cell (a
 * misread value, the box's edge read as a glyph). A cell the re-read found
 * nothing in keeps them.
 */
export function withCellReads(
    page: OcrPage,
    cells: readonly GridCellToRead[],
    read: readonly OcrWord[],
): OcrPage {
    let words = [...page.words];
    const cellWords: OcrWord[] = [];
    cells.forEach((cell, i) => {
        const found = read.filter((w) => w.line === i);
        const first = found[0];
        if (first === undefined) {
            return;
        }
        const [x0, y0, x1, y1] = cell.box;
        words = words.filter((w) => {
            const cx = (w.box[0] + w.box[2]) / 2;
            const cy = (w.box[1] + w.box[3]) / 2;
            return w !== cell.misread && !(cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1);
        });
        const word = {
            text: found.map((w) => w.text).join(""),
            confidence: Math.min(...found.map((w) => w.confidence)),
            box: cell.box,
            line: CELL_LINE_BASE + i,
            baseline: y0,
            lineHeight: y1 - y0,
            stroke: first.stroke,
        };
        cellWords.push({ ...word, ...rowPrint(word, words) });
    });
    return { pageIndex: page.pageIndex, words, cells: [...page.cells, ...cellWords] };
}

/**
 * One grid cell of a rendered page, with a margin, as a page of its own for
 * single-line recognition, placed by its view box so the words read from it
 * map back onto the page. It stays gray: binarizing so small a crop loses a
 * thin printed dash to the cell's tint.
 */
export function cellPage(page: RenderedPage, box: PdfBox): RenderedPage {
    const [vx0, , , vy1] = page.viewBox;
    const margin = CELL_MARGIN * (box[3] - box[1]);
    const px = {
        x0: Math.max(0, Math.floor((box[0] - margin - vx0) * page.scale)),
        y0: Math.max(0, Math.floor((vy1 - box[3] - margin) * page.scale)),
        x1: Math.min(page.widthPx, Math.ceil((box[2] + margin - vx0) * page.scale)),
        y1: Math.min(page.heightPx, Math.ceil((vy1 - box[1] + margin) * page.scale)),
    };
    const image = cropGray(page.image, px);
    return {
        pageIndex: page.pageIndex,
        png: grayPng(image),
        image,
        widthPx: image.width,
        heightPx: image.height,
        scale: page.scale,
        viewBox: [
            vx0 + px.x0 / page.scale,
            vy1 - px.y1 / page.scale,
            vx0 + px.x1 / page.scale,
            vy1 - px.y0 / page.scale,
        ],
    };
}

export interface ScanPassIds {
    sparse: string;
    binarized: string;
    inverted: string;
    cells: string;
}

/**
 * The cache ids of the passes a scanned page also takes: sparse mode on the
 * rendered page and on it binarized (`binarized`), the automatic mode on it
 * inverted (`inverted`), and the grid-cell re-reads (`cellPage`). All key the
 * IR cache too.
 */
export function scanPassIds(engine: OcrEngine): ScanPassIds {
    return {
        sparse: engine.sparseId,
        binarized: `${engine.sparseId}+sauvola${SAUVOLA_WINDOW}k${SAUVOLA_K}`,
        inverted: `${engine.id}+inverted`,
        cells: `${engine.cellId}m${CELL_MARGIN}`,
    };
}

/**
 * A rendered page with light and dark swapped: text set light on a dark
 * ground (a statblock's name banner, a caption over art) reads as print, and
 * the page's own dark-on-light text drops out as a ground of its own.
 */
function inverted(page: RenderedPage): RenderedPage {
    const { width, height, stride } = page.image;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            pixels[y * width + x] = PAPER - (page.image.pixels[y * stride + x] ?? PAPER);
        }
    }
    const image = { pixels, width, height, stride: width };
    return { ...page, image, png: grayPng(image) };
}

/**
 * A rendered page with its PNG binarized (see `sauvola`): a scan's textured
 * ground and the tint behind boxed cells drop away, leaving the print. The
 * gray image stays, for the ink measures recognition takes from it.
 */
function binarized(page: RenderedPage): RenderedPage {
    return { ...page, png: grayPng(sauvola(page.image)) };
}

function grayPng(image: GrayImage): Uint8Array {
    const rgba = new Uint8Array(image.width * image.height * 4);
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const v = image.pixels[y * image.stride + x] ?? 0;
            rgba.set([v, v, v, 255], (y * image.width + x) * 4);
        }
    }
    return encodePngRgba(rgba, image.width, image.height);
}

/**
 * A later reading's word on a row the first reading also read takes that
 * row's baseline and size, as the first reading measured them: each reader
 * measures type its own way, and one row is set at one size.
 */
function rowPrint(w: OcrWord, read: readonly OcrWord[]): Partial<Pick<OcrWord, "baseline" | "lineHeight">> {
    const middle = (w.box[1] + w.box[3]) / 2;
    const row = read
        .filter((m) => m.box[1] <= middle && middle <= m.box[3])
        .sort((a, b) => Math.abs(a.box[0] - w.box[0]) - Math.abs(b.box[0] - w.box[0]))[0];
    return row === undefined ? {} : { baseline: row.baseline, lineHeight: row.lineHeight };
}

/** A first reading's line reads to its ends: what lies this many line heights beyond them is apart. */
const LINE_END_REACH = 2;
/** A word sits on a line when this share of the shorter of the two heights overlaps. */
const ON_LINE_SHARE = 0.5;

/**
 * Whether box `b` sits on the line of box `a`, at or within `LINE_END_REACH`
 * of its ends. The first reading reads whole lines, so a later reading's word
 * there is a mark it rightly passed over (art, a box's edge), not a word it
 * missed.
 */
function besideOnLine(a: OcrWord["box"], b: OcrWord["box"]): boolean {
    const height = Math.min(a[3] - a[1], b[3] - b[1]);
    const shared = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    const gap = Math.max(a[0] - b[2], b[0] - a[2]);
    return shared >= ON_LINE_SHARE * height && gap <= LINE_END_REACH * (a[3] - a[1]);
}

function overlaps(a: OcrWord["box"], b: OcrWord["box"]): boolean {
    return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** One recognition pass over `pages`, through the store under the pass's engine id. */
async function recognizePass(
    pdfBytes: Uint8Array,
    pages: readonly RawPage[],
    engineId: string,
    recognize: (page: RenderedPage) => Promise<OcrWord[]>,
    opts: RecognizeOptions,
): Promise<Map<number, OcrWord[]>> {
    const key = passKey(pdfBytes, engineId);
    const results = new Map<number, OcrWord[]>();
    const pending: RawPage[] = [];
    for (const page of pages) {
        const cached = await opts.store.read(key, page.pageIndex);
        if (cached === null) {
            pending.push(page);
        } else {
            results.set(page.pageIndex, cached);
        }
    }
    if (pending.length > 0) {
        opts.log.info(`OCR: ${pending.length}/${pages.length} pages to recognize (${engineId})`);
    }

    const renderer = new PageRenderer(pdfBytes);
    const inFlight = new Set<Promise<void>>();
    try {
        let done = 0;
        for (const page of pending) {
            const rendered = renderer.render(page.pageIndex, page.viewBox);
            const task = recognize(rendered).then(async (words) => {
                await opts.store.write(key, page.pageIndex, words);
                results.set(page.pageIndex, words);
                done += 1;
                opts.onPage?.(done, pending.length);
                if (done % LOG_EVERY === 0 || done === pending.length) {
                    opts.log.info(`OCR: ${done}/${pending.length} pages recognized`);
                }
            });
            const tracked = task.finally(() => inFlight.delete(tracked));
            inFlight.add(tracked);
            if (inFlight.size >= opts.maxInFlight) {
                await Promise.race(inFlight);
            }
        }
        await Promise.all(inFlight);
    } catch (err) {
        // Let every in-flight page settle so no rejection escapes unobserved.
        await Promise.allSettled(inFlight);
        throw err;
    } finally {
        renderer.close();
    }
    return results;
}
