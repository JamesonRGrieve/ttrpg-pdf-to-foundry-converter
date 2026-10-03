// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OcrWord, RenderedPage } from "../types.ts";
import { PPOCR_READER_ID, type PageReader } from "./reader.ts";

/**
 * The PP-OCR reader spread over workers (threads in Node, Web Workers in the
 * browser), one page at a time each. Every worker runs the same
 * single-threaded reader and a page's words depend on that page alone, so the
 * pool reads exactly as one reader would — only sooner. Runtime-neutral: each
 * runtime supplies its workers as `ReaderPort`s.
 */

export interface ReadRequest {
    id: number;
    page: RenderedPage;
}

export type ReadResponse = { id: number; words: OcrWord[] } | { id: number; error: string };

/** One worker as the pool drives it. */
export interface ReaderPort {
    post(request: ReadRequest): void;
    onResponse(handler: (response: ReadResponse) => void): void;
    onFailure(handler: (err: Error) => void): void;
    terminate(): Promise<void>;
}

interface Pending {
    resolve: (words: OcrWord[]) => void;
    reject: (err: Error) => void;
}

export class PpOcrPool implements PageReader {
    readonly id = PPOCR_READER_ID;
    readonly #spawn: () => ReaderPort;
    readonly #size: number;
    /** The workers, spawned on the first read: a run with no page to read starts none. */
    readonly #ports: ReaderPort[] = [];
    readonly #idle: ReaderPort[] = [];
    readonly #queue: { request: ReadRequest; pending: Pending }[] = [];
    readonly #pending = new Map<number, Pending>();
    #nextId = 0;
    /** Why the pool stopped (a worker died): every read after fails with it. */
    #broken: Error | null = null;

    /** A pool of `size` workers, each started by `spawn`. */
    constructor(spawn: () => ReaderPort, size: number) {
        this.#spawn = spawn;
        this.#size = Math.max(1, size);
    }

    read(page: RenderedPage): Promise<OcrWord[]> {
        return new Promise((resolve, reject) => {
            if (this.#broken !== null) {
                reject(this.#broken);
                return;
            }
            this.#start();
            this.#nextId += 1;
            this.#queue.push({ request: { id: this.#nextId, page }, pending: { resolve, reject } });
            this.#dispatch();
        });
    }

    async close(): Promise<void> {
        await Promise.all(this.#ports.map((p) => p.terminate()));
    }

    #start(): void {
        while (this.#ports.length < this.#size) {
            const port = this.#spawn();
            port.onResponse((response) => this.#settle(port, response));
            port.onFailure((err) => this.#fail(err));
            this.#ports.push(port);
            this.#idle.push(port);
        }
    }

    #dispatch(): void {
        while (this.#idle.length > 0 && this.#queue.length > 0) {
            const port = this.#idle.pop();
            const job = this.#queue.shift();
            if (port === undefined || job === undefined) {
                return;
            }
            this.#pending.set(job.request.id, job.pending);
            port.post(job.request);
        }
    }

    #settle(port: ReaderPort, response: ReadResponse): void {
        const pending = this.#pending.get(response.id);
        this.#pending.delete(response.id);
        this.#idle.push(port);
        if (pending !== undefined) {
            if ("error" in response) {
                pending.reject(new Error(`PP-OCR worker: ${response.error}`));
            } else {
                pending.resolve(response.words);
            }
        }
        this.#dispatch();
    }

    /** A worker that died fails the run: every page held or waiting is rejected. */
    #fail(err: Error): void {
        this.#broken = new Error(`PP-OCR worker died: ${err.message}`);
        for (const pending of this.#pending.values()) {
            pending.reject(this.#broken);
        }
        this.#pending.clear();
        for (const job of this.#queue.splice(0)) {
            job.pending.reject(this.#broken);
        }
    }
}

/** A worker's side: answer each request with the page's words as `reader` reads them. */
export async function answerRead(reader: PageReader, request: ReadRequest): Promise<ReadResponse> {
    try {
        return { id: request.id, words: await reader.read(request.page) };
    } catch (err) {
        return { id: request.id, error: err instanceof Error ? err.message : String(err) };
    }
}
