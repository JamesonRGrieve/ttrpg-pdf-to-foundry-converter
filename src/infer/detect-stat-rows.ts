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

/** The schema's characteristic abbreviations, as printed above a statblock row. */
const CHARACTERISTIC_LABELS: ReadonlySet<string> = new Set(SCHEMA_CHAR_ORDER);
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

/**
 * Names from captions: when most captions end in the same word (a label every
 * statblock carries, discovered from the document), that word is dropped
 * wherever it stands in a caption.
 */
export function captionNames(captions: readonly string[]): string[] {
    const last = captions.map((c) => c.trim().split(/\s+/u).at(-1)?.toLowerCase() ?? "");
    const counts = new Map<string, number>();
    for (const w of last) {
        counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const [shared, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ["", 0];
    const strip = captions.length >= MIN_CAPTIONS && count >= CAPTION_WORD_SHARE * captions.length;
    return captions.map((c) => {
        const words = c.trim().split(/\s+/u);
        const kept = words.filter((w) => w.toLowerCase() !== shared);
        return strip && kept.length > 0 ? kept.join(" ") : c.trim();
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
        const numbers = rowValues(below.text, row.length);
        // A caption names the creature; a sentence above a worked example does not.
        if (numbers !== null && !endsSentence(above.text)) {
            found.push({ labels: i, values: valuesAt, caption: i - 1, row, numbers });
        }
    });

    const names = captionNames(found.map((f) => lines[f.caption]?.text ?? ""));
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
            caption: lines[f.caption]?.text ?? null,
            bannerNumber: null,
            labels: f.row,
            values: f.numbers,
            associatedText: panel.map((l) => l.text),
            blocks: panelBlocks(panel),
        };
    });
}
