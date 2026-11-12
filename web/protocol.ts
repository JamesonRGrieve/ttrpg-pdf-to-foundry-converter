// SPDX-License-Identifier: AGPL-3.0-or-later

/** Messages between the page and the engine worker. */

/** One PDF and the output schema (line id) the user chose for it. */
export interface RunDocument {
    pdf: ArrayBuffer;
    target: string;
}

export interface RunRequest {
    type: "run";
    /** The PDFs to convert into one module, each with its chosen line. */
    documents: RunDocument[];
    /**
     * The URL the page is served under (its directory), which the OCR models
     * and engines are vendored beneath. The page sends it because the worker's
     * own URL sits in a build directory, and the site may be served under a
     * path (a project site), not at the origin's root.
     */
    siteBase: string;
    /** OCR workers to run side by side (the user's core choice, fitted to their memory budget). */
    ocrWorkers: number;
    /** Pages rendered ahead of recognition at once. */
    maxInFlight: number;
    /** Write the engine's debug lines to the log as well (every table, entry, statblock, entity and warning). */
    debug: boolean;
    /** How the module comes back: zipped (the upload page), or as its files (the Foundry package). */
    output?: "zip" | "files";
}

/** One file of the converted module, relative to the modules directory (`<id>/…`). */
export interface ModuleFileMessage {
    relPath: string;
    contents: string | Uint8Array;
}

export interface PackSummary {
    pack: string;
    documents: number;
}

export type WorkerMessage =
    /** Sent once the worker's message listener is attached (its modules use top-level await). */
    | { type: "ready" }
    | { type: "log"; line: string }
    /** Pages recognized of document `document` (zero-based) of `documents`. */
    | { type: "progress"; document: number; documents: number; page: number; pages: number }
    | {
          type: "result";
          /** The module folder, zipped. */
          zip: ArrayBuffer;
          moduleId: string;
          packs: PackSummary[];
          documents: number;
          assets: number;
          warnings: number;
          /** Indexes of input PDFs refused as encrypted. */
          refused: number[];
      }
    /** The module as its files (`output: "files"`). */
    | {
          type: "files";
          moduleId: string;
          files: ModuleFileMessage[];
          warnings: number;
          refused: number[];
      }
    /** Every input was refused as encrypted. */
    | { type: "refused"; refused: number[] }
    | { type: "error"; message: string };
