// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    answerRead,
    PpOcrPool,
    type ReaderPort,
    type ReadRequest,
    type ReadResponse,
} from "../../src/ocr/ppocr/pool.ts";
import type { OcrWord, RenderedPage } from "../../src/ocr/types.ts";

const page = (pageIndex: number): RenderedPage => ({
    pageIndex,
    png: new Uint8Array(),
    image: { pixels: new Uint8Array(), width: 0, height: 0, stride: 0 },
    widthPx: 0,
    heightPx: 0,
    scale: 1,
    viewBox: [0, 0, 1, 1],
});

const word = (text: string): OcrWord => ({
    text,
    confidence: 99,
    box: [0, 0, 1, 1],
    line: 0,
    baseline: 0,
    lineHeight: 1,
    stroke: 1,
});

/** A port whose requests wait until the test answers them. */
class HeldPort implements ReaderPort {
    readonly held: ReadRequest[] = [];
    #respond: (response: ReadResponse) => void = () => undefined;
    #fail: (err: Error) => void = () => undefined;
    post(request: ReadRequest): void {
        this.held.push(request);
    }
    onResponse(handler: (response: ReadResponse) => void): void {
        this.#respond = handler;
    }
    onFailure(handler: (err: Error) => void): void {
        this.#fail = handler;
    }
    async terminate(): Promise<void> {}
    answer(): void {
        const request = this.held.shift();
        if (request !== undefined) {
            this.#respond({ id: request.id, words: [word(`p${request.page.pageIndex}`)] });
        }
    }
    die(): void {
        this.#fail(new Error("gone"));
    }
}

describe("PpOcrPool", () => {
    it("starts its workers on the first read, gives each one page at a time, resolves each page with its words", async () => {
        const ports: HeldPort[] = [];
        const pool = new PpOcrPool(() => {
            const port = new HeldPort();
            ports.push(port);
            return port;
        }, 2);
        expect(ports).toHaveLength(0);
        const reads = [0, 1, 2].map((p) => pool.read(page(p)));
        expect(ports.map((p) => p.held.length)).toEqual([1, 1]);
        ports[1]?.answer();
        // The freed worker takes the waiting page.
        expect(ports[1]?.held.map((r) => r.page.pageIndex)).toEqual([2]);
        ports[0]?.answer();
        ports[1]?.answer();
        const words = await Promise.all(reads);
        expect(words.map((w) => w[0]?.text).sort()).toEqual(["p0", "p1", "p2"]);
    });

    it("fails every held and waiting page, and every later read, once a worker dies", async () => {
        const port = new HeldPort();
        const pool = new PpOcrPool(() => port, 1);
        const held = pool.read(page(0));
        const waiting = pool.read(page(1));
        port.die();
        await expect(held).rejects.toThrow("PP-OCR worker died: gone");
        await expect(waiting).rejects.toThrow("PP-OCR worker died: gone");
        await expect(pool.read(page(2))).rejects.toThrow("PP-OCR worker died");
    });
});

describe("answerRead", () => {
    it("answers with the reader's words, or with its error", async () => {
        const reader = {
            id: "r",
            read: async (p: RenderedPage) => {
                if (p.pageIndex === 1) {
                    throw new Error("unreadable");
                }
                return [word("ok")];
            },
        };
        expect(await answerRead(reader, { id: 7, page: page(0) })).toEqual({ id: 7, words: [word("ok")] });
        expect(await answerRead(reader, { id: 8, page: page(1) })).toEqual({ id: 8, error: "unreadable" });
    });
});
