// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
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

    it("starts a worker only for a page waiting for one", () => {
        const ports: HeldPort[] = [];
        const pool = new PpOcrPool(() => {
            const port = new HeldPort();
            ports.push(port);
            return port;
        }, 16);
        void pool.read(page(0));
        void pool.read(page(1));
        expect(ports).toHaveLength(2);
    });

    it("reads a dead worker's page on another worker, and does not replace the dead one", async () => {
        const ports: HeldPort[] = [];
        const pool = new PpOcrPool(() => {
            const port = new HeldPort();
            ports.push(port);
            return port;
        }, 2);
        const first = pool.read(page(0));
        const second = pool.read(page(1));
        ports[0]?.die();
        // The pool shrank to one worker, so the page waits for the survivor.
        expect(ports).toHaveLength(2);
        ports[1]?.answer();
        expect(ports[1]?.held.map((r) => r.page.pageIndex)).toEqual([0]);
        ports[1]?.answer();
        expect((await first)[0]?.text).toBe("p0");
        expect((await second)[0]?.text).toBe("p1");
    });

    it("fails the run once a page has outlived three workers", async () => {
        const ports: HeldPort[] = [];
        const pool = new PpOcrPool(() => {
            const port = new HeldPort();
            ports.push(port);
            return port;
        }, 1);
        const held = pool.read(page(4));
        ports[0]?.die();
        ports[1]?.die();
        ports[2]?.die();
        await expect(held).rejects.toThrow(/PP-OCR worker died: gone \(page 5, 3 workers\)/u);
        await expect(pool.read(page(2))).rejects.toThrow("PP-OCR worker died");
    });
});

describe("answerRead", () => {
    it("reads a page again on another worker when its worker goes silent, as one the browser ended does", async () => {
        vi.useFakeTimers();
        try {
            const ports: HeldPort[] = [];
            const pool = new PpOcrPool(
                () => {
                    const port = new HeldPort();
                    ports.push(port);
                    return port;
                },
                1,
                1000,
            );
            const answered = pool.read(page(0));
            ports[0]?.answer();
            expect(await answered).toEqual([word("p0")]);
            // Answered in time: its watchdog is cleared and never fires.
            vi.advanceTimersByTime(5000);
            const silent = pool.read(page(1));
            vi.advanceTimersByTime(1000);
            expect(ports).toHaveLength(2);
            ports[1]?.answer();
            expect(await silent).toEqual([word("p1")]);
        } finally {
            vi.useRealTimers();
        }
    });

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
