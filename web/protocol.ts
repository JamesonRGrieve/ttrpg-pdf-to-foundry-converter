// SPDX-License-Identifier: AGPL-3.0-or-later

/** Messages between the page and the engine worker. */

export interface RunRequest {
    type: "run";
    pdf: ArrayBuffer;
}

export interface PackSummary {
    pack: string;
    documents: number;
}

export type WorkerMessage =
    /** Sent once the worker's message listener is attached (its modules use top-level await). */
    | { type: "ready" }
    | { type: "log"; line: string }
    | { type: "progress"; done: number; total: number }
    | {
          type: "result";
          zip: ArrayBuffer;
          packs: PackSummary[];
          documents: number;
          assets: number;
          warnings: number;
      }
    | { type: "refused" }
    | { type: "error"; message: string };
