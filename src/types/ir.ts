// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Intermediate representations that flow through the pipeline (spec §3).
 *
 * `RawDoc` is the *only* structure produced from the extractor. Everything
 * downstream of normalization (detect/apply/enrich/emit) reads `IR` and
 * `ImageAssets` and must never reach back into `RawDoc` — that stage boundary
 * (§3) is what makes a PDF-library upgrade a single-stage change.
 */

export type FontWeight = "normal" | "bold";

/** All coordinates are PDF user space, origin bottom-left, unrotated (spec §4). */
export interface RawPage {
    pageIndex: number;
    width: number;
    height: number;
    rotation: number;
    /** Visible page box `[x0, y0, x1, y1]` in PDF user space (the renderer's origin). */
    viewBox: readonly [number, number, number, number];
    /**
     * Text set on its side along the page edge (a thumb tab, a chapter title
     * running up the margin), one string per label, in layer order. It is not
     * read as text runs; it only names the part of the book a page is in.
     */
    edgeText: string[];
}

export interface RawTextRun {
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontName: string;
    fontSize: number;
    weight: FontWeight;
    italic: boolean;
    renderOrder: number;
}

export interface RawImageXObject {
    objectId: string;
    width: number;
    height: number;
    colorspace: string;
    filter: string;
    bpc: number;
    smaskRef: string | null;
    /** FlateDecode/LZW predictor parameters, when present. */
    decodeParms: { predictor: number; colors: number; columns: number } | null;
    /** Raw (still-encoded) stream bytes as stored in the PDF. */
    bytes: Uint8Array;
}

/** Where an image XObject is painted on a page (from a content-stream `Do`). */
export interface ImagePlacement {
    objectId: string;
    pageIndex: number;
    bbox: readonly [number, number, number, number];
}

export interface DocMeta {
    title: string | null;
    author: string | null;
    producer: string | null;
    creator: string | null;
    creationDate: string | null;
}

export interface RawDoc {
    encrypted: boolean;
    extractor: string;
    pages: RawPage[];
    textRuns: RawTextRun[];
    images: RawImageXObject[];
    placements: ImagePlacement[];
    meta: DocMeta;
}

/** Canonical, normalized text run (post §5.1-5.4). */
export interface IRTextRun {
    pageIndex: number;
    /** `floor((page_height - y) / BAND_HEIGHT)` — the line-band sort key (§5.1). */
    band: number;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    font: string;
    weight: FontWeight;
    italic: boolean;
    size: number;
    /** Index into `IR.sizeBuckets`. */
    sizeBucket: number;
    /** Zero-based column index (left→right) from the page's column geometry. */
    column: number;
    /** Left indent relative to the page margin box, in points. */
    indent: number;
    renderOrder: number;
}

export interface IRPage {
    pageIndex: number;
    width: number;
    height: number;
    rotation: number;
    columns: number;
    /** The page's edge labels (see `RawPage.edgeText`), text canonicalized. */
    edgeText: string[];
}

/**
 * Content-agnostic layout descriptors (spec §7.2). Derived only from geometry
 * and typography — never from the document's text content, and never chosen for
 * resistance to watermarking (constraint C3).
 */
export interface StructuralFingerprint {
    pageSizes: { w: number; h: number; count: number }[];
    orientation: "portrait" | "landscape" | "mixed";
    columns: number;
    fonts: string[];
    sizeBuckets: number[];
    marginBox: { left: number; right: number; top: number; bottom: number };
}

export interface IR {
    irVersion: number;
    pages: IRPage[];
    runs: IRTextRun[];
    /** Sorted set of quantized font sizes present in the document (§5.3). */
    sizeBuckets: number[];
    /** Sorted set of canonical font names present (§5.4). */
    fonts: string[];
    meta: DocMeta;
    fingerprint: StructuralFingerprint;
}

export type AssetTier = "A" | "B";

/** A recovered image asset, content-addressed by its canonical bytes (§6.1). */
export interface ImageAsset {
    assetId: string;
    ext: string;
    tier: AssetTier;
    bytes: Uint8Array;
    width: number | null;
    height: number | null;
    /** Page-space bbox where the image is placed (for geometry association §6.3). */
    placement: { pageIndex: number; bbox: readonly [number, number, number, number] } | null;
    /** Source XObject ids that produced these bytes (dedup can map many→one). */
    sourceObjectIds: string[];
}

export interface ImageAssets {
    /** Deduplicated assets, ordered by `assetId` ascending. */
    assets: ImageAsset[];
    /** Placements for association, ordered by the §5.1 sort applied to bboxes. */
    placements: {
        assetId: string;
        pageIndex: number;
        bbox: readonly [number, number, number, number];
    }[];
}
