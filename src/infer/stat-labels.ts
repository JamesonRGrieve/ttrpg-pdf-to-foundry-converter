// SPDX-License-Identifier: AGPL-3.0-or-later
import { SCHEMA_CHAR_ORDER } from "./detect-grids.ts";

/**
 * The schema's characteristic abbreviations, as printed above a statblock row:
 * the nine of every line, and `inf` (the schema's influence/infamy
 * characteristic), which some lines' rows print as a tenth.
 */
const CHARACTERISTIC_LABELS: ReadonlySet<string> = new Set([...SCHEMA_CHAR_ORDER, "inf"]);
/** Fewest characteristic labels a row carries. */
const MIN_ROW_LABELS = 7;

/** A line's tokens, lower-cased. */
export const tokensOf = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/\s+/u)
        .filter((t) => t.length > 0);

/** The labels in the schema's order, the influence label last. */
const LABEL_ORDER: readonly string[] = [...SCHEMA_CHAR_ORDER, "inf"];
/** Fewest labels of a full row that must stand in their own place for the row's misread ones to be put right. */
const MIN_PLACED_LABELS = 7;

/**
 * The labels of a statblock's row of characteristic labels, or null when the
 * line is none. A full row read from the page image may give a label short
 * ("Fe", "W"): where it opens on the first two and at least seven stand in
 * the schema's order, each is the schema's label for its place.
 */
export function rowLabels(text: string): string[] | null {
    const tokens = tokensOf(text);
    if (
        tokens.length >= MIN_ROW_LABELS &&
        tokens.every((t) => CHARACTERISTIC_LABELS.has(t)) &&
        tokens.includes("ws") &&
        tokens.includes("bs")
    ) {
        return tokens;
    }
    const full = tokens.length === SCHEMA_CHAR_ORDER.length || tokens.length === LABEL_ORDER.length;
    const placed = tokens.filter((t, i) => t === LABEL_ORDER[i]).length;
    return full && tokens[0] === LABEL_ORDER[0] && tokens[1] === LABEL_ORDER[1] && placed >= MIN_PLACED_LABELS
        ? LABEL_ORDER.slice(0, tokens.length)
        : null;
}

/** Whether a line is a statblock's row of characteristic labels. */
export function isLabelRow(text: string): boolean {
    return rowLabels(text) !== null;
}
