// SPDX-License-Identifier: AGPL-3.0-or-later
import { OCR_FONT_NAME } from "../ocr/scan-lines.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { bodyStyle } from "../util/body-style.ts";
import { inMarginBand, inSideMargin, marginBandsOf } from "../util/page-bands.ts";
import { buildLines, endsSentence, type TextLine } from "./detect-entries.ts";
import { panelBlocks, SCHEMA_CHAR_ORDER } from "./detect-grids.ts";
import { isLabelRow, rowLabels, tokensOf } from "./stat-labels.ts";
import type { DetectedNumericGrid } from "./types.ts";

/**
 * Statblocks printed as a row: a line of characteristic labels (the schema's
 * own abbreviations), the values on the line beneath, a caption line above
 * naming the creature, and bold `Label:` field lines after. They are read into
 * the same shape as a characteristic grid, so one NPC builder serves both.
 */

/**
 * A line leading in to what follows, not a name: it closes on a colon. (A
 * caption set in small capitals may arrive in lower case, so its case tells
 * nothing.)
 */
const RUNNING_TEXT = /:$/u;
/** Most lines of notes set between a row's labels and its values. */
const MAX_NOTE_LINES = 2;
/** A page number standing alone on its line. */
const FOLIO = /^\d{1,4}$/u;
/** How many label sizes below the labels the values line may sit, and the caption above. */
const ROW_REACH_FACTOR = 3;
/** A line set this far above body size is a heading, which ends a statblock's fields. */
const HEADING_STEP = 0.4;
/** Most text regions (columns or pages) a statblock's fields run on past its own. */
const MAX_CARRY_REGIONS = 2;
/** Share of captions ending in one word for that word to be the captions' shared label. */
const CAPTION_WORD_SHARE = 0.5;
/** Fewest statblocks for a shared caption word to be recognized. */
const MIN_CAPTIONS = 3;

export { isLabelRow };

/** A line set at most this share of the labels' size is a superscript note over the values. */
const SUPERSCRIPT_SHARE = 0.7;

/** A line holding only bracketed numbers: notes set over a statblock's values. */
const NOTES_ONLY = /^\s*(?:\(\d+\)\s*)+$/u;

/** A line holding only values: figures, the letters a figure may be read as, and dashes. */
const VALUES_ONLY = /^\s*(?:(?:[\dIlOo]{1,3}|[-–—]{1,2})\s*)+$/u;

/** A dash (or a pair set as one, "--") printed where a creature has no such characteristic. */
const ABSENT = /^[-–—]{1,2}$/u;

/** A value of up to three figures read with a letter for a figure it resembles: "IO", "4I". */
const LOOKALIKE_VALUE = /^[\dIlOo]{1,3}$/u;

/**
 * A row of values read from the page image may give a figure as the letter
 * it resembles. Where most of the row's tokens are numbers, a token made
 * only of figures and such letters is the number they spell.
 */
export function asDigits(tokens: readonly string[]): string[] {
    const numbers = tokens.filter((t) => /^\d+$/u.test(t)).length;
    if (numbers * 2 < tokens.length) {
        return [...tokens];
    }
    return tokens.map((t) => (LOOKALIKE_VALUE.test(t) ? t.replace(/[Il]/gu, "1").replace(/[Oo]/gu, "0") : t));
}

/**
 * The row's values, one per label, or null when the line does not hold
 * exactly that many. A dash (no such characteristic) is the schema's 0; a
 * signed value is a modifier row, not a statblock.
 */
export function rowValues(text: string, count: number): number[] | null {
    const tokens = asDigits(text.split(/\s+/u).filter((t) => t.length > 0));
    if (tokens.length !== count || !tokens.every((t) => /^\d+/u.test(t) || ABSENT.test(t))) {
        return null;
    }
    return tokens.map((t) => (ABSENT.test(t) ? 0 : Number(/^\d+/u.exec(t)?.[0])));
}

/** A cell's value once its letter spacing is closed up: digits, or dashes for none. */
const CELL_VALUE = /^(?:\d+|[-–—]+)$/u;

interface Placed {
    x: number;
    width: number;
    text: string;
}

/**
 * The row's values read by position: each value run belongs to the label it
 * sits nearest under, so a value set letter-spaced ("0 5", "- -") stays one
 * value. Null when the labels are not one run each, a run holds several
 * values, or a label is left without a value.
 */
export function cellValues(labels: readonly Placed[], values: readonly Placed[]): number[] | null {
    const heads = labels.filter((r) => r.text.trim().length > 0);
    const cells = heads.map(() => "");
    const centre = (r: Placed): number => r.x + r.width / 2;
    for (const v of values) {
        const pieces = v.text.split(/\s+/u).filter((p) => p.length > 0);
        if (pieces.length === 0) {
            continue;
        }
        if (pieces.length > 1 && pieces.some((p) => p.length > 1)) {
            return null;
        }
        let nearest = 0;
        heads.forEach((h, i) => {
            const best = heads[nearest];
            if (best !== undefined && Math.abs(centre(h) - centre(v)) < Math.abs(centre(best) - centre(v))) {
                nearest = i;
            }
        });
        cells[nearest] = `${cells[nearest] ?? ""}${pieces.join("")}`;
    }
    const read = asDigits(cells);
    if (read.some((c) => !CELL_VALUE.test(c))) {
        return null;
    }
    return read.map((c) => (/^\d/u.test(c) ? Number(c) : 0));
}

/** The labels in the schema's order, the influence label last. */
const LABEL_ORDER: readonly string[] = [...SCHEMA_CHAR_ORDER, "inf"];
/** A gap between two labels at least this many times their usual spacing leaves room for one the text layer dropped. */
const MISSING_LABEL_GAP = 1.6;

/**
 * A row of labels with the one a text layer dropped put back: when the row
 * reads in the schema's order with exactly one label missing between two it
 * keeps, and those two stand about twice the row's usual spacing apart, the
 * missing label is placed midway between them. Otherwise the row unchanged.
 */
export function withMissingLabel(labels: readonly Placed[]): Placed[] {
    const heads = labels.filter((r) => r.text.trim().length > 0);
    const tokens = heads.map((r) => r.text.trim().toLowerCase());
    const order = tokens.map((t) => LABEL_ORDER.indexOf(t));
    if (order.some((o, i) => o < 0 || (i > 0 && o <= (order[i - 1] ?? 0)))) {
        return [...labels];
    }
    const skips = order.flatMap((o, i) => (i > 0 && o - (order[i - 1] ?? 0) === 2 ? [i] : []));
    const jumps = order.filter((o, i) => i > 0 && o - (order[i - 1] ?? 0) > 1).length;
    const [at] = skips;
    if (at === undefined || skips.length !== 1 || jumps !== 1) {
        return [...labels];
    }
    const centre = (r: Placed): number => r.x + r.width / 2;
    const steps = heads.slice(1).map((h, i) => centre(h) - centre(heads[i] ?? h));
    const usual = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
    const before = heads[at - 1];
    const after = heads[at];
    if (
        before === undefined ||
        after === undefined ||
        centre(after) - centre(before) < MISSING_LABEL_GAP * usual
    ) {
        return [...labels];
    }
    const width = (before.width + after.width) / 2;
    const missing = {
        x: (centre(before) + centre(after)) / 2 - width / 2,
        width,
        text: LABEL_ORDER[(order[at] ?? 0) - 1] ?? "",
    };
    return [...heads.slice(0, at), missing, ...heads.slice(at)];
}

/** How far past the last label, in the row's usual spacing, a value may sit to stand under a label set after it. */
const TRAILING_REACH: readonly [number, number] = [0.6, 1.4];

/**
 * A row of labels whose last label the text layer dropped past its end (the
 * values run one column further: "… WP Fel" over ten values): when the row
 * reads in the schema's order and a value sits about one usual spacing past
 * the last label, the label next in the order is placed there. Otherwise the
 * row unchanged.
 */
export function withTrailingLabel(labels: readonly Placed[], values: readonly Placed[]): Placed[] {
    const heads = labels.filter((r) => r.text.trim().length > 0);
    const order = heads.map((r) => LABEL_ORDER.indexOf(r.text.trim().toLowerCase()));
    const last = heads.at(-1);
    const next = LABEL_ORDER[(order.at(-1) ?? LABEL_ORDER.length) + 1];
    if (
        last === undefined ||
        next === undefined ||
        order.some((o, i) => o < 0 || (i > 0 && o <= (order[i - 1] ?? 0)))
    ) {
        return [...labels];
    }
    const centre = (r: Placed): number => r.x + r.width / 2;
    const steps = heads.slice(1).map((h, i) => centre(h) - centre(heads[i] ?? h));
    const usual = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
    const [near, far] = TRAILING_REACH;
    const past = values.some((v) => {
        const beyond = centre(v) - centre(last);
        return v.text.trim().length > 0 && beyond >= near * usual && beyond <= far * usual;
    });
    return usual > 0 && past
        ? [...heads, { x: centre(last) + usual - last.width / 2, width: last.width, text: next }]
        : [...labels];
}

/** A trailing bracketed note on a caption ("(Elite)"), perhaps set against the word before it. */
const TRAILING_NOTE = /\s*(\([^()]*\))\s*$/u;

/** The word most of `words` are, with its count. */
function mostCommon(words: readonly string[]): [string, number] {
    const counts = new Map<string, number>();
    for (const w of words) {
        counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ["", 0];
}

/**
 * Names from captions: when most captions end in the same word (a label every
 * statblock carries, discovered from the document), that word is dropped
 * wherever it stands in a caption. A trailing bracketed note that varies
 * between captions (a tier: "(Elite)", "(Troop)") is not that word, and
 * stays; the shared word is looked for before it.
 */
export function captionNames(captions: readonly string[], share = CAPTION_WORD_SHARE): string[] {
    const spaced = captions.map((c) => c.trim().replace(TRAILING_NOTE, " $1"));
    const lastWord = (c: string): string => c.trim().split(/\s+/u).at(-1)?.toLowerCase() ?? "";
    const enough = captions.length >= MIN_CAPTIONS;
    const common = (count: number): boolean => enough && count >= share * captions.length;
    // A trailing note is a shared label only when no caption carries another
    // (tiers vary: "(Elite)", "(Master)").
    const notes = new Set(spaced.flatMap((c) => TRAILING_NOTE.exec(c)?.[1]?.toLowerCase() ?? []));
    let [shared, count] = notes.size > 1 ? ["", 0] : mostCommon(spaced.map(lastWord));
    if (!common(count)) {
        [shared, count] = mostCommon(spaced.map((c) => lastWord(c.replace(TRAILING_NOTE, ""))));
    }
    return captions.map((c, i) => {
        const words = (spaced[i] ?? c).split(/\s+/u);
        const kept = words.filter((w) => w.toLowerCase() !== shared);
        return common(count) && kept.length > 0 ? kept.join(" ") : c.trim();
    });
}

/** Type sizes of gap within which a side-margin run carries on a line of the text block. */
const MARGIN_CARRY_FACTOR = 1.5;
/** Type sizes apart two runs' baselines may be and share a line. */
const BASELINE_SHARE = 0.3;

/**
 * The runs of the text block: a run set wholly in a side margin (a thumb-index
 * tab) is left out, unless it carries on a line of the text block at no more
 * than a cell's spacing — a statblock row's last column set past the margin's
 * edge ("Fel" and its value) — or carries on such a run in turn.
 */
export function textBlockRuns(runs: readonly IRTextRun[], pageWidth: (page: number) => number): IRTextRun[] {
    const inMargin = (r: IRTextRun): boolean => inSideMargin(r.x, r.x + r.width, pageWidth(r.pageIndex));
    const kept = runs.filter((r) => !inMargin(r));
    const centre = (r: IRTextRun): number => Math.abs(r.x + r.width / 2 - pageWidth(r.pageIndex) / 2);
    // Nearest the text block first, so a run carries on one kept before it.
    const margin = runs
        .filter(inMargin)
        .sort((a, b) => centre(a) - centre(b) || a.renderOrder - b.renderOrder);
    for (const m of margin) {
        const reach = MARGIN_CARRY_FACTOR * m.size;
        const carries = kept.some((o) => {
            if (o.pageIndex !== m.pageIndex || Math.abs(o.y - m.y) > BASELINE_SHARE * m.size) {
                return false;
            }
            const gap = o.x < m.x ? m.x - (o.x + o.width) : o.x - (m.x + m.width);
            return gap >= -reach && gap <= reach && o.text.trim().length > 0;
        });
        if (carries && m.text.trim().length > 0) {
            kept.push(m);
        }
    }
    const order = new Map(runs.map((r, i) => [r, i] as const));
    return kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** A gap after a row of labels at least this many label sizes wide parts the panel from text set beside it. */
const BESIDE_GAP_FACTOR = 1.5;
/** Points within which lines beside a panel start at one place. */
const BESIDE_EDGE_TOLERANCE = 2;
/** Fewest lines starting at one place beside a row of labels and its values for a block to stand there. */
const MIN_BESIDE_LINES = 2;

/**
 * Runs with the text set beside a statblock's panel in a column of its own.
 * Where lines of other text start at one place a wide gap right of a row of
 * labels, level with it and its values, the page sets a block beside the
 * panel that the page's columns do not part (its lines may even share a
 * baseline with the panel's). Every run right of that gap, down and up the page as far as
 * the nearest line crossing it, is given a column of its own, between the
 * panel's and the next.
 */
export function besidePanels(runs: readonly IRTextRun[], lines: readonly TextLine[]): IRTextRun[] {
    const moved = new Set<IRTextRun>();
    for (const line of lines) {
        const printed = line.runs.filter((r) => r.text.trim().length > 0);
        const size = Math.max(...printed.map((r) => r.size));
        // The row of labels: the line's longest opening that is one.
        const at = printed.findLastIndex((_, i) =>
            isLabelRow(
                printed
                    .slice(0, i + 1)
                    .map((p) => p.text.trim())
                    .join(" "),
            ),
        );
        const edge = printed[at];
        if (edge === undefined) {
            continue;
        }
        const column = runs.filter(
            (r) => r.pageIndex === line.pageIndex && r.column === line.column && r.text.trim().length > 0,
        );
        // Text beside the panel: lines starting at one place, a wide gap
        // right of the labels, level with them and with the values beneath.
        const clear = edge.x + edge.width + BESIDE_GAP_FACTOR * size;
        const beside = column.filter(
            (r) => r.x >= clear && r.y <= line.y + size && r.y >= line.y - ROW_REACH_FACTOR * size,
        );
        const left = Math.min(...beside.map((r) => r.x));
        if (beside.filter((r) => r.x - left <= BESIDE_EDGE_TOLERANCE).length < MIN_BESIDE_LINES) {
            continue;
        }
        const cut = (edge.x + edge.width + left) / 2;
        const crossing = column.filter((r) => r.x < cut && r.x + r.width > cut).map((r) => r.y);
        const top = Math.min(...crossing.filter((y) => y > line.y), Number.POSITIVE_INFINITY);
        const bottom = Math.max(...crossing.filter((y) => y < line.y), Number.NEGATIVE_INFINITY);
        for (const r of column) {
            if (r.x >= cut && r.y < top && r.y > bottom) {
                moved.add(r);
            }
        }
    }
    return runs.map((r) => (moved.has(r) ? { ...r, column: r.column + 0.5 } : r));
}

export function detectStatRows(ir: IR): DetectedNumericGrid[] {
    const bands = marginBandsOf(ir);
    const pages = new Map(ir.pages.map((p) => [p.pageIndex, p] as const));
    // Thumb-index tabs in a side margin share baselines with statblock lines;
    // they are dropped run by run, running heads and feet line by line.
    const inText = textBlockRuns(ir.runs, (page) => pages.get(page)?.width ?? 0);
    // A caption opening a column may stand as high as the running head: the
    // line directly over a row of labels is no page furniture.
    const built = buildLines({ ...ir, runs: besidePanels(inText, buildLines({ ...ir, runs: inText })) });
    const lines = built.filter((l, i) => {
        const next = built[i + 1];
        const captions =
            next !== undefined &&
            next.pageIndex === l.pageIndex &&
            next.column === l.column &&
            isLabelRow(next.text) &&
            !inMarginBand(next.y, pages.get(next.pageIndex)?.height ?? 0, bands);
        return captions || !inMarginBand(l.y, pages.get(l.pageIndex)?.height ?? 0, bands);
    });
    const bodySize = bodyStyle(ir).size;
    const sizeOf = (l: TextLine): number => Math.max(...l.runs.map((r) => r.size));
    const sameColumn = (a: TextLine, b: TextLine): boolean =>
        a.pageIndex === b.pageIndex && a.column === b.column;
    // On a page with a text layer, a line read only from the page image is
    // lettering the layer lacks (a mark in the art beside the panel); its
    // size is an estimate and it heads nothing.
    const recoveredMark = (l: TextLine): boolean =>
        pages.get(l.pageIndex)?.hasTextLayer === true &&
        l.runs.every((r) => r.font === OCR_FONT_NAME || r.text.trim().length === 0);

    const found: { labels: number; values: number; caption: number; row: string[]; numbers: number[] }[] = [];
    lines.forEach((line, i) => {
        if (!isLabelRow(line.text)) {
            return;
        }
        const reach = ROW_REACH_FACTOR * sizeOf(line);
        // Lines of notes over some values (printed unnatural characteristics,
        // bracketed or set as small superscripts — a page read from its
        // image may give the two a line each) may sit between the labels and
        // the values.
        const isNote = (l: TextLine | undefined): boolean =>
            l !== undefined && (NOTES_ONLY.test(l.text) || sizeOf(l) < SUPERSCRIPT_SHARE * sizeOf(line));
        let valuesAt = i + 1;
        while (valuesAt - i <= MAX_NOTE_LINES && isNote(lines[valuesAt])) {
            valuesAt += 1;
        }
        const below = lines[valuesAt];
        const above = lines[i - 1];
        if (
            below === undefined ||
            above === undefined ||
            !sameColumn(line, below) ||
            !sameColumn(line, above) ||
            line.y - below.y > reach ||
            above.y - line.y > reach
        ) {
            return;
        }
        const oneRunEach =
            line.runs.filter((r) => r.text.trim().length > 0).length === tokensOf(line.text).length;
        // A label the text layer dropped is put back where the row leaves room for it.
        const labels = oneRunEach ? withTrailingLabel(withMissingLabel(line.runs), below.runs) : null;
        const printed =
            labels === null
                ? tokensOf(line.text)
                : labels.filter((l) => l.text.trim().length > 0).map((l) => l.text.trim().toLowerCase());
        // A label read short is the schema's for its place in the row.
        const placed = rowLabels(line.text);
        const row = placed !== null && placed.length === printed.length ? placed : printed;
        const valuesOf = (runs: readonly IRTextRun[], text: string): number[] | null =>
            (labels === null ? null : cellValues(labels, runs)) ?? rowValues(text, row.length);
        let numbers = valuesOf(below.runs, below.text);
        // A row read from the page image may come as two lines, some values
        // set a little off the others' baseline: the two together, in their
        // order across the page, are the row.
        const second = lines[valuesAt + 1];
        if (
            numbers === null &&
            second !== undefined &&
            sameColumn(line, second) &&
            line.y - second.y <= reach &&
            VALUES_ONLY.test(below.text) &&
            VALUES_ONLY.test(second.text)
        ) {
            const runs = [...below.runs, ...second.runs].sort((a, b) => a.x - b.x);
            numbers = valuesOf(
                runs,
                runs
                    .map((r) => r.text.trim())
                    .filter((t) => t.length > 0)
                    .join(" "),
            );
            if (numbers !== null) {
                valuesAt += 1;
            }
        }
        // A caption names the creature; a sentence above a worked example
        // does not, nor does the tail of one leading in to it ("… now look
        // like this:").
        if (numbers !== null && !endsSentence(above.text) && !RUNNING_TEXT.test(above.text.trim())) {
            found.push({ labels: i, values: valuesAt, caption: i - 1, row, numbers });
        }
    });

    // A caption several statblocks share ("Main Profile") labels them all and
    // names none; each is named by the line just above it.
    const captionCounts = new Map<string, number>();
    for (const f of found) {
        const text = lines[f.caption]?.text ?? "";
        captionCounts.set(text, (captionCounts.get(text) ?? 0) + 1);
    }
    const naming = found.map((f) => {
        const caption = lines[f.caption];
        const above = lines[f.caption - 1];
        const shared = caption !== undefined && (captionCounts.get(caption.text) ?? 0) > 1;
        return shared &&
            above !== undefined &&
            sameColumn(above, caption) &&
            above.y - caption.y <= ROW_REACH_FACTOR * sizeOf(caption) &&
            !endsSentence(above.text)
            ? f.caption - 1
            : f.caption;
    });
    const names = captionNames(naming.map((i) => lines[i]?.text ?? ""));
    const captions = new Set(found.map((f) => f.caption));
    // A folio the margin bands did not take in: a bare number set below, or
    // above, every other line of its page.
    const extremes = new Map<number, { low: number; high: number }>();
    for (const l of lines) {
        const e = extremes.get(l.pageIndex);
        extremes.set(l.pageIndex, {
            low: Math.min(e?.low ?? l.y, l.y),
            high: Math.max(e?.high ?? l.y, l.y),
        });
    }
    const folios = new Set(
        lines.filter((l) => {
            const e = extremes.get(l.pageIndex);
            return FOLIO.test(l.text.trim()) && e !== undefined && (l.y === e.low || l.y === e.high);
        }),
    );
    return found.map((f, k) => {
        const start = lines[f.values];
        const panel: TextLine[] = [];
        let regions = 0;
        let previous = start;
        for (let j = f.values + 1; j < lines.length; j++) {
            const line = lines[j];
            if (
                line === undefined ||
                previous === undefined ||
                captions.has(j) ||
                (sizeOf(line) > bodySize + HEADING_STEP && !recoveredMark(line))
            ) {
                break;
            }
            // A page's folio between a panel's lines is no part of it.
            if (folios.has(line)) {
                continue;
            }
            if (!sameColumn(line, previous)) {
                regions += 1;
                if (regions > MAX_CARRY_REGIONS) {
                    break;
                }
            }
            panel.push(line);
            previous = line;
        }
        return {
            pageIndex: start?.pageIndex ?? 0,
            name: names[k] ?? "",
            caption: lines[naming[k] ?? f.caption]?.text ?? null,
            bannerNumber: null,
            labels: f.row,
            values: f.numbers,
            associatedText: panel.map((l) => l.text),
            blocks: panelBlocks(panel),
        };
    });
}
