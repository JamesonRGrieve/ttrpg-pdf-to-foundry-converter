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

interface Job {
    request: ReadRequest;
    pending: Pending;
    /** Workers that have died holding this page. */
    deaths: number;
}

/**
 * Longest a worker may take over one page before it is taken for dead. A
 * browser may end a worker (for memory) without any error event reaching the
 * page; without a limit, the run would wait on that page for ever.
 */
export const PAGE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Workers a page may outlive before it fails the run. A worker that dies (most
 * often ended by the browser for memory) is not replaced: the pool shrinks by
 * one, so fewer readers hold memory, and its page goes to another worker.
 */
export const MAX_PAGE_DEATHS = 3;

export class PpOcrPool implements PageReader {
    readonly id = PPOCR_READER_ID;
    readonly #spawn: () => ReaderPort;
    /** Workers allowed at once; shrinks by one with each worker that dies. */
    #size: number;
    /** The live workers, spawned only as pages wait for them. */
    readonly #ports: ReaderPort[] = [];
    readonly #idle: ReaderPort[] = [];
    readonly #queue: Job[] = [];
    /** The page each busy worker holds. */
    readonly #busy = new Map<ReaderPort, Job>();
    /** Each busy worker's watchdog, cleared when it answers. */
    readonly #timers = new Map<ReaderPort, ReturnType<typeof setTimeout>>();
    readonly #timeoutMs: number;
    #nextId = 0;
    /** Why the pool stopped (a page outlived too many workers): every read after fails with it. */
    #broken: Error | null = null;

    /** A pool of up to `size` workers, each started by `spawn`; a page unanswered after `timeoutMs` counts its worker dead. */
    constructor(spawn: () => ReaderPort, size: number, timeoutMs: number = PAGE_TIMEOUT_MS) {
        this.#spawn = spawn;
        this.#size = Math.max(1, size);
        this.#timeoutMs = timeoutMs;
    }

    read(page: RenderedPage): Promise<OcrWord[]> {
        return new Promise((resolve, reject) => {
            if (this.#broken !== null) {
                reject(this.#broken);
                return;
            }
            this.#nextId += 1;
            this.#queue.push({
                request: { id: this.#nextId, page },
                pending: { resolve, reject },
                deaths: 0,
            });
            this.#dispatch();
        });
    }

    async close(): Promise<void> {
        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }
        this.#timers.clear();
        await Promise.all(this.#ports.map((p) => p.terminate()));
    }

    /** A worker for each waiting page, up to the pool's size. */
    #grow(): void {
        while (this.#ports.length < this.#size && this.#idle.length < this.#queue.length) {
            const port = this.#spawn();
            port.onResponse((response) => this.#settle(port, response));
            port.onFailure((err) => this.#died(port, err));
            this.#ports.push(port);
            this.#idle.push(port);
        }
    }

    #dispatch(): void {
        this.#grow();
        while (this.#idle.length > 0 && this.#queue.length > 0) {
            const port = this.#idle.pop();
            const job = this.#queue.shift();
            if (port === undefined || job === undefined) {
                return;
            }
            this.#busy.set(port, job);
            this.#timers.set(
                port,
                setTimeout(
                    () =>
                        this.#died(
                            port,
                            new Error(
                                `no answer for a page in ${Math.round(this.#timeoutMs / 1000)} s (most often the browser ending the worker for memory)`,
                            ),
                        ),
                    this.#timeoutMs,
                ),
            );
            port.post(job.request);
        }
    }

    #settle(port: ReaderPort, response: ReadResponse): void {
        const job = this.#busy.get(port);
        if (job === undefined || job.request.id !== response.id) {
            return;
        }
        this.#busy.delete(port);
        clearTimeout(this.#timers.get(port));
        this.#timers.delete(port);
        this.#idle.push(port);
        if ("error" in response) {
            job.pending.reject(new Error(`PP-OCR worker: ${response.error}`));
        } else {
            job.pending.resolve(response.words);
        }
        this.#dispatch();
    }

    /**
     * A worker that died or went silent: it is ended and not replaced (the
     * pool shrinks by one), and the page it held goes back to the queue for
     * another worker. A page that outlives too many workers fails the run.
     */
    #died(port: ReaderPort, err: Error): void {
        if (!this.#ports.includes(port)) {
            return;
        }
        clearTimeout(this.#timers.get(port));
        this.#timers.delete(port);
        this.#ports.splice(this.#ports.indexOf(port), 1);
        const idle = this.#idle.indexOf(port);
        if (idle >= 0) {
            this.#idle.splice(idle, 1);
        }
        void port.terminate().catch(() => undefined);
        this.#size = Math.max(1, this.#size - 1);
        const job = this.#busy.get(port);
        this.#busy.delete(port);
        if (job !== undefined) {
            job.deaths += 1;
            if (job.deaths >= MAX_PAGE_DEATHS) {
                this.#fail(
                    new Error(
                        `PP-OCR worker died: ${err.message} (page ${job.request.page.pageIndex + 1}, ${job.deaths} workers)`,
                    ),
                    job,
                );
                return;
            }
            this.#queue.unshift(job);
        }
        this.#dispatch();
    }

    /** The run stops: the page that failed, every page held or waiting, and every later read fail with `err`. */
    #fail(err: Error, failed: Job): void {
        if (this.#broken !== null) {
            return;
        }
        this.#broken = err;
        failed.pending.reject(err);
        for (const [port, job] of this.#busy) {
            clearTimeout(this.#timers.get(port));
            job.pending.reject(err);
        }
        this.#busy.clear();
        this.#timers.clear();
        for (const job of this.#queue.splice(0)) {
            job.pending.reject(err);
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
