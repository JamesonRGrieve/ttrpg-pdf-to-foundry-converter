// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Ort from "onnxruntime-web";
import { alphabetOf, type FloatTensor, PpOcrReader, type TensorSession } from "./reader.ts";

/**
 * The PP-OCR networks run in onnxruntime-web's plain WebAssembly build (no
 * GPU kernels) on one thread. Node and the browser import that build through
 * different entry points (`onnxruntime-web` and `onnxruntime-web/wasm`) that
 * load the same `ort-wasm-simd-threaded.wasm`, so the module is passed in and
 * both read every page alike.
 */

type OrtModule = typeof Ort;

/** An onnxruntime session as a `TensorSession`. */
class OrtTensorSession implements TensorSession {
    readonly #ort: OrtModule;
    readonly #session: Ort.InferenceSession;

    constructor(ort: OrtModule, session: Ort.InferenceSession) {
        this.#ort = ort;
        this.#session = session;
    }

    async run(input: Float32Array, dims: readonly number[]): Promise<FloatTensor> {
        const [inputName] = this.#session.inputNames;
        const [outputName] = this.#session.outputNames;
        if (inputName === undefined || outputName === undefined) {
            throw new Error("PP-OCR model has no input or output");
        }
        const out = await this.#session.run({ [inputName]: new this.#ort.Tensor("float32", input, dims) });
        const tensor = out[outputName];
        if (tensor === undefined || !(tensor.data instanceof Float32Array)) {
            throw new Error("PP-OCR model gave no float output");
        }
        return { data: tensor.data, dims: tensor.dims };
    }

    async close(): Promise<void> {
        await this.#session.release();
    }
}

/** The model files' contents. */
export interface PpOcrModels {
    detector: Uint8Array;
    recognizer: Uint8Array;
    /** The recognizer's key file (its alphabet, one symbol per line). */
    keys: string;
}

/** The PP-OCR reader over `models` in `ort`, and a closer for its sessions. */
export async function createPpOcr(
    ort: OrtModule,
    models: PpOcrModels,
): Promise<{ reader: PpOcrReader; close: () => Promise<void> }> {
    // One thread: a multi-threaded reduction can sum in a different order run to run.
    ort.env.wasm.numThreads = 1;
    const session = async (model: Uint8Array): Promise<OrtTensorSession> =>
        new OrtTensorSession(ort, await ort.InferenceSession.create(model, { executionProviders: ["wasm"] }));
    const detector = await session(models.detector);
    const recognizer = await session(models.recognizer);
    return {
        reader: new PpOcrReader(detector, recognizer, alphabetOf(models.keys)),
        close: async () => {
            await detector.close();
            await recognizer.close();
        },
    };
}
