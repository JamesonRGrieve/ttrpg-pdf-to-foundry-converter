// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    inferBookSlug,
    inferBookTitle,
    metadataTitle,
    MAX_BOOK_SLUG,
    MAX_BOOK_TITLE,
    noticeTitle,
} from "../../src/infer/book.ts";
import { sourceBookLabel } from "../../src/infer/schema.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";

const run = (text: string, pageIndex: number, x: number, y: number, size: number): IRTextRun => ({
    pageIndex,
    band: 0,
    x,
    y,
    width: 6 * text.length,
    height: size,
    text,
    font: "f",
    weight: "normal",
    italic: false,
    size,
    sizeBucket: 0,
    column: 0,
    indent: 0,
    renderOrder: 0,
});

const ir = (title: string | null, runs: IRTextRun[]): IR => ({
    irVersion: 0,
    pages: [],
    runs,
    sizeBuckets: [],
    fonts: [],
    meta: { title, author: null, producer: null, creator: null, creationDate: null },
    fingerprint: {
        pageSizes: [],
        orientation: "portrait",
        columns: 1,
        fonts: [],
        sizeBuckets: [],
        marginBox: { left: 0, right: 0, top: 0, bottom: 0 },
    },
});

describe("inferBookSlug", () => {
    it("names the book from its metadata title", () => {
        expect(inferBookSlug(ir("The Lantern Codex", []))).toBe("the-lantern-codex");
    });

    it("falls back to the topmost line of the first page's largest text, left to right", () => {
        const runs = [
            run("Codex", 1, 200, 700, 24),
            run("Lantern", 1, 100, 700, 24),
            // Lines lower down that recognition read at the same size are not the title.
            run("Every wayfarer carries a lamp", 1, 100, 600, 24),
            run("small print", 1, 100, 500, 10),
            run("Later Page", 2, 100, 750, 30),
            // The book prints its title's words in its text.
            run("The Lantern Codex lists every lamp.", 2, 100, 700, 10),
        ];
        expect(inferBookSlug(ir(null, runs))).toBe("lantern-codex");
    });

    it("takes no cover line whose words the book never prints, as cover art read as text gives", () => {
        const runs = [
            run("ANTERN CODE", 0, 100, 700, 40),
            run("The Lantern Codex lists every lamp.", 1, 100, 700, 10),
        ];
        expect(inferBookSlug(ir(null, runs))).toBe("untitled");
        expect(
            inferBookSlug(ir(null, [run("OF", 0, 100, 700, 40), run("A tale of lamps.", 1, 100, 700, 10)])),
        ).toBe("untitled");
        // A lone cover word, however common in the book, is no title.
        expect(
            inferBookSlug(ir(null, [run("LAMP", 0, 100, 700, 40), run("A lamp lights.", 1, 100, 700, 10)])),
        ).toBe("untitled");
    });

    it("takes no notice title whose words the book prints nowhere else, as a logo's on its line", () => {
        const runs = [
            run("PRESS USA © Wick Press 2014.", 1, 100, 100, 7),
            run("The Lantern Codex lists every lamp, as the wick press makes them.", 2, 100, 700, 10),
        ];
        expect(inferBookSlug(ir(null, runs))).toBe("untitled");
    });

    it("prefers the title a copyright notice names over an application's default name for metadata", () => {
        const runs = [
            run("ANTERN", 0, 100, 700, 40),
            run("Credits", 1, 100, 750, 18),
            run(
                "Lamp Lore: The Lantern Codex © Copyright Wick Press 2015. All rights reserved.",
                1,
                100,
                100,
                7,
            ),
            run("The Lantern Codex lists every lamp.", 2, 100, 700, 10),
        ];
        expect(inferBookSlug(ir("Untitled-4", runs))).toBe("the-lantern-codex");
        expect(inferBookSlug(ir("Lantern Final.indb", runs))).toBe("lantern-final");
    });

    it("cuts a long title back to whole words within the bound", () => {
        const slug = inferBookSlug(ir(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "), []));
        expect(slug.length).toBeLessThanOrEqual(MAX_BOOK_SLUG);
        expect(slug.endsWith("-")).toBe(false);
        expect(slug.split("-").every((w) => /^word\d+$/u.test(w))).toBe(true);
    });

    it("is untitled with no title and no text", () => {
        expect(inferBookSlug(ir(null, []))).toBe("untitled");
    });
});

describe("title sources", () => {
    it("reads a metadata title, a file name by its stem, an application's default name as none", () => {
        expect(metadataTitle("Untitled-4")).toBeNull();
        expect(metadataTitle("Lantern Layout.indb")).toBe("Lantern Layout");
        expect(metadataTitle("The Lantern Codex")).toBe("The Lantern Codex");
        expect(metadataTitle("Vol. 2")).toBe("Vol. 2");
    });

    it("reads the title a copyright notice opens with, and nothing else before the sign", () => {
        expect(
            noticeTitle(
                "Wick Press 12 Lamp Road USA\nLamp Lore: The Lantern Codex © Copyright Wick Press 2015.",
            ),
        ).toBe("The Lantern Codex");
        expect(noticeTitle("Copyright © Wick Press 2012. The Lantern Codex and all marks.")).toBeNull();
        expect(noticeTitle("© Wick Press 2014. Lamp Lore, the foregoing marks.")).toBeNull();
        expect(noticeTitle("printed under licence by the wick guild © 2010")).toBeNull();
    });
});

describe("inferBookTitle", () => {
    it("keeps the title as the PDF gives it, whitespace collapsed, for source records", () => {
        expect(inferBookTitle(ir("  The  Lantern\nCodex ", []))).toBe("The Lantern Codex");
        expect(
            inferBookTitle(
                ir(null, [
                    run("Codex", 1, 200, 700, 24),
                    run("Lantern", 1, 100, 700, 24),
                    run("The Lantern Codex lists every lamp.", 2, 100, 700, 10),
                ]),
            ),
        ).toBe("Lantern Codex");
        expect(inferBookTitle(ir(null, []))).toBe("Untitled");
        const long = inferBookTitle(ir(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "), []));
        expect(long.length).toBeLessThanOrEqual(MAX_BOOK_TITLE);
        expect(long.endsWith(" ")).toBe(false);
    });

    it("cites the book in a source record as the line's label and its title", () => {
        expect(sourceBookLabel("dh2", "The Lantern Codex")).toBe("DH2: The Lantern Codex");
        expect(sourceBookLabel("dh1", "The Lantern Codex")).toBe("DH: The Lantern Codex");
        expect(sourceBookLabel("rt", "Wick")).toBe("RT: Wick");
    });
});
