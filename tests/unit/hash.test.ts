// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { base62Encode, id16, sha256Hex } from "../../src/util/hash.ts";

describe("sha256Hex", () => {
    it("matches the known SHA-256 of an empty string", () => {
        expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
    it("is stable and content-dependent", () => {
        expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
        expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
    });
});

describe("base62Encode", () => {
    it("preserves leading zero bytes as leading '0' characters", () => {
        expect(base62Encode(new Uint8Array([0, 0, 1]))).toBe("001");
        expect(base62Encode(new Uint8Array([0]))).toBe("0");
    });
    it("encodes into the 0-9A-Za-z alphabet only", () => {
        const encoded = base62Encode(new Uint8Array([255, 254, 253, 1, 42]));
        expect(encoded).toMatch(/^[0-9A-Za-z]+$/);
    });
    it("is injective for distinct inputs", () => {
        expect(base62Encode(new Uint8Array([1, 2, 3]))).not.toBe(base62Encode(new Uint8Array([1, 2, 4])));
    });
});

describe("id16", () => {
    it("returns a 16-char id in the Foundry _id charset", () => {
        expect(id16("anything")).toMatch(/^[a-zA-Z0-9]{16}$/);
    });
    it("is deterministic for the same preimage and differs for different ones", () => {
        expect(id16("hello")).toBe(id16("hello"));
        expect(id16("hello")).not.toBe(id16("hell0"));
    });
    it("accepts bytes and strings equivalently", () => {
        expect(id16(new TextEncoder().encode("x"))).toBe(id16("x"));
    });
});
