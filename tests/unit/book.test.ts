// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { inferBookSlug, MAX_BOOK_SLUG } from "../../src/infer/book.ts";
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
        ];
        expect(inferBookSlug(ir(null, runs))).toBe("lantern-codex");
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
