// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Locale-free ordering primitives (spec §5.5, §9.3). Every sort in the
 * pipeline uses explicit byte collation over UTF-8; we never call
 * `localeCompare` or rely on the ambient locale, and we never depend on sort
 * stability — comparators are made total by appending a tiebreak key.
 */

const UTF8 = new TextEncoder();

/** Compare two strings by their UTF-8 byte sequence. Deterministic, locale-free. */
export function byteCompare(a: string, b: string): number {
    const x = UTF8.encode(a);
    const y = UTF8.encode(b);
    for (const [i, xb] of x.entries()) {
        const yb = y[i];
        if (yb === undefined) {
            break;
        }
        if (xb !== yb) {
            return xb < yb ? -1 : 1;
        }
    }
    return numAsc(x.length, y.length);
}

export type Comparator<T> = (a: T, b: T) => number;

/** Numeric ascending comparator (returns exact -1/0/1 from a subtraction sign). */
export function numAsc(a: number, b: number): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Compose comparators left-to-right; the first non-zero result wins. */
export function chain<T>(...comparators: readonly Comparator<T>[]): Comparator<T> {
    return (a, b): number => {
        for (const cmp of comparators) {
            const r = cmp(a, b);
            if (r !== 0) {
                return r;
            }
        }
        return 0;
    };
}

/**
 * Recursively rebuild a JSON-compatible value with every object's keys in
 * ascending byte-collation order. Arrays keep their (already-deterministic)
 * order. This is the canonical key-ordering used by the emit serializer and by
 * the `_id` canonicalization hash so output never varies by insertion order.
 */
export function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort(byteCompare);
        const out: Record<string, unknown> = {};
        for (const key of keys) {
            out[key] = sortKeysDeep(record[key]);
        }
        return out;
    }
    return value;
}
