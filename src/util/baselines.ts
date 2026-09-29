// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IRTextRun } from "../types/ir.ts";

/** Runs sharing one printed baseline; `y` is the baseline of the line's first run. */
export interface BaselineLine<T extends { y: number } = IRTextRun> {
    y: number;
    runs: T[];
}

/**
 * Group runs into lines: each run joins the first line whose baseline lies
 * within `tolerance` points of its own (strictly, unless `inclusive`), in
 * input order.
 */
export function groupByBaseline<T extends { y: number }>(
    runs: readonly T[],
    tolerance: number,
    inclusive = false,
): BaselineLine<T>[] {
    const near = (d: number): boolean => (inclusive ? d <= tolerance : d < tolerance);
    const lines: BaselineLine<T>[] = [];
    for (const r of runs) {
        const line = lines.find((l) => near(Math.abs(l.y - r.y)));
        if (line === undefined) {
            lines.push({ y: r.y, runs: [r] });
        } else {
            line.runs.push(r);
        }
    }
    return lines;
}
