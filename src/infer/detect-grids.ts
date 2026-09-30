// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";
import { type BaselineLine, groupByBaseline } from "../util/baselines.ts";
import { inMarginBand, type MarginBands, marginBandsOf } from "../util/page-bands.ts";
import { wordBreakBetween, wordSpace } from "../util/text.ts";
import type { DetectedNumericGrid } from "./types.ts";

/**
 * Detect numeric grids from IR text runs using purely structural analysis.
 * A numeric grid is a cluster of numeric text runs arranged in rows and columns
 * at consistent spacing. No font names, no content vocabulary.
 *
 * Algorithm:
 * 1. Find all numeric runs (digits only or dash for absent values)
 * 2. Cluster nearby numeric runs by spatial proximity
 * 3. Within each cluster, detect rows (consistent y) and columns (consistent x)
 * 4. Accept clusters that form at least a 3×3 grid
 * 5. Read short text labels near each column (above the grid)
 * 6. Read the name banner above the grid (bold text above the label row)
 */

const ROW_GAP = 60;
const COL_GAP = 85;
const ROW_TOL = 10;

/** The system schema's characteristic keys, in statblock order (output format knowledge). */
export const SCHEMA_CHAR_ORDER: readonly string[] = ["ws", "bs", "s", "t", "ag", "int", "per", "wp", "fel"];

interface GridCell {
    run: IRTextRun;
    value: number;
}

interface CharGrid {
    cells: GridCell[];
    pageIndex: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

function isGridNumeric(run: IRTextRun): boolean {
    return /^\d+$/.test(run.text) || run.text === "-";
}

/**
 * Discover font roles at runtime by frequency analysis. The body-text font is
 * the most common non-bold font with runs longer than 3 chars. The grid-value
 * font is a bold font that appears in numeric-only runs — discovered, never
 * hardcoded.
 */
function discoverFontRoles(ir: IR): { bodyFont: string; gridFont: string | null; gridSize: number } {
    const fontCounts = new Map<string, number>();
    const boldNumericFonts = new Map<string, { count: number; sizes: number[] }>();

    for (const r of ir.runs) {
        if (r.text.trim().length > 3 && r.weight === "normal") {
            fontCounts.set(r.font, (fontCounts.get(r.font) ?? 0) + 1);
        }
        if (r.weight === "bold" && /^\d+$/.test(r.text)) {
            const entry = boldNumericFonts.get(r.font) ?? { count: 0, sizes: [] };
            entry.count++;
            entry.sizes.push(r.size);
            boldNumericFonts.set(r.font, entry);
        }
    }

    let bodyFont = "";
    let bestCount = 0;
    for (const [font, count] of fontCounts) {
        if (count > bestCount) {
            bodyFont = font;
            bestCount = count;
        }
    }

    // The grid font is a bold font used for many 2-digit numeric values at a
    // consistent size, distinct from the body font.
    let gridFont: string | null = null;
    let gridSize = 0;
    let bestGridScore = 0;
    for (const [font, info] of boldNumericFonts) {
        if (font === bodyFont) {
            continue;
        }
        if (info.count < 20) {
            continue;
        }
        // Find the most common size for this font's numeric runs
        const sizeCounts = new Map<number, number>();
        for (const s of info.sizes) {
            const rounded = Math.round(s);
            sizeCounts.set(rounded, (sizeCounts.get(rounded) ?? 0) + 1);
        }
        let peakSize = 0;
        let peakCount = 0;
        for (const [s, c] of sizeCounts) {
            if (c > peakCount) {
                peakSize = s;
                peakCount = c;
            }
        }
        if (peakCount > bestGridScore) {
            bestGridScore = peakCount;
            gridFont = font;
            gridSize = peakSize;
        }
    }

    return { bodyFont, gridFont, gridSize };
}

function findGridsOnPage(ir: IR, pageIndex: number, gridFont: string | null, gridSize: number): CharGrid[] {
    const candidates = ir.runs.filter((r) => {
        if (r.pageIndex !== pageIndex) {
            return false;
        }
        if (!isGridNumeric(r)) {
            return false;
        }
        if (r.weight !== "bold") {
            return false;
        }
        if (gridFont && r.font !== gridFont) {
            return false;
        }
        if (gridSize > 0 && Math.abs(r.size - gridSize) > 1) {
            return false;
        }
        return true;
    });
    if (candidates.length < 9) {
        return [];
    }

    // Union-find over candidates close enough to share a grid.
    const parent = candidates.map((_, i) => i);
    const find = (i: number): number => {
        let n = i;
        for (let p = parent[n] ?? n; p !== n; p = parent[n] ?? n) {
            const grand = parent[p] ?? p;
            parent[n] = grand;
            n = grand;
        }
        return n;
    };

    candidates.forEach((a, i) => {
        candidates.forEach((b, j) => {
            if (j > i && Math.abs(a.y - b.y) < ROW_GAP && Math.abs(a.x - b.x) < COL_GAP) {
                parent[find(i)] = find(j);
            }
        });
    });

    const groups = new Map<number, IRTextRun[]>();
    candidates.forEach((c, i) => {
        const g = groups.get(find(i)) ?? [];
        g.push(c);
        groups.set(find(i), g);
    });

    const grids: CharGrid[] = [];
    for (const g of groups.values()) {
        const rows = groupByBaseline(
            [...g].sort((a, b) => b.y - a.y),
            ROW_TOL,
        );
        // Characteristic grids are exactly 3 rows of exactly 3 values
        const rowsOf3 = rows.filter((r) => r.runs.length === 3);
        if (rowsOf3.length !== 3) {
            continue;
        }
        const validRows = rowsOf3.map((r) => r.runs);
        // Values must be plausible stat values (0-99 or dash=0)
        const allValues = validRows.flat().map((r) => (r.text === "-" ? 0 : Number.parseInt(r.text, 10)));
        if (allValues.some((v) => v > 100)) {
            continue;
        }
        // Must have variety: a block of one repeated number is not a characteristic grid
        const uniqueValues = new Set(allValues);
        if (uniqueValues.size < 2) {
            continue;
        }
        // Rows must be roughly evenly spaced vertically
        const [top, middle, bottom] = rowsOf3.map((r) => r.y).sort((a, b) => b - a);
        if (top !== undefined && middle !== undefined && bottom !== undefined) {
            const gap1 = Math.abs(top - middle);
            const gap2 = Math.abs(middle - bottom);
            if (gap1 > 0 && gap2 > 0 && Math.abs(gap1 - gap2) > gap1 * 0.5) {
                continue;
            }
        }

        const flat = validRows.flat();
        const cells: GridCell[] = validRows.flatMap((r) =>
            [...r]
                .sort((a, b) => a.x - b.x)
                .map((run) => ({
                    run,
                    value: run.text === "-" ? 0 : Number.parseInt(run.text, 10),
                })),
        );

        grids.push({
            cells,
            pageIndex,
            x0: Math.min(...flat.map((c) => c.x)),
            y0: Math.min(...flat.map((c) => c.y)),
            x1: Math.max(...flat.map((c) => c.x)),
            y1: Math.max(...flat.map((c) => c.y)),
        });
    }
    return grids;
}

function readLabelsForGrid(ir: IR, grid: CharGrid): string[] {
    // For a 3×3 characteristic grid, each value has a short label (1-3 chars)
    // positioned near it. Labels can be above or to the side of each value.
    // Match labels to grid cells by proximity.
    const labels: string[] = [];

    // Find all short text runs near the grid that could be labels
    const labelCandidates = ir.runs.filter(
        (r) =>
            r.pageIndex === grid.pageIndex &&
            r.text.trim().length >= 1 &&
            r.text.trim().length <= 4 &&
            r.y >= grid.y0 - 10 &&
            r.y <= grid.y1 + 30 &&
            r.x >= grid.x0 - 30 &&
            r.x <= grid.x1 + 30 &&
            // Labels are typically italic or in a different weight/font from values
            (r.italic || r.weight !== "bold" || r.font !== grid.cells[0]?.run.font),
    );

    // Merge adjacent label fragments (small-caps fonts split "AG" into "A" + "G")
    const sorted = [...labelCandidates].sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : b.y - a.y));
    const mergedLabels: { text: string; x: number; y: number }[] = [];
    for (const r of sorted) {
        const last = mergedLabels[mergedLabels.length - 1];
        if (last && Math.abs(r.y - last.y) < 4 && r.x - (last.x + 15) < 5) {
            last.text += r.text.trim();
        } else {
            mergedLabels.push({ text: r.text.trim(), x: r.x, y: r.y });
        }
    }

    // For each grid cell, find the nearest merged label
    for (const cell of grid.cells) {
        let bestLabel = "";
        let bestDist = Number.POSITIVE_INFINITY;
        for (const label of mergedLabels) {
            const dx = Math.abs(label.x - cell.run.x);
            const dy = label.y - cell.run.y;
            if (dy < -5 || dy > 25) {
                continue;
            }
            if (dx > 40) {
                continue;
            }
            const dist = dx + Math.abs(dy);
            if (dist < bestDist) {
                bestDist = dist;
                bestLabel = label.text.toLowerCase();
            }
        }
        labels.push(bestLabel);
    }

    // Validate each label against the schema. If a label doesn't exactly match
    // a known characteristic key, it's garbled (e.g. "t6" instead of "t").
    // Use positional mapping whenever labels are unreliable.
    if (grid.cells.length === 9) {
        const validCount = labels.filter((l) => SCHEMA_CHAR_ORDER.includes(l)).length;
        if (validCount < 7) {
            return [...SCHEMA_CHAR_ORDER];
        }
        // Fix individual garbled labels while keeping correct ones in position
        return labels.map((l, i) => (SCHEMA_CHAR_ORDER.includes(l) ? l : (SCHEMA_CHAR_ORDER[i] ?? l)));
    }

    return labels.length > 0 ? labels : [...SCHEMA_CHAR_ORDER];
}

/** How far above the grid's top row the name banner may sit. */
const BANNER_REACH = 120;
/** Widest gap between runs of one banner (a wounds value sits apart at the right). */
const BANNER_GAP = 70;

interface Banner {
    name: string;
    /** A lone number printed on the banner line (the statblock's headline value). */
    number: number | null;
    x0: number;
    x1: number;
    /** Baseline of the banner line. */
    y: number;
    /** The text column the banner is set in. */
    column: number;
}

/** Points of horizontal gap within which a field label's runs still read as one label. */
const PANEL_WORD_GAP = 3;

/** Join a line's runs left to right, spacing only across visible gaps. */
function joinLine(runs: readonly IRTextRun[]): string {
    const fragments: string[] = [];
    let prevEnd = Number.NEGATIVE_INFINITY;
    let prevSize = 0;
    for (const r of [...runs].sort((a, b) => a.x - b.x)) {
        if (r.text.length === 0) {
            continue;
        }
        if (
            fragments.length > 0 &&
            wordBreakBetween(fragments.join(""), r.text, r.x - prevEnd, wordSpace(prevSize, r.size))
        ) {
            fragments.push(" ");
        }
        fragments.push(r.text);
        prevEnd = r.x + r.width;
        prevSize = r.size;
    }
    return fragments.join("").replace(/\s+/gu, " ").trim();
}

/** The size of a line's largest letters (digits and punctuation excluded). */
function letterSize(runs: readonly IRTextRun[]): number {
    return Math.max(...runs.filter((r) => /\p{L}/u.test(r.text)).map((r) => r.size), 0);
}

/**
 * The unbroken run chain around one column's largest letters on a line: a
 * neighbouring panel's labels can share the baseline across a gap.
 */
function bannerChain(runs: readonly IRTextRun[]): IRTextRun[] {
    const size = letterSize(runs);
    const lead = runs.find((r) => /\p{L}/u.test(r.text) && r.size === size);
    if (lead === undefined) {
        return [];
    }
    const sorted = [...runs].sort((a, b) => a.x - b.x);
    const gapAfter = (i: number): number => {
        const a = sorted[i];
        const b = sorted[i + 1];
        return a === undefined || b === undefined ? Number.POSITIVE_INFINITY : b.x - (a.x + a.width);
    };
    let lo = sorted.indexOf(lead);
    let hi = lo;
    while (lo > 0 && gapAfter(lo - 1) <= BANNER_GAP) {
        lo--;
    }
    while (gapAfter(hi) <= BANNER_GAP) {
        hi++;
    }
    return sorted.slice(lo, hi + 1);
}

/**
 * The statblock's name banner: of the bold lines just above the grid, the one
 * set in the largest display size (a statblock above may leave its own bold
 * label lines in range, but in smaller type). Numbers on the banner line are
 * values, not part of the name.
 */
function readBanner(ir: IR, grid: CharGrid): Banner | null {
    const candidates = ir.runs.filter(
        (r) =>
            r.pageIndex === grid.pageIndex &&
            r.weight === "bold" &&
            !r.italic &&
            r.text.trim().length > 0 &&
            r.y > grid.y1 + 25 &&
            r.y < grid.y1 + BANNER_REACH &&
            r.x >= grid.x0 - 200 &&
            r.x <= grid.x1 + 100,
    );
    if (candidates.length === 0) {
        return null;
    }

    // One chain per text column of each line; a chain ending in a colon is a
    // field label ("Fate Points:"), never a name banner.
    const chains = groupByBaseline(candidates, ROW_TOL)
        .flatMap((l) =>
            [...new Set(l.runs.map((r) => r.column))].map((column) => ({
                y: l.y,
                runs: bannerChain(l.runs.filter((r) => r.column === column)),
            })),
        )
        .filter((c) => c.runs.length > 0 && !joinLine(c.runs).endsWith(":"))
        .sort((a, b) => letterSize(b.runs) - letterSize(a.runs) || a.y - b.y);
    const nameRuns = chains[0]?.runs;
    const anchorRun = nameRuns?.find((r) => /\p{L}/u.test(r.text) && r.size === letterSize(nameRuns));
    if (nameRuns === undefined || anchorRun === undefined) {
        return null;
    }
    const { name, number } = splitBannerText(joinLine(nameRuns));
    if (!/\p{L}/u.test(name)) {
        return null;
    }
    const x0 = Math.min(...nameRuns.map((r) => r.x));
    const x1 = Math.max(...nameRuns.map((r) => r.x + r.width));
    return {
        name,
        number: number ?? badgeNumber(ir, grid.pageIndex, anchorRun, x1),
        x0,
        x1,
        y: anchorRun.y,
        column: anchorRun.column,
    };
}

/**
 * A banner line reads "NAME … value …": the name runs up to the first standalone
 * number, which is the headline value; whatever follows it belongs to something
 * else sharing the baseline.
 */
export function splitBannerText(text: string): { name: string; number: number | null } {
    const words = text.replace(/^(\d+\s+)+/u, "").split(/\s+/u);
    const at = words.findIndex((w) => /^\d+$/u.test(w));
    if (at < 0) {
        return { name: words.join(" ").trim(), number: null };
    }
    return { name: words.slice(0, at).join(" ").trim(), number: Number(words[at]) };
}

/** Furthest a value badge sits right of the banner's name. */
const BADGE_REACH = 120;

/**
 * A headline value set as a badge beside the banner rather than on its
 * baseline: the nearest bold numeric run to the right whose line overlaps the
 * banner's letters vertically.
 */
function badgeNumber(ir: IR, pageIndex: number, bannerRun: IRTextRun, bannerRight: number): number | null {
    const badge = ir.runs
        .filter(
            (r) =>
                r.pageIndex === pageIndex &&
                r.weight === "bold" &&
                /^\d+$/u.test(r.text.trim()) &&
                r.x >= bannerRight &&
                r.x - bannerRight <= BADGE_REACH &&
                Math.abs(r.y - bannerRun.y) <= bannerRun.size / 2,
        )
        .sort((a, b) => a.x - b.x)[0];
    return badge === undefined ? null : Number(badge.text.trim());
}

/** Horizontal slack around the banner/grid box when collecting the boxed panel's lines. */
const PANEL_SLACK = 30;
/** Depth below the grid searched for the statblock's labelled lines. */
const PANEL_MAX_DEPTH = 400;
/** Runs within this many points of a panel line's baseline belong to it. */
const PANEL_LINE_TOL = 5;

/** A gap between statblock text lines wider than this many points ends the statblock. */
const SECTION_GAP = 18;

/**
 * Where a statblock's lines may be read: a page, vertical bounds, the runs of
 * its boxed panel (`box`) and of its text section (`text`, its column).
 */
interface PanelRegion {
    pageIndex: number;
    top: number;
    floor: number;
    box: (r: IRTextRun) => boolean;
    text: (r: IRTextRun) => boolean;
}

/**
 * A statblock text-section label line: bold, mixed-case, ending its label in a
 * colon. A weapon profile's qualities line ("Special:") belongs to the panel's
 * weapon boxes, however it is cased.
 */
function isLabelLine(line: BaselineLine, text: string): boolean {
    return (
        /^[^:]*\p{Ll}[^:]*:/u.test(text) &&
        !/^\s*special\s*:/iu.test(text) &&
        line.runs.some((r) => r.weight === "bold")
    );
}

/**
 * How a region is read: from its panel (`panel`), already inside the text
 * section (`text`), or resuming the text section at the region's first label
 * line (`resume`), skipping whatever precedes it.
 */
type PanelMode = "panel" | "text" | "resume";

/**
 * Read a statblock's lines top-down within a region. Once its text section
 * has begun (a bold, mixed-case "Skills:" label — the panel's own capitals
 * labels such as "SPECIAL:" are not it), only its column is read, and a
 * heading of capitals or a gap wider than line spacing ends it; a section that
 * reaches the region's floor instead is `exhausted`.
 */
function readPanel(
    ir: IR,
    region: PanelRegion,
    mode: PanelMode,
): { lines: BaselineLine[]; labelled: boolean; exhausted: boolean } {
    const runs = ir.runs.filter(
        (r) =>
            r.pageIndex === region.pageIndex &&
            r.y < region.top &&
            r.y > region.floor &&
            (region.box(r) || region.text(r)),
    );
    const lines: BaselineLine[] = [];
    let inText = mode === "text";
    for (const whole of groupByBaseline(runs, PANEL_LINE_TOL).sort((a, b) => b.y - a.y)) {
        const line = inText || mode === "resume" ? { ...whole, runs: whole.runs.filter(region.text) } : whole;
        if (line.runs.length === 0) {
            continue;
        }
        const text = joinLine(line.runs);
        if (mode === "resume" && !inText && !isLabelLine(line, text)) {
            continue;
        }
        const prev = lines.at(-1);
        const heading = /^[\p{Lu}\s'’-]{3,}$/u.test(text) && !text.includes(":");
        if (inText && (heading || (prev !== undefined && prev.y - line.y > SECTION_GAP))) {
            return { lines, labelled: true, exhausted: false };
        }
        inText ||= isLabelLine(line, text);
        lines.push(line);
    }
    return { lines, labelled: inText, exhausted: inText };
}

/** A text column on a page, with the height its carried-over text stops at. */
interface CarryRegion {
    pageIndex: number;
    column: number;
    floor: number;
}

/** Regions past its own a statblock's text may carry over into. */
const MAX_CARRY_REGIONS = 2;

/**
 * The statblock's lines below its grid: its column (the boxed panel may be
 * narrower, the text runs the column's width), down to the next statblock's
 * banner (`floor`) or the page's margin band. A statblock ending its column
 * before its text section begins carries on at the top of the next column
 * (`next`: the next column, or the next page's first), down to that column's
 * first banner; one whose text section runs to the column's end resumes at
 * that column's first label line — and so on while the text keeps running
 * to a region's end.
 */
function panelLines(
    ir: IR,
    grid: CharGrid,
    banner: Banner,
    floor: number,
    next: (at: { pageIndex: number; column: number }) => CarryRegion,
    bands: MarginBands,
): BaselineLine[] {
    const heightOf = (pageIndex: number): number =>
        ir.pages.find((p) => p.pageIndex === pageIndex)?.height ?? 0;
    const onPage = (r: IRTextRun): boolean => !inMarginBand(r.y, heightOf(r.pageIndex), bands);
    const left = Math.min(banner.x0, grid.x0) - PANEL_SLACK;
    const right = Math.max(banner.x1, grid.x1) + PANEL_SLACK;
    const own = readPanel(
        ir,
        {
            pageIndex: grid.pageIndex,
            top: grid.y0,
            floor: Math.max(floor, grid.y0 - PANEL_MAX_DEPTH),
            box: (r) => onPage(r) && r.x >= left && r.x + r.width <= right,
            text: (r) => onPage(r) && r.column === banner.column,
        },
        "panel",
    );
    if (floor > 0 || (own.labelled && !own.exhausted)) {
        return own.lines;
    }
    const lines = [...own.lines];
    let labelled = own.labelled;
    let at = { pageIndex: grid.pageIndex, column: banner.column };
    for (let hop = 0; hop < MAX_CARRY_REGIONS; hop++) {
        const region = next(at);
        const inRegion = (r: IRTextRun): boolean => onPage(r) && r.column === region.column;
        const read = readPanel(
            ir,
            {
                pageIndex: region.pageIndex,
                top: heightOf(region.pageIndex),
                floor: region.floor,
                box: inRegion,
                text: inRegion,
            },
            labelled ? "resume" : "panel",
        );
        if (!read.labelled) {
            break;
        }
        lines.push(...read.lines);
        labelled = true;
        // Text still running at a region's end, with no statblock below it,
        // carries on into the region after.
        if (region.floor > 0 || !read.exhausted) {
            break;
        }
        at = region;
    }
    return lines;
}

/** Most words a statblock label spans. */
const LABEL_MAX_WORDS = 4;

/**
 * The index of the run ending a label whose first words slipped out of bold:
 * leading regular runs set solid against a bold run that ends in a colon. -1
 * when the line opens otherwise.
 */
function setOffLabelEnd(runs: readonly IRTextRun[]): number {
    const end = runs.findIndex((r) => r.weight === "bold" && r.text.trimEnd().endsWith(":"));
    if (end <= 0) {
        return -1;
    }
    const label = runs.slice(0, end + 1);
    const solid = label.every((r, i) => {
        const prev = label[i - 1];
        return prev === undefined || r.x - (prev.x + prev.width) <= PANEL_WORD_GAP;
    });
    return solid && joinLine(label).split(" ").length <= LABEL_MAX_WORDS ? end : -1;
}

/**
 * Join a label whose words changed weight: the change is a word boundary,
 * whatever the runs' measured gap.
 */
function joinByWeight(runs: readonly IRTextRun[]): string {
    const groups: IRTextRun[][] = [];
    for (const r of runs) {
        const group = groups.at(-1);
        if (group?.[0]?.weight === r.weight) {
            group.push(r);
        } else {
            groups.push([r]);
        }
    }
    return groups.map(joinLine).join(" ");
}

/**
 * The panel as labelled blocks: a line opening with bold text that ends in a
 * colon starts a block under that label; other lines continue the block above.
 */
export function panelBlocks(lines: readonly BaselineLine[]): DetectedNumericGrid["blocks"] {
    const blocks: DetectedNumericGrid["blocks"] = [];
    for (const line of lines) {
        const runs = [...line.runs].filter((r) => r.text.trim().length > 0).sort((a, b) => a.x - b.x);
        const pageIndex = runs[0]?.pageIndex;
        if (pageIndex === undefined) {
            continue;
        }
        const labelEnd = setOffLabelEnd(runs);
        const lead = labelEnd >= 0 ? labelEnd + 1 : runs.findIndex((r) => r.weight !== "bold");
        const boldRuns = lead < 0 ? runs : runs.slice(0, lead);
        const label = labelEnd >= 0 ? joinByWeight(boldRuns) : joinLine(boldRuns);
        const text = joinLine(lead < 0 ? [] : runs.slice(lead));
        const last = blocks.at(-1);
        if (label.length > 1 && label.endsWith(":")) {
            blocks.push({ label: label.slice(0, -1).trim(), text, pageIndex });
        } else if (last !== undefined) {
            last.text = `${last.text} ${joinLine(runs)}`.trim();
        } else {
            blocks.push({ label: null, text: joinLine(runs), pageIndex });
        }
    }
    return blocks;
}

export function detectNumericGrids(ir: IR): DetectedNumericGrid[] {
    const { gridFont, gridSize } = discoverFontRoles(ir);
    const results: DetectedNumericGrid[] = [];
    const maxPage = Math.max(...ir.pages.map((p) => p.pageIndex), 0);
    const bands = marginBandsOf(ir);

    const foundByPage = new Map<number, { grid: CharGrid; banner: Banner }[]>();
    for (let p = 0; p <= maxPage; p++) {
        foundByPage.set(
            p,
            findGridsOnPage(ir, p, gridFont, gridSize).flatMap((grid) => {
                const banner = readBanner(ir, grid);
                return banner === null ? [] : [{ grid, banner }];
            }),
        );
    }
    // The first statblock down a column bounds text carried over into it.
    const firstBanner = (pageIndex: number, column: number): number =>
        Math.max(
            0,
            ...(foundByPage.get(pageIndex) ?? [])
                .filter((o) => o.banner.column === column)
                .map((o) => o.banner.y),
        );
    const lastColumn = new Map<number, number>();
    for (const r of ir.runs) {
        lastColumn.set(r.pageIndex, Math.max(lastColumn.get(r.pageIndex) ?? 0, r.column));
    }
    // Text carries over to the next column, or from a page's last column to
    // the first column of the next page, down to that column's first banner.
    const nextRegion = (at: { pageIndex: number; column: number }): CarryRegion => {
        const region =
            at.column < (lastColumn.get(at.pageIndex) ?? 0)
                ? { pageIndex: at.pageIndex, column: at.column + 1 }
                : { pageIndex: at.pageIndex + 1, column: 0 };
        return { ...region, floor: firstBanner(region.pageIndex, region.column) };
    };

    for (let p = 0; p <= maxPage; p++) {
        const found = foundByPage.get(p) ?? [];
        for (const { grid, banner } of found) {
            // The next statblock down the same column bounds this one's panel.
            const floor = Math.max(
                0,
                ...found
                    .filter((o) => o.banner.y < grid.y0 && o.banner.column === banner.column)
                    .map((o) => o.banner.y),
            );
            const labels = readLabelsForGrid(ir, grid);
            const values = grid.cells.map((c) => c.value);
            const lines = panelLines(ir, grid, banner, floor, nextRegion, bands);

            results.push({
                pageIndex: p,
                name: banner.name,
                caption: null,
                bannerNumber: banner.number,
                labels,
                values,
                associatedText: lines.map((l) => joinLine(l.runs)).filter((t) => t.length > 0),
                blocks: panelBlocks(lines),
            });
        }
    }
    return results;
}
