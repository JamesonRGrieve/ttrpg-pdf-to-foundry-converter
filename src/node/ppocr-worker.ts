// SPDX-License-Identifier: AGPL-3.0-or-later
import { parentPort } from "node:worker_threads";
import { answerRead, type ReadRequest } from "../ocr/ppocr/pool.ts";
import { createNodePpOcr } from "./ppocr-node.ts";

/** One PP-OCR worker thread (see `PpOcrPool`): its own reader, one page per message. */

const port = parentPort;
if (port === null) {
    throw new Error("ppocr-worker runs only as a worker thread");
}
const ppocr = createNodePpOcr();
port.on("message", (request: ReadRequest) => {
    ppocr
        .then(({ reader }) => answerRead(reader, request))
        .then(
            (response) => port.postMessage(response),
            (err: unknown) =>
                port.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) }),
        );
});
