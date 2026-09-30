// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";
import { bodyStyle } from "../util/body-style.ts";
import { inMarginBand, inSideMargin, marginBandsOf } from "../util/page-bands.ts";
import { buildLines, endsSentence, type TextLine } from "./detect-entries.ts";
import { panelBlocks, SCHEMA_CHAR_ORDER } from "./detect-grids.ts";
import type { DetectedNumericGrid } from "./types.ts";

/**
 * Statblocks printed as a row: a line of characteristic labels (the schema's
 * own abbreviations), the values on the line beneath, a caption line above
 * naming the creature, and bold `Label:` field lines after. They are read into
 * the same shape as a characteristic grid, so one NPC builder serves both.
 */

/**
 * The schema's characteristic abbreviations, as printed above a statblock row:
 * the nine of every line, and `inf` (the schema's influence/infamy
 * characteristic), which some lines' rows print as a tenth.
 */
const CHARACTERISTIC_LABELS: ReadonlySet<string> = new Set([...SCHEMA_CHAR_ORDER, "inf"]);
/** Fewest characteristic labels a row carries. */
const MIN_ROW_LABELS = 7;
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

const tokensOf = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/\s+/u)
        .filter((t) => t.length > 0);

/** Whether a line is a statblock's row of characteristic labels. */
export function isLabelRow(text: string): boolean {
    const tokens = tokensOf(text);
    return (
        tokens.length >= MIN_ROW_LABELS &&
        tokens.every((t) => CHARACTERISTIC_LABELS.has(t)) &&
        tokens.includes("ws") &&
        tokens.includes("bs")
    );
}

/** A line holding only bracketed numbers: notes set over a statblock's values. */
const NOTES_ONLY = /^\s*(?:\(\d+\)\s*)+$/u;

/** A lone dash printed where a creature has no such characteristic. */
const ABSENT = /^[-–—]$/u;

/**
 * The row's values, one per label, or null when the line does not hold
 * exactly that many. A dash (no such characteristic) is the schema's 0; a
 * signed value is a modifier row, not a statblock.
 */
export function rowValues(text: string, count: number): number[] | null {
    const tokens = text.split(/\s+/u).filter((t) => t.length > 0);
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
    if (cells.some((c) => !CELL_VALUE.test(c))) {
        return null;
    }
    return cells.map((c) => (/^\d/u.test(c) ? Number(c) : 0));
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
    let [shared, count] = mostCommon(spaced.map(lastWord));
    if (!common(count)) {
        [shared, count] = mostCommon(spaced.map((c) => lastWord(c.replace(TRAILING_NOTE, ""))));
    }
    return captions.map((c, i) => {
        const words = (spaced[i] ?? c).split(/\s+/u);
        const kept = words.filter((w) => w.toLowerCase() !== shared);
        return common(count) && kept.length > 0 ? kept.join(" ") : c.trim();
    });
}

export function detectStatRows(ir: IR): DetectedNumericGrid[] {
    const bands = marginBandsOf(ir);
    const pages = new Map(ir.pages.map((p) => [p.pageIndex, p] as const));
    // Thumb-index tabs in a side margin share baselines with statblock lines;
    // they are dropped run by run, running heads and feet line by line.
    const inText = ir.runs.filter(
        (r) => !inSideMargin(r.x, r.x + r.width, pages.get(r.pageIndex)?.width ?? 0),
    );
    const lines = buildLines({ ...ir, runs: inText }).filter(
        (l) => !inMarginBand(l.y, pages.get(l.pageIndex)?.height ?? 0, bands),
    );
    const bodySize = bodyStyle(ir).size;
    const sizeOf = (l: TextLine): number => Math.max(...l.runs.map((r) => r.size));
    const sameColumn = (a: TextLine, b: TextLine): boolean =>
        a.pageIndex === b.pageIndex && a.column === b.column;

    const found: { labels: number; values: number; caption: number; row: string[]; numbers: number[] }[] = [];
    lines.forEach((line, i) => {
        if (!isLabelRow(line.text)) {
            return;
        }
        const reach = ROW_REACH_FACTOR * sizeOf(line);
        // A line of bracketed notes over some values (printed unnatural
        // characteristics) may sit between the labels and the values.
        const next = lines[i + 1];
        const valuesAt = next !== undefined && NOTES_ONLY.test(next.text) ? i + 2 : i + 1;
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
        const row = tokensOf(line.text);
        const oneRunEach = line.runs.filter((r) => r.text.trim().length > 0).length === row.length;
        const numbers =
            (oneRunEach ? cellValues(line.runs, below.runs) : null) ?? rowValues(below.text, row.length);
        // A caption names the creature; a sentence above a worked example does not.
        if (numbers !== null && !endsSentence(above.text)) {
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
                sizeOf(line) > bodySize + HEADING_STEP
            ) {
                break;
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
