// SPDX-License-Identifier: AGPL-3.0-or-later
import { unzlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { at } from "../../src/util/at.ts";
import { crc32, encodePngRgba } from "../../src/util/png.ts";

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const out: { type: string; data: Uint8Array }[] = [];
    let offset = 8;
    while (offset < png.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
        const data = png.subarray(offset + 8, offset + 8 + length);
        expect(view.getUint32(offset + 8 + length)).toBe(
            crc32(png.subarray(offset + 4, offset + 8 + length)),
        );
        out.push({ type, data });
        offset += 12 + length;
    }
    return out;
}

describe("crc32", () => {
    it("matches the standard check value", () => {
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });
});

describe("encodePngRgba", () => {
    const pixels = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 40);

    it("writes the signature and only IHDR, IDAT and IEND", () => {
        const png = encodePngRgba(pixels, 2, 2);
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(chunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    });

    it("records width, height, 8-bit RGBA, and filter-0 rows that round-trip the pixels", () => {
        const png = encodePngRgba(pixels, 2, 2);
        const ihdr = at(chunks(png), 0);
        const idat = at(chunks(png), 1);
        const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset);
        expect(header.getUint32(0)).toBe(2);
        expect(header.getUint32(4)).toBe(2);
        expect([ihdr.data[8], ihdr.data[9]]).toEqual([8, 6]);
        const raw = unzlibSync(idat.data);
        expect([...raw]).toEqual([0, ...pixels.subarray(0, 8), 0, ...pixels.subarray(8, 16)]);
    });

    it("is byte-deterministic", () => {
        expect(encodePngRgba(pixels, 2, 2)).toEqual(encodePngRgba(pixels, 2, 2));
    });

    it("rejects a buffer of the wrong size", () => {
        expect(() => encodePngRgba(pixels, 3, 2)).toThrow();
    });
});
