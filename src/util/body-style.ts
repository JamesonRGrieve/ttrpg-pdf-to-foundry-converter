// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";
import { byteCompare } from "./ordered.ts";

/** A run's type style: font, size and weight. */
export const styleOf = (r: IRTextRun): string => `${r.font}|${r.size}|${r.weight}`;

/** The (font|size|weight) style carrying the most characters of normal-weight text. */
export function bodyStyle(ir: IR): { style: string; size: number } {
    const chars = new Map<string, number>();
    for (const r of ir.runs) {
        if (r.weight === "normal" && !r.italic) {
            chars.set(styleOf(r), (chars.get(styleOf(r)) ?? 0) + r.text.length);
        }
    }
    let best = "";
    let bestChars = -1;
    for (const [style, count] of [...chars.entries()].sort((a, b) => byteCompare(a[0], b[0]))) {
        if (count > bestChars) {
            best = style;
            bestChars = count;
        }
    }
    return { style: best, size: Number(best.split("|")[1] ?? "0") };
}
