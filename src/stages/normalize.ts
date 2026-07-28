// SPDX-License-Identifier: AGPL-3.0-or-later
import { IR_VERSION } from "../version.ts";
import type {
    IR,
    IRPage,
    IRTextRun,
    RawDoc,
    RawPage,
    RawTextRun,
    StructuralFingerprint,
} from "../types/ir.ts";
import { BAND_HEIGHT, quantizeCoord, quantizeSize, quantizeWidth } from "../util/rounding.ts";
import { byteCompare, chain, numAsc } from "../util/ordered.ts";
import { canonicalizeText, stripSubsetPrefix } from "../util/text.ts";

/**
 * Stage 2 — Normalize (spec §5). Exists solely to erase extractor
 * nondeterminism. Every rule here is mandatory: canonicalize text (§5.2),
 * quantize geometry (§5.3), canonicalize font identity (§5.4), then impose a
 * total, locale-free ordering (§5.1). The output is the canonical IR that all
 * downstream stages read.
 *
 * NOTE ON §5.1 ORDERING: the spec lists the key as `(page, y_band DESC, x ASC,
 * render_order ASC)` with `y_band = floor((page_height - y)/BAND)`. That formula
 * measures distance-from-top, so DESC would order bottom-of-page first — the
 * reverse of reading order and of the stated purpose ("banding absorbs baseline
 * jitter within a line"). We resolve the inconsistency toward intent: bands are
 * distance-from-top and sorted ascending, yielding stable top→bottom,
 * left→right reading order. Determinism (A2/A4) is unaffected by the direction
 * choice; only the concrete golden bytes are.
 */

/** Left-edge x-values within this many points are treated as the same column. */
const COLUMN_CLUSTER_TOLERANCE = 12;
/** A left-edge cluster is a real column only if it anchors at least this fraction of runs. */
const COLUMN_MIN_FRACTION = 0.1;
const COLUMN_MIN_RUNS = 3;

function canonFontName(raw: string): string {
    return stripSubsetPrefix(raw).toLowerCase();
}

interface PageGeometry {
    marginLeft: number;
    marginRight: number;
    marginTop: number;
    marginBottom: number;
    columnLefts: number[];
}

/**
 * Detect columns by clustering run left-edges (§7.2). A multi-column page has
 * many runs sharing each column's left margin; page furniture (a centred
 * footer, a running head) forms only tiny clusters and is ignored. This is far
 * more robust than a whitespace-projection gutter scan, which a single item in
 * the gutter would defeat.
 */
function detectGeometry(runs: readonly RawTextRun[], page: RawPage): PageGeometry {
    if (runs.length === 0) {
        return {
            marginLeft: 0,
            marginRight: page.width,
            marginTop: page.height,
            marginBottom: 0,
            columnLefts: [0],
        };
    }
    let marginLeft = Number.POSITIVE_INFINITY;
    let marginRight = Number.NEGATIVE_INFINITY;
    let marginTop = Number.NEGATIVE_INFINITY;
    let marginBottom = Number.POSITIVE_INFINITY;
    const startCounts = new Map<number, number>();
    for (const r of runs) {
        marginLeft = Math.min(marginLeft, r.x);
        marginRight = Math.max(marginRight, r.x + r.width);
        marginTop = Math.max(marginTop, r.y + r.height);
        marginBottom = Math.min(marginBottom, r.y);
        const key = Math.round(r.x * 10) / 10;
        startCounts.set(key, (startCounts.get(key) ?? 0) + 1);
    }

    // Greedily merge nearby left-edges into clusters, summing their run counts.
    const starts = [...startCounts.keys()].sort(numAsc);
    const clusters: { edge: number; count: number }[] = [];
    for (const x of starts) {
        const count = startCounts.get(x)!;
        const last = clusters[clusters.length - 1];
        if (last !== undefined && x - last.edge <= COLUMN_CLUSTER_TOLERANCE) {
            last.count += count;
        } else {
            clusters.push({ edge: x, count });
        }
    }

    const minRuns = Math.max(COLUMN_MIN_RUNS, Math.floor(COLUMN_MIN_FRACTION * runs.length));
    const columnLefts = clusters
        .filter((c) => c.count >= minRuns)
        .map((c) => c.edge)
        .sort(numAsc);
    return {
        marginLeft,
        marginRight,
        marginTop,
        marginBottom,
        columnLefts: columnLefts.length > 0 ? columnLefts : [marginLeft],
    };
}

/** Column index = the last column-left-edge at or before `x`. */
function columnOf(x: number, columnLefts: readonly number[]): number {
    let col = 0;
    for (let i = 0; i < columnLefts.length; i += 1) {
        if (x >= columnLefts[i]! - COLUMN_CLUSTER_TOLERANCE) {
            col = i;
        }
    }
    return col;
}

function buildSortedSet(values: Iterable<number>): number[] {
    return [...new Set(values)].sort(numAsc);
}

export function normalize(raw: RawDoc): IR {
    const pages: IRPage[] = [];
    const runs: IRTextRun[] = [];
    const runsByPage = new Map<number, RawTextRun[]>();
    for (const r of raw.textRuns) {
        const list = runsByPage.get(r.pageIndex) ?? [];
        list.push(r);
        runsByPage.set(r.pageIndex, list);
    }

    const fontSet = new Set<string>();
    const sizeSet = new Set<number>();
    // First pass: quantize sizes/fonts so buckets exist before we index into them.
    for (const r of raw.textRuns) {
        sizeSet.add(quantizeSize(r.fontSize));
        fontSet.add(canonFontName(r.fontName));
    }
    const sizeBuckets = buildSortedSet(sizeSet);
    const fonts = [...fontSet].sort(byteCompare);
    const sizeBucketIndex = new Map(sizeBuckets.map((s, i) => [s, i] as const));

    const docMargin = { left: Number.POSITIVE_INFINITY, right: 0, top: 0, bottom: Number.POSITIVE_INFINITY };
    const pageColumnCounts: number[] = [];

    for (const page of [...raw.pages].sort((a, b) => numAsc(a.pageIndex, b.pageIndex))) {
        const pageRuns = runsByPage.get(page.pageIndex) ?? [];
        const geom = detectGeometry(pageRuns, page);
        const columns = geom.columnLefts.length;
        pageColumnCounts.push(columns);
        pages.push({
            pageIndex: page.pageIndex,
            width: quantizeCoord(page.width),
            height: quantizeCoord(page.height),
            rotation: page.rotation,
            columns,
        });
        docMargin.left = Math.min(docMargin.left, geom.marginLeft);
        docMargin.right = Math.max(docMargin.right, geom.marginRight);
        docMargin.top = Math.max(docMargin.top, geom.marginTop);
        docMargin.bottom = Math.min(docMargin.bottom, geom.marginBottom);

        for (const r of pageRuns) {
            const size = quantizeSize(r.fontSize);
            const x = quantizeCoord(r.x);
            const y = quantizeCoord(r.y);
            const column = columnOf(r.x, geom.columnLefts);
            const columnLeft = geom.columnLefts[column] ?? geom.marginLeft;
            const band = Math.floor((page.height - r.y) / BAND_HEIGHT);
            runs.push({
                pageIndex: page.pageIndex,
                band,
                x,
                y,
                width: quantizeWidth(r.width),
                height: quantizeWidth(r.height),
                text: canonicalizeText(r.text),
                font: canonFontName(r.fontName),
                weight: r.weight,
                italic: r.italic,
                size,
                sizeBucket: sizeBucketIndex.get(size) ?? 0,
                column,
                indent: quantizeCoord(r.x - columnLeft),
                renderOrder: r.renderOrder,
            });
        }
    }

    // §5.1 total order, resolved to COLUMN-MAJOR reading order: page, column,
    // band (top→bottom), x asc, render_order asc. The spec's literal key omits
    // `column`, but its flagship two-column statblock example (§8.3) and its
    // heavy column emphasis (§7.2, §8.5) require it: a row-major order would
    // interleave both columns' headers at the same band, making "next header"
    // block segmentation impossible. Column-major reduces to the plain
    // (page, band, x) order for single-column documents. Determinism is
    // unaffected; only the concrete golden bytes are.
    runs.sort(
        chain<IRTextRun>(
            (a, b) => numAsc(a.pageIndex, b.pageIndex),
            (a, b) => numAsc(a.column, b.column),
            (a, b) => numAsc(a.band, b.band),
            (a, b) => numAsc(a.x, b.x),
            (a, b) => numAsc(a.renderOrder, b.renderOrder),
        ),
    );

    const orientationOf = (p: RawPage): "portrait" | "landscape" =>
        p.width > p.height ? "landscape" : "portrait";
    const orientations = new Set(raw.pages.map(orientationOf));
    const orientation: StructuralFingerprint["orientation"] =
        orientations.size > 1 ? "mixed" : (orientations.values().next().value ?? "portrait");

    const pageSizeKey = (p: RawPage): string => `${quantizeCoord(p.width)}x${quantizeCoord(p.height)}`;
    const sizeCounts = new Map<string, { w: number; h: number; count: number }>();
    for (const p of raw.pages) {
        const key = pageSizeKey(p);
        const existing = sizeCounts.get(key) ?? {
            w: quantizeCoord(p.width),
            h: quantizeCoord(p.height),
            count: 0,
        };
        existing.count += 1;
        sizeCounts.set(key, existing);
    }
    const pageSizes = [...sizeCounts.values()].sort(
        chain(
            (a, b) => numAsc(a.w, b.w),
            (a, b) => numAsc(a.h, b.h),
        ),
    );

    const columnMode = pageColumnCounts.length > 0 ? mode(pageColumnCounts) : 1;

    const fingerprint: StructuralFingerprint = {
        pageSizes,
        orientation,
        columns: columnMode,
        fonts,
        sizeBuckets,
        marginBox: {
            left: Number.isFinite(docMargin.left) ? quantizeCoord(docMargin.left) : 0,
            right: quantizeCoord(docMargin.right),
            top: quantizeCoord(docMargin.top),
            bottom: Number.isFinite(docMargin.bottom) ? quantizeCoord(docMargin.bottom) : 0,
        },
    };

    return { irVersion: IR_VERSION, pages, runs, sizeBuckets, fonts, meta: raw.meta, fingerprint };
}

function mode(values: readonly number[]): number {
    const counts = new Map<number, number>();
    for (const v of values) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = values[0]!;
    let bestCount = -1;
    // Deterministic tiebreak: lowest value wins on equal counts.
    for (const v of [...counts.keys()].sort(numAsc)) {
        const c = counts.get(v)!;
        if (c > bestCount) {
            best = v;
            bestCount = c;
        }
    }
    return best;
}
