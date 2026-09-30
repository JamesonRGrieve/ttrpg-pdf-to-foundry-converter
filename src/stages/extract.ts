// SPDX-License-Identifier: AGPL-3.0-or-later
import { unzlibSync } from "fflate";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { PINS } from "../pins.ts";
import type {
    DocMeta,
    FontWeight,
    ImagePlacement,
    RawDoc,
    RawImageXObject,
    RawPage,
    RawTextRun,
} from "../types/ir.ts";
import { scanPlacements } from "./placements.ts";

/**
 * Stage 1 — Extract (spec §4). One pinned extractor; the version string goes
 * into provenance. Produces `RawDoc`, the only structure downstream stages are
 * forbidden from re-reading.
 *
 * Password-protected input is *refused* (C4): a document that will not open
 * without a password returns a `RawDoc` flagged `encrypted`, and no password
 * is ever asked for or tried. A document whose /Encrypt entry only restricts
 * permissions (an empty user password) opens as it does in any viewer; its
 * text is read, but pdf-lib, which never decrypts, cannot read its images.
 */

/** The name pdf.js gives the error for a document that needs a password to open. */
const PASSWORD_EXCEPTION = "PasswordException";

/** Pinned extractor identity recorded in provenance (§9.5). */
export const EXTRACTOR_ID = `pdfjs-dist ${PINS["pdfjs-dist"]} + pdf-lib ${PINS["pdf-lib"]}`;

interface PdfjsTextItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
    fontName: string;
}

interface PdfjsModule {
    getDocument(args: Record<string, unknown>): { promise: Promise<PdfjsDocument> };
}
interface PdfjsDocument {
    numPages: number;
    getPage(n: number): Promise<PdfjsPage>;
    getMetadata(): Promise<{
        info?: Record<string, unknown>;
        metadata?: { getAll(): Record<string, unknown> };
    }>;
    destroy(): Promise<void>;
}
interface PdfjsPage {
    view: number[];
    rotate: number;
    getViewport(opts: { scale: number; rotation?: number }): { width: number; height: number };
    getOperatorList(): Promise<unknown>;
    getTextContent(
        opts?: Record<string, unknown>,
    ): Promise<{ items: PdfjsTextItem[]; styles: Record<string, { fontFamily?: string }> }>;
    commonObjs: { has(name: string): boolean; get(name: string): unknown };
}

async function loadPdfjs(): Promise<PdfjsModule> {
    // The legacy build runs on the main thread in Node without a worker.
    const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
    return mod;
}

/** Derive weight/italic from a resolved font name suffix (§5.4 primary signal). */
function styleFromName(name: string): { weight: FontWeight; italic: boolean } {
    const lower = name.toLowerCase();
    const weight: FontWeight = /bold|black|heavy|semibold|demibold|\bbd\b/.test(lower) ? "bold" : "normal";
    const italic = /italic|oblique|\bit\b/.test(lower);
    return { weight, italic };
}

interface ResolvedFont {
    name: string;
    weight: FontWeight;
    italic: boolean;
}

function resolveFont(
    page: PdfjsPage,
    fontRef: string,
    styles: Record<string, { fontFamily?: string }>,
): ResolvedFont {
    let rawName = styles[fontRef]?.fontFamily ?? fontRef;
    let flagWeight: FontWeight | null = null;
    let flagItalic: boolean | null = null;
    if (page.commonObjs.has(fontRef)) {
        const font = page.commonObjs.get(fontRef) as {
            name?: string;
            loadedName?: string;
            bold?: boolean;
            italic?: boolean;
            flags?: number;
        };
        rawName = font.name ?? font.loadedName ?? rawName;
        if (typeof font.bold === "boolean") {
            flagWeight = font.bold ? "bold" : "normal";
        }
        if (typeof font.italic === "boolean") {
            flagItalic = font.italic;
        }
        // PDF font-descriptor flags: bit 1 (0x1) FixedPitch ... bit 7 (0x40) Italic,
        // bit 19 (0x40000) ForceBold. Descriptor flags win on disagreement (§5.4).
        if (typeof font.flags === "number") {
            if ((font.flags & 0x40) !== 0) {
                flagItalic = true;
            }
            if ((font.flags & 0x40000) !== 0) {
                flagWeight = "bold";
            }
        }
    }
    const fromName = styleFromName(rawName);
    return {
        name: rawName,
        weight: flagWeight ?? fromName.weight,
        italic: flagItalic ?? fromName.italic,
    };
}

function readMeta(info: Record<string, unknown> | undefined): DocMeta {
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return {
        title: str(info?.["Title"]),
        author: str(info?.["Author"]),
        producer: str(info?.["Producer"]),
        creator: str(info?.["Creator"]),
        creationDate: str(info?.["CreationDate"]),
    };
}

function nameOf(value: unknown): string {
    return value instanceof PDFName ? value.asString().replace(/^\//, "") : "";
}

function numberOf(dict: PDFDict, key: string, fallback: number): number {
    const v = dict.get(PDFName.of(key));
    return v instanceof PDFNumber ? v.asNumber() : fallback;
}

function readDecodeParms(
    doc: PDFDocument,
    dict: PDFDict,
): { predictor: number; colors: number; columns: number } | null {
    let parms = dict.get(PDFName.of("DecodeParms")) ?? dict.get(PDFName.of("DP"));
    if (parms instanceof PDFRef) {
        parms = doc.context.lookup(parms);
    }
    if (parms instanceof PDFArray) {
        parms = parms
            .asArray()
            .find((p) => (p instanceof PDFRef ? doc.context.lookup(p) : p) instanceof PDFDict);
        if (parms instanceof PDFRef) {
            parms = doc.context.lookup(parms);
        }
    }
    if (!(parms instanceof PDFDict)) {
        return null;
    }
    return {
        predictor: numberOf(parms, "Predictor", 1),
        colors: numberOf(parms, "Colors", 1),
        columns: numberOf(parms, "Columns", 1),
    };
}

/** Enumerate every image XObject, returning raw (still-encoded) stream bytes. */
function extractImageXObjects(doc: PDFDocument): RawImageXObject[] {
    const out: RawImageXObject[] = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) {
            continue;
        }
        const dict = obj.dict;
        if (nameOf(dict.get(PDFName.of("Subtype"))) !== "Image") {
            continue;
        }
        const filterVal = dict.get(PDFName.of("Filter"));
        const filter =
            filterVal instanceof PDFArray
                ? filterVal
                      .asArray()
                      .map((f) => nameOf(f))
                      .filter((f) => f.length > 0)
                      .join("+")
                : nameOf(filterVal);
        const csVal = dict.get(PDFName.of("ColorSpace"));
        const colorspace = csVal instanceof PDFArray ? nameOf(csVal.asArray()[0]) : nameOf(csVal);
        const smaskVal = dict.get(PDFName.of("SMask"));
        out.push({
            objectId: ref.toString(),
            width: numberOf(dict, "Width", 0),
            height: numberOf(dict, "Height", 0),
            colorspace,
            filter,
            bpc: numberOf(dict, "BitsPerComponent", 8),
            smaskRef: smaskVal instanceof PDFRef ? smaskVal.toString() : null,
            decodeParms: readDecodeParms(doc, dict),
            bytes: obj.getContents(),
        });
    }
    // Stable order by object id so extraction never depends on enumeration order.
    out.sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
    return out;
}

/** Decode a page's concatenated content stream to bytes (inflating Flate). */
function pageContentBytes(doc: PDFDocument, contents: unknown): Uint8Array {
    const streams: PDFStream[] = [];
    if (contents instanceof PDFRef) {
        const resolved = doc.context.lookup(contents);
        if (resolved instanceof PDFStream) {
            streams.push(resolved);
        }
    } else if (contents instanceof PDFArray) {
        for (const el of contents.asArray()) {
            const resolved = el instanceof PDFRef ? doc.context.lookup(el) : el;
            if (resolved instanceof PDFStream) {
                streams.push(resolved);
            }
        }
    } else if (contents instanceof PDFStream) {
        streams.push(contents);
    }

    const chunks: Uint8Array[] = [];
    for (const stream of streams) {
        if (!(stream instanceof PDFRawStream)) {
            continue;
        }
        const raw = stream.getContents();
        const filter = nameOf(stream.dict.get(PDFName.of("Filter")));
        if (filter === "FlateDecode") {
            try {
                chunks.push(unzlibSync(raw));
            } catch {
                // Undecodable content stream — skip; placements are best-effort.
            }
        } else {
            chunks.push(raw);
        }
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total + chunks.length);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
        merged[offset] = 0x0a; // newline separator between streams
        offset += 1;
    }
    return merged;
}

/** Resolve a page's `/Resources /XObject` name → objectId map. */
function pageXObjectRefs(doc: PDFDocument, resources: unknown): Map<string, string> {
    const map = new Map<string, string>();
    let res = resources;
    if (res instanceof PDFRef) {
        res = doc.context.lookup(res);
    }
    if (!(res instanceof PDFDict)) {
        return map;
    }
    let xobj = res.get(PDFName.of("XObject"));
    if (xobj instanceof PDFRef) {
        xobj = doc.context.lookup(xobj);
    }
    if (!(xobj instanceof PDFDict)) {
        return map;
    }
    for (const [key, value] of xobj.entries()) {
        if (value instanceof PDFRef) {
            map.set(key.asString().replace(/^\//, ""), value.toString());
        }
    }
    return map;
}

/**
 * Whether text set with this matrix [a, b, …] reads across the page. Text
 * turned on its side (a thumb tab or spine running up a page edge) is page
 * furniture: its reported width lies along its own baseline, so read as a
 * horizontal run it would span the page and pass for a heading.
 */
export function readsAcross(matrix: readonly number[]): boolean {
    const [a = 0, b = 0] = matrix;
    return Math.abs(b) <= Math.abs(a);
}

export async function extract(pdfBytes: Uint8Array): Promise<RawDoc> {
    const empty = (encrypted: boolean): RawDoc => ({
        encrypted,
        extractor: EXTRACTOR_ID,
        pages: [],
        textRuns: [],
        images: [],
        placements: [],
        meta: { title: null, author: null, producer: null, creator: null, creationDate: null },
    });

    // Work on a private copy: pdfjs transfers/detaches the `data` typed array it
    // is given, which would neuter a caller's buffer and corrupt any later run
    // that reuses the same bytes. Cloning keeps the input pristine.
    const bytes = pdfBytes.slice();

    // pdf-lib reads the raw structure (`ignoreEncryption`: it never decrypts).
    // A document carrying an /Encrypt entry may still open without a password
    // (permissions-only protection, an empty user password, which every viewer
    // opens); its streams are encrypted, so pdf-lib cannot read its images.
    const pdflibDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const restricted = pdflibDoc.isEncrypted;

    const images = restricted ? [] : extractImageXObjects(pdflibDoc);

    // Best-effort image placements from content streams (§6.3). Failure here only
    // weakens image→entity association; it never affects Tier A asset bytes.
    const placements: ImagePlacement[] = [];
    const pdflibPages = restricted ? [] : pdflibDoc.getPages();
    for (const [i, pdflibPage] of pdflibPages.entries()) {
        const leaf = pdflibPage.node;
        const content = pageContentBytes(pdflibDoc, leaf.get(PDFName.of("Contents")));
        const xobjectRefs = pageXObjectRefs(pdflibDoc, leaf.Resources() ?? leaf.get(PDFName.of("Resources")));
        for (const placement of scanPlacements(content, xobjectRefs, i)) {
            placements.push(placement);
        }
    }
    placements.sort((a, b) =>
        a.pageIndex !== b.pageIndex
            ? a.pageIndex - b.pageIndex
            : a.objectId < b.objectId
              ? -1
              : a.objectId > b.objectId
                ? 1
                : 0,
    );

    const pdfjs = await loadPdfjs();
    const loadingTask = pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        stopAtErrors: false,
    });
    // Encryption gate — refuse, never ask for or try a password (C4 / §4): a
    // document that will not open without one is refused. pdf.js reports that
    // as a PasswordException (keyed on its name: bundled error classes break
    // `instanceof`).
    let doc: PdfjsDocument;
    try {
        doc = await loadingTask.promise;
    } catch (err: unknown) {
        if (err instanceof Error && err.name === PASSWORD_EXCEPTION) {
            return empty(true);
        }
        throw err;
    }
    try {
        const metadata = await doc.getMetadata();
        const meta = readMeta(metadata.info);
        const pages: RawPage[] = [];
        const textRuns: RawTextRun[] = [];
        for (let p = 1; p <= doc.numPages; p += 1) {
            const page = await doc.getPage(p);
            // [x0, y0, x1, y1] in PDF user space (pdf.js always gives four numbers).
            const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
            const width = x1 - x0;
            const height = y1 - y0;
            const pageIndex = p - 1;
            pages.push({
                pageIndex,
                width,
                height,
                rotation: page.rotate,
                viewBox: [x0, y0, x1, y1],
            });
            // Force font objects into commonObjs before reading text styles.
            await page.getOperatorList();
            const content = await page.getTextContent({ includeMarkedContent: false });
            let order = 0;
            for (const item of content.items) {
                const matrix = item.transform.map(Number);
                if (item.str.length === 0 || !readsAcross(matrix)) {
                    continue;
                }
                // Text matrix [a, b, c, d, e, f]: size from the (c, d) column, origin (e, f).
                const [, , c = 0, d = 0, e = 0, f = 0] = matrix;
                const size = Math.hypot(c, d);
                const font = resolveFont(page, item.fontName, content.styles);
                textRuns.push({
                    pageIndex,
                    x: e,
                    y: f,
                    width: item.width,
                    height: item.height,
                    text: item.str,
                    fontName: font.name,
                    fontSize: size,
                    weight: font.weight,
                    italic: font.italic,
                    renderOrder: order,
                });
                order += 1;
            }
        }
        return { encrypted: false, extractor: EXTRACTOR_ID, pages, textRuns, images, placements, meta };
    } finally {
        await doc.destroy();
    }
}
