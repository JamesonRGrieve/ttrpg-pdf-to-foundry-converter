// SPDX-License-Identifier: AGPL-3.0-or-later

/** The value at fraction `p` (0–1) of an ascending list; 0 for an empty list. */
export function percentile(sorted: readonly number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}
