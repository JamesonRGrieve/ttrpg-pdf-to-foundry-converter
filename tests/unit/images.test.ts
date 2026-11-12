// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zlibSync } from "fflate";
import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.ts";
import { extract } from "../../src/stages/extract.ts";
import { openImageFallback } from "../../src/stages/image-fallback.ts";
import { recoverImages } from "../../src/stages/images.ts";
import type { RawDoc, RawImageXObject } from "../../src/types/ir.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A Flate-encoded image XObject. */
function image(id: string, data: number[], fields: Partial<RawImageXObject>): RawImageXObject {
    return {
        objectId: id,
        width: 2,
        height: 2,
        colorspace: "DeviceRGB",
        filter: "FlateDecode",
        bpc: 8,
        smaskRef: null,
        decodeParms: null,
        bytes: zlibSync(new Uint8Array(data)),
        ...fields,
    };
}

function recover(images: RawImageXObject[]): { assets: string[]; warnings: string[] } {
    const warnings: string[] = [];
    const raw = { images, placements: [] } as unknown as RawDoc;
    const log = createLogger("warn", "", (_level, line) => warnings.push(line));
    const result = recoverImages(raw, log);
    // Each source image's asset, in input order ("" when it was skipped).
    const assets = images.map(
        (img) => result.assets.find((a) => a.sourceObjectIds.includes(img.objectId))?.assetId ?? "",
    );
    return { assets, warnings };
}

/** Four pixels: red, green, blue, white. */
const RGB = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
/** The same four colours as a palette, and the pixels as indices into it. */
const PALETTE = { components: 3, lookup: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) };

/** A one-page PDF whose image XObjects are the given streams, each painted on the page. */
async function pdfWithImages(
    images: { dict: Record<string, unknown>; data: Uint8Array }[],
): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const names: string[] = [];
    images.forEach(({ dict, data }, i) => {
        const ref = doc.context.register(
            doc.context.stream(data, { Type: "XObject", Subtype: "Image", ...dict }),
        );
        const name = `Im${i}`;
        page.node.newXObject(name, ref);
        names.push(name);
    });
    const ops = names.map((n, i) => `q 50 0 0 50 ${10 + i * 60} 10 cm /${n} Do Q`).join("\n");
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(ops)));
    return doc.save({ useObjectStreams: false });
}

describe("recovering images through the fallback decoder", () => {
    it("decodes a chained-filter JPEG and a separation-colour image the in-house decoder refuses", async () => {
        const jpeg = new Uint8Array(readFileSync(resolve(repoRoot, "fixtures/src/assets/test.jpg")));
        const pdf = await pdfWithImages([
            {
                dict: {
                    Width: 4,
                    Height: 4,
                    BitsPerComponent: 8,
                    ColorSpace: "DeviceRGB",
                    Filter: [PDFName.of("FlateDecode"), PDFName.of("DCTDecode")],
                },
                data: zlibSync(jpeg),
            },
            {
                dict: {
                    Width: 2,
                    Height: 2,
                    BitsPerComponent: 8,
                    // A spot ink whose tint maps onto gray (a type 2 function: tint 0 is white, 1 black).
                    ColorSpace: [
                        PDFName.of("Separation"),
                        PDFName.of("Lamp"),
                        PDFName.of("DeviceGray"),
                        { FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 },
                    ],
                },
                data: new Uint8Array([0, 85, 170, 255]),
            },
        ]);
        const raw = await extract(pdf);
        expect(raw.images.map((i) => [i.filter, i.colorspace])).toEqual([
            ["FlateDecode+DCTDecode", "DeviceRGB"],
            ["", "Separation"],
        ]);
        const warnings: string[] = [];
        const log = createLogger("warn", "", (_level, line) => warnings.push(line));
        // Without the fallback both are skipped, each saying why.
        expect(recoverImages(raw, log).assets).toEqual([]);
        expect(warnings).toHaveLength(2);
        const fallback = openImageFallback(pdf);
        try {
            const assets = recoverImages(raw, createLogger("error"), fallback.decode).assets;
            expect(assets.map((a) => [a.ext, a.width, a.height])).toEqual(
                expect.arrayContaining([
                    ["png", 4, 4],
                    ["png", 2, 2],
                ]),
            );
        } finally {
            fallback.close();
        }
    });
});

describe("recovering images in other colour spaces", () => {
    it("expands a palette image through its lookup table, at 8 or fewer bits per index", () => {
        const { assets, warnings } = recover([
            image("1 0 R", RGB, {}),
            image("2 0 R", [0, 1, 2, 3], { colorspace: "Indexed", components: 1, palette: PALETTE }),
            // Two bits per index, each row padded to a byte: 0,1 then 2,3.
            image("3 0 R", [0b00010000, 0b10110000], {
                colorspace: "Indexed",
                components: 1,
                palette: PALETTE,
                bpc: 2,
            }),
        ]);
        expect(warnings).toEqual([]);
        // Assets are content-addressed: the palette images decode to the same picture as the RGB one.
        expect(assets[1]).toBe(assets[0]);
        expect(assets[2]).toBe(assets[0]);
    });

    it("takes an ICC-based image's component count from its profile", () => {
        const gray = [0, 85, 170, 255];
        const { assets, warnings } = recover([
            image("1 0 R", gray, { colorspace: "DeviceGray" }),
            image("2 0 R", gray, { colorspace: "ICCBased", components: 1 }),
        ]);
        expect(warnings).toEqual([]);
        expect(assets[1]).toBe(assets[0]);
    });

    it("scales a sub-byte gray image to 8 bits", () => {
        const { assets } = recover([
            image("1 0 R", [0, 255, 255, 0], { colorspace: "DeviceGray" }),
            // One bit per pixel: 0,1 then 1,0.
            image("2 0 R", [0b01000000, 0b10000000], { colorspace: "DeviceGray", bpc: 1 }),
        ]);
        expect(assets[1]).toBe(assets[0]);
    });

    it("refuses a colour space it cannot convert, saying so", () => {
        const { assets, warnings } = recover([image("1 0 R", [0, 0, 0, 0], { colorspace: "Separation" })]);
        expect(assets).toEqual([""]);
        expect(warnings).toEqual(["warn: image 1 0 R: unsupported colour space Separation; skipped"]);
    });
});
