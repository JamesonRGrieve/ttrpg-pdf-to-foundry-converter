// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject } from "../types/entity.ts";
import { id16 } from "../util/hash.ts";
import { type Line, sourceRecord, toHtml } from "./schema.ts";

/**
 * A captioned table whose first column is a run of die results ("01–15",
 * "3", "96–00") and whose second column is what each result means is a roll
 * table: it becomes a Foundry RollTable whose results cover those ranges.
 * The structure is read from the column's notation alone.
 */

/** Columns of a roll table: its die results and their outcome. */
const ROLL_TABLE_COLUMNS = 2;
/** "00" on a percentile die reads as 100. */
const PERCENTILE_ZERO = 100;
/** Faces of the standard dice a table is rolled on. */
const STANDARD_DICE: readonly number[] = [2, 3, 4, 5, 6, 8, 10, 12, 20, 100];

/** A printed die result: its range, and whether it runs on to the die's top face ("75+"). */
export interface PrintedRoll {
    lo: number;
    hi: number;
    open: boolean;
}

/** A printed die result or range ("1", "01–15", "96-00", "75+"), or null when the cell is not one. */
export function parseRollRange(cell: string): PrintedRoll | null {
    const m = /^\s*(\d{1,3})\s*(?:[-–—]\s*(\d{1,3})|(\+))?\s*$/u.exec(cell);
    if (m === null) {
        return null;
    }
    const read = (digits: string): number => (/^0+$/u.test(digits) ? PERCENTILE_ZERO : Number(digits));
    const lo = read(m[1] ?? "");
    const hi = m[2] === undefined ? lo : read(m[2]);
    return lo <= hi ? { lo, hi, open: m[3] !== undefined } : null;
}

/** The smallest standard die with at least `faces` faces. */
export function dieFor(faces: number): number | null {
    return STANDARD_DICE.find((d) => d >= faces) ?? null;
}

export interface RollResult {
    range: [number, number];
    text: string;
}

/**
 * A table's rows as roll results, or null when they are not a roll table:
 * every row opens with a die result, the first on the die's first face, each
 * reaching no lower than the one before (a book may print overlapping bands),
 * and each has an outcome. A last result printed open ("75+") runs to the
 * die's top face. Returns the die too.
 */
export function rollResults(
    rows: readonly (readonly string[])[],
): { die: number; results: RollResult[] } | null {
    if (rows.length === 0 || rows.some((r) => r.length !== ROLL_TABLE_COLUMNS)) {
        return null;
    }
    const rolls = rows.map(([roll = ""]) => parseRollRange(roll));
    let reach = 0;
    for (const roll of rolls) {
        if (roll === null || roll.hi < reach) {
            return null;
        }
        reach = roll.hi;
    }
    const printed = rolls.filter((r): r is PrintedRoll => r !== null);
    const die = dieFor(reach);
    if (die === null || printed[0]?.lo !== 1 || printed.some((r, i) => r.open && i !== printed.length - 1)) {
        return null;
    }
    const results: RollResult[] = [];
    for (const [i, [, outcome = ""]] of rows.entries()) {
        const roll = printed[i];
        if (roll === undefined || outcome.trim().length === 0) {
            return null;
        }
        results.push({ range: [roll.lo, roll.open ? die : roll.hi], text: outcome.trim() });
    }
    return { die, results };
}

export interface RollTableInput {
    name: string;
    line: Line;
    book: string;
    page: string;
    die: number;
    results: readonly RollResult[];
}

/** A RollTable document in the system's authoring shape. */
export function buildRollTable(input: RollTableInput): JsonObject {
    return {
        name: input.name,
        formula: `1d${input.die}`,
        replacement: true,
        displayRoll: true,
        description: "",
        gameSystems: [input.line],
        system: { source: sourceRecord(input.line, input.book, input.page) },
        results: input.results.map((r, i) => ({
            _id: id16(`${input.name}\u0000${i}`),
            type: "text",
            text: toHtml(r.text),
            weight: r.range[1] - r.range[0] + 1,
            range: [r.range[0], r.range[1]],
            drawn: false,
        })),
    };
}
