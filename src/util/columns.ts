// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The column `x` falls in: the index of the last left edge at or before it
 * (edges ascending), allowing `tolerance` points of slack to the left.
 */
export function columnAt(x: number, edges: readonly number[], tolerance: number): number {
    let col = 0;
    edges.forEach((edge, i) => {
        if (x >= edge - tolerance) {
            col = i;
        }
    });
    return col;
}
