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
