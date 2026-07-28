// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { byteCompare, chain, numAsc, sortKeysDeep } from "../../src/util/ordered.ts";

describe("byteCompare", () => {
    it("orders by UTF-8 byte value (uppercase before lowercase)", () => {
        expect(byteCompare("Z", "a")).toBeLessThan(0);
        expect(byteCompare("a", "b")).toBeLessThan(0);
        expect(byteCompare("a", "a")).toBe(0);
    });
    it("is locale-independent for accented characters", () => {
        // Multi-byte UTF-8 sorts after ASCII, unlike a locale collation.
        expect(byteCompare("z", "é")).toBeLessThan(0);
    });
    it("sorts an array deterministically", () => {
        expect(["b", "A", "a", "B"].sort(byteCompare)).toEqual(["A", "B", "a", "b"]);
    });
});

describe("chain", () => {
    it("returns the first non-zero comparator result", () => {
        const cmp = chain<{ a: number; b: number }>(
            (x, y) => numAsc(x.a, y.a),
            (x, y) => numAsc(x.b, y.b),
        );
        expect(cmp({ a: 1, b: 2 }, { a: 1, b: 5 })).toBeLessThan(0);
        expect(cmp({ a: 2, b: 0 }, { a: 1, b: 9 })).toBeGreaterThan(0);
        expect(cmp({ a: 1, b: 1 }, { a: 1, b: 1 })).toBe(0);
    });
});

describe("sortKeysDeep", () => {
    it("byte-sorts object keys at every level", () => {
        const input = { b: 1, a: { z: 1, y: 2 }, A: 3 };
        expect(JSON.stringify(sortKeysDeep(input))).toBe('{"A":3,"a":{"y":2,"z":1},"b":1}');
    });
    it("preserves array order and recurses into array elements", () => {
        const input = { list: [{ b: 1, a: 2 }, 3] };
        expect(sortKeysDeep(input)).toEqual({ list: [{ a: 2, b: 1 }, 3] });
    });
    it("leaves scalars untouched", () => {
        expect(sortKeysDeep(5)).toBe(5);
        expect(sortKeysDeep("s")).toBe("s");
        expect(sortKeysDeep(null)).toBe(null);
    });
});
