// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The element at `index`, which the caller's own bounds guarantee exists.
 * Throws if that invariant is broken instead of letting `undefined` flow on.
 */
export function at<T>(items: ArrayLike<T>, index: number): T {
    const item = items[index];
    if (item === undefined) {
        throw new RangeError(`index ${index} outside 0..${items.length - 1}`);
    }
    return item;
}
