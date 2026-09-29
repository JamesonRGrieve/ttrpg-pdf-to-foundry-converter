// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
    IR,
    IRPage,
    IRTextRun,
    RawDoc,
    RawPage,
    RawTextRun,
    StructuralFingerprint,
} from "../types/ir.ts";
import { groupByBaseline } from "../util/baselines.ts";
import { columnAt } from "../util/columns.ts";
import { byteCompare, chain, numAsc } from "../util/ordered.ts";
import { inFurnitureBand, inSideMargin } from "../util/page-bands.ts";
import { BAND_HEIGHT, quantizeCoord, quantizeSize, quantizeWidth } from "../util/rounding.ts";
import { percentile } from "../util/stats.ts";
import { canonicalizeText, stripSubsetPrefix } from "../util/text.ts";
import { IR_VERSION } from "../version.ts";

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

/** Narrowest empty vertical channel that separates two text columns, in points. */
const GUTTER_MIN_WIDTH = 8;
/**
 * A channel still counts as a gutter when at most this many runs cross it: a
 * heading or two spanning both columns must not merge them, but a paragraph's
 * lines crossing it prove it is inside one column (e.g. a table's cell gap).
 */
const GUTTER_MAX_CROSSING_RUNS = 2;
/** Tolerance when assigning a run to the column whose left edge it starts at. */
const COLUMN_EDGE_TOLERANCE = 2;
/** Runs whose baselines lie within this many points share one line. */
const LINE_TOLERANCE = 2.5;
/** Full-measure prose lines each side of a region needs before it counts as two text columns. */
const MIN_COLUMN_LINES = 3;
/**
 * A run spanning at least this share of its side's width (margin to gutter,
 * gutter channel included) is a full-measure prose line.
 */
const FULL_MEASURE_SHARE = 0.85;
/** A gap between lines this many times their typical gap sets a block apart. */
const REGION_GAP_FACTOR = 2.5;
/** Fewest pages of a parity a column layout recurs on to be one of the document's layouts. */
const MIN_LAYOUT_PAGES = 2;
/** Points a page's column edge may stray from its layout's and still follow it. */
const LAYOUT_TOLERANCE = 4;
/** Narrowest share of the page width a layout's text column spans. */
const MIN_COLUMN_SHARE = 0.15;
/** Fewest prose columns a region needs to be read as columns at all. */
const MIN_PROSE_COLUMNS = 2;

function canonFontName(raw: string): string {
    return stripSubsetPrefix(raw).toLowerCase();
}

interface PageGeometry {
    marginLeft: number;
    marginRight: number;
    marginTop: number;
    marginBottom: number;
    columnLefts: number[];
    /** Where each column but the last ends: the start of the gutter channel after it. */
    columnRights: number[];
}

/** A document column layout: each gutter (the column edges after the first) and where the column before it ends. */
interface DocumentLayout {
    gutters: number[];
    rights: number[];
}

/**
 * Detect text columns by their gutters (§7.2): vertical channels at least
 * GUTTER_MIN_WIDTH wide that (almost) no run crosses. Tab stops inside a column
 * — a label and its value, table cells inside prose — are NOT gutters, because
 * the column's full-width lines cross them; clustering left edges would wrongly
 * split them into columns and tear labels from values in reading order. A few
 * crossing runs are tolerated so a heading spanning two columns does not merge
 * them.
 */
function detectGeometry(runs: readonly RawTextRun[], page: RawPage): PageGeometry {
    if (runs.length === 0) {
        return {
            marginLeft: 0,
            marginRight: page.width,
            marginTop: page.height,
            marginBottom: 0,
            columnLefts: [0],
            columnRights: [],
        };
    }
    let marginLeft = Number.POSITIVE_INFINITY;
    let marginRight = Number.NEGATIVE_INFINITY;
    let marginTop = Number.NEGATIVE_INFINITY;
    let marginBottom = Number.POSITIVE_INFINITY;
    for (const r of runs) {
        marginLeft = Math.min(marginLeft, r.x);
        marginRight = Math.max(marginRight, r.x + r.width);
        marginTop = Math.max(marginTop, r.y + r.height);
        marginBottom = Math.min(marginBottom, r.y);
    }

    // Per whole point across the text block: how many runs cover it. Page
    // furniture in the top/bottom margin bands (a centred running head or
    // footer) spans the gutter by design and is not evidence against it, and
    // a thumb-index tab out in a side margin is no column.
    const origin = Math.floor(marginLeft);
    const span = Math.max(0, Math.ceil(marginRight) - origin);
    const coverage = new Array<number>(span).fill(0);
    for (const r of runs) {
        if (
            r.width <= 0 ||
            inFurnitureBand(r.y, page.height) ||
            inSideMargin(r.x, r.x + r.width, page.width)
        ) {
            continue;
        }
        const from = Math.max(0, Math.floor(r.x) - origin);
        const to = Math.min(span, Math.ceil(r.x + r.width) - origin);
        for (let i = from; i < to; i += 1) {
            coverage[i] = (coverage[i] ?? 0) + 1;
        }
    }
    const maxCrossing = GUTTER_MAX_CROSSING_RUNS;
    const columnLefts = [marginLeft];
    const columnRights: number[] = [];
    let gapStart = -1;
    for (let i = 0; i <= span; i += 1) {
        const open = i < span && (coverage[i] ?? 0) <= maxCrossing;
        if (open && gapStart < 0) {
            gapStart = i;
        } else if (!open && gapStart >= 0) {
            // A gutter must have content on both sides and be wide enough.
            if (gapStart > 0 && i < span && i - gapStart >= GUTTER_MIN_WIDTH) {
                columnLefts.push(origin + i);
                columnRights.push(origin + gapStart);
            }
            gapStart = -1;
        }
    }
    return { marginLeft, marginRight, marginTop, marginBottom, columnLefts, columnRights };
}

/** Each run's column (numbered in reading order) and every column's left edge. */
interface ColumnLayout {
    columnOf: Map<RawTextRun, number>;
    lefts: number[];
}

function pageLayout(runs: readonly RawTextRun[], columnLefts: readonly number[]): ColumnLayout {
    return {
        columnOf: new Map(runs.map((r) => [r, columnAt(r.x, columnLefts, COLUMN_EDGE_TOLERANCE)] as const)),
        lefts: [...columnLefts],
    };
}

/**
 * The document's column layouts per facing parity, most columns first. A
 * layout is the modal edge set of the pages with that many columns, kept when
 * it recurs on at least MIN_LAYOUT_PAGES of them and every column is at least
 * MIN_COLUMN_SHARE of the page wide (a table's cell edges are not a page
 * layout); where each column ends is the median over those pages. Recto and
 * verso pages mirror their margins, so each parity keeps its own.
 */
function documentLayouts(
    geometries: ReadonlyMap<number, PageGeometry>,
    pageWidths: ReadonlyMap<number, number>,
): Map<number, DocumentLayout[]> {
    const byShape = new Map<string, { parity: number; count: number; pages: PageGeometry[] }>();
    for (const [pageIndex, geom] of geometries) {
        const count = geom.columnLefts.length;
        if (count >= 2) {
            const key = `${pageIndex % 2}:${count}`;
            const shape = byShape.get(key) ?? { parity: pageIndex % 2, count, pages: [] };
            shape.pages.push(geom);
            byShape.set(key, shape);
        }
    }
    const minWidth = MIN_COLUMN_SHARE * Math.min(...pageWidths.values());
    const out = new Map<number, DocumentLayout[]>();
    for (const shape of [...byShape.values()].sort((a, b) => numAsc(b.count, a.count))) {
        const gutters = Array.from({ length: shape.count - 1 }, (_, i) =>
            mode(shape.pages.map((g) => quantizeCoord(g.columnLefts[i + 1] ?? 0))),
        );
        const supporting = shape.pages.filter((g) =>
            gutters.every((gutter, i) => Math.abs((g.columnLefts[i + 1] ?? 0) - gutter) <= LAYOUT_TOLERANCE),
        );
        const narrowest = Math.min(...gutters.slice(1).map((g, i) => g - (gutters[i] ?? 0)));
        if (supporting.length >= MIN_LAYOUT_PAGES && narrowest >= minWidth) {
            const rights = gutters.map((_, i) =>
                percentile(supporting.map((g) => g.columnRights[i] ?? 0).sort(numAsc), 0.5),
            );
            out.set(shape.parity, [...(out.get(shape.parity) ?? []), { gutters, rights }]);
        }
    }
    return out;
}

/**
 * A side of a region reads as a prose column when several of its runs each
 * span nearly the side's whole `width`, as full lines of running text do. A
 * table's cells, however aligned, never fill the width alone.
 */
function proseColumn(runs: readonly RawTextRun[], width: number): boolean {
    return runs.filter((r) => r.width >= FULL_MEASURE_SHARE * width).length >= MIN_COLUMN_LINES;
}

/**
 * Lines (top to bottom) cut into pieces wherever the gap to the next line
 * exceeds REGION_GAP_FACTOR times the typical gap: whitespace setting a block
 * apart.
 */
function gapPieces<T extends { y: number }>(lines: readonly T[]): T[][] {
    const gaps = lines.slice(1).map((l, i) => (lines[i]?.y ?? l.y) - l.y);
    const typical = percentile([...gaps].sort(numAsc), 0.5);
    const pieces: T[][] = [];
    lines.forEach((line, i) => {
        const gap = i === 0 ? 0 : (gaps[i - 1] ?? 0);
        const current = pieces.at(-1);
        if (current === undefined || gap > REGION_GAP_FACTOR * typical) {
            pieces.push([line]);
        } else {
            current.push(line);
        }
    });
    return pieces;
}

/**
 * Columns of a page the whole-page gutter test reads as one column because a
 * block spans the gutters somewhere (a full-width figure, diagram or table
 * above or below the text columns). The page is cut into horizontal regions
 * at the lines that cross one of a document layout's `gutters`; a region that
 * no line crosses and whose every column is prose reads as those columns, and
 * everything else as one. Columns are numbered top region first, left to
 * right. Returns null when no region splits.
 */
function regionLayout(
    runs: readonly RawTextRun[],
    page: RawPage,
    { gutters, rights }: DocumentLayout,
    marginLeft: number,
): ColumnLayout | null {
    const crosses = (r: RawTextRun): boolean =>
        r.width > 0 &&
        gutters.some(
            (gutter) => r.x < gutter - COLUMN_EDGE_TOLERANCE && r.x + r.width > gutter - GUTTER_MIN_WIDTH,
        );
    const body = runs.filter(
        (r) => !inFurnitureBand(r.y, page.height) && !inSideMargin(r.x, r.x + r.width, page.width),
    );
    if (body.length === 0) {
        return null;
    }
    // The text block's own extent: a folio, running head or thumb-index tab
    // in the margin would widen the measure past any line of prose.
    const bodyLeft = Math.min(...body.map((r) => r.x));
    const bodyRight = Math.max(...body.map((r) => r.x + r.width));
    const lines = groupByBaseline(
        [...body].sort((a, b) => numAsc(b.y, a.y)),
        LINE_TOLERANCE,
    );
    const segments: { open: boolean; lines: typeof lines }[] = [];
    for (const line of lines) {
        const open = !line.runs.some(crosses);
        const last = segments.at(-1);
        if (last?.open === open) {
            last.lines.push(line);
        } else {
            segments.push({ open, lines: [line] });
        }
    }
    /** The column a run starts in: how many gutters lie left of it. */
    const columnIn = (r: RawTextRun): number =>
        gutters.filter((gutter) => r.x >= gutter - COLUMN_EDGE_TOLERANCE).length;
    // Each column's measure runs from its edge to where the layout ends it,
    // short of the gutter channel beside it (the last to the text block's edge).
    const measures = [bodyLeft, ...gutters].map((left, i) => (rights[i] ?? bodyRight) - left);
    // A column empty of text in a piece holds a picture; every other column
    // must be prose, and at least two must be.
    const allColumns = (piece: typeof lines): boolean => {
        const pieceRuns = piece.flatMap((l) => l.runs);
        const columns = measures.map((measure, i) => {
            const inColumn = pieceRuns.filter((r) => columnIn(r) === i);
            return inColumn.length === 0 ? null : proseColumn(inColumn, measure);
        });
        return !columns.includes(false) && columns.filter((c) => c === true).length >= MIN_PROSE_COLUMNS;
    };
    // An open segment splits from its first to its last all-column piece;
    // pieces set off beyond them (a table's caption and header above its
    // spanning rows) stay with the one-column block they sit against.
    const blocks: { split: boolean; lines: typeof lines }[] = segments.flatMap((s) => {
        if (!s.open) {
            return [{ split: false, lines: s.lines }];
        }
        const pieces = gapPieces(s.lines);
        const qualified = pieces.map(allColumns);
        const first = qualified.indexOf(true);
        const last = qualified.lastIndexOf(true);
        return pieces.map((piece, i) => ({ split: first >= 0 && i >= first && i <= last, lines: piece }));
    });
    if (!blocks.some((b) => b.split)) {
        return null;
    }

    // Consecutive blocks of the same kind form one region; each region opens
    // one column, or the layout's columns when split.
    const lefts: number[] = [];
    const regions = blocks.map((block, i) => {
        if (i === 0 || blocks[i - 1]?.split !== block.split) {
            lefts.push(marginLeft, ...(block.split ? gutters : []));
        }
        return { split: block.split, base: lefts.length - (block.split ? gutters.length + 1 : 1) };
    });
    const columnOf = new Map<RawTextRun, number>();
    const place = (r: RawTextRun, region: { split: boolean; base: number } | undefined): void => {
        columnOf.set(r, (region?.base ?? 0) + (region?.split === true ? columnIn(r) : 0));
    };
    blocks.forEach((block, i) => {
        for (const r of block.lines.flatMap((l) => l.runs)) {
            place(r, regions[i]);
        }
    });
    // Runs in the page's margins join the region at their edge of the page.
    for (const r of runs) {
        if (!columnOf.has(r)) {
            place(r, r.y > page.height / 2 ? regions[0] : regions.at(-1));
        }
    }
    return { columnOf, lefts };
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

    const sortedPages = [...raw.pages].sort((a, b) => numAsc(a.pageIndex, b.pageIndex));
    const geometries = new Map(
        sortedPages.map(
            (page) => [page.pageIndex, detectGeometry(runsByPage.get(page.pageIndex) ?? [], page)] as const,
        ),
    );
    const layouts = documentLayouts(
        geometries,
        new Map(sortedPages.map((p) => [p.pageIndex, p.width] as const)),
    );

    for (const page of sortedPages) {
        const pageRuns = runsByPage.get(page.pageIndex) ?? [];
        const geom = geometries.get(page.pageIndex) ?? detectGeometry(pageRuns, page);
        // The first of the document's layouts (most columns first) any region splits by.
        const regional =
            geom.columnLefts.length === 1
                ? (layouts.get(page.pageIndex % 2) ?? []).reduce<ColumnLayout | null>(
                      (found, candidate) => found ?? regionLayout(pageRuns, page, candidate, geom.marginLeft),
                      null,
                  )
                : null;
        const layout = regional ?? pageLayout(pageRuns, geom.columnLefts);
        const columns = layout.lefts.length;
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

        // A run printed twice over itself (an overprint in the text layer)
        // carries its text once.
        const printed = new Set<string>();
        for (const r of pageRuns) {
            const size = quantizeSize(r.fontSize);
            const x = quantizeCoord(r.x);
            const y = quantizeCoord(r.y);
            const text = canonicalizeText(r.text);
            const placement = [x, y, quantizeWidth(r.width), size, r.fontName, r.weight, text].join("\u0000");
            if (text.trim().length > 0 && printed.has(placement)) {
                continue;
            }
            printed.add(placement);
            const column = layout.columnOf.get(r) ?? 0;
            const columnLeft = layout.lefts[column] ?? geom.marginLeft;
            const band = Math.floor((page.height - r.y) / BAND_HEIGHT);
            runs.push({
                pageIndex: page.pageIndex,
                band,
                x,
                y,
                width: quantizeWidth(r.width),
                height: quantizeWidth(r.height),
                text,
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
    let best = 0;
    let bestCount = -1;
    // Deterministic tiebreak: lowest value wins on equal counts.
    for (const [v, c] of [...counts.entries()].sort((a, b) => numAsc(a[0], b[0]))) {
        if (c > bestCount) {
            best = v;
            bestCount = c;
        }
    }
    return best;
}
