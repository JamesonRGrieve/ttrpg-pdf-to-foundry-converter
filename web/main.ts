// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_LINE, LINES } from "../src/infer/schema.ts";
import type { RunRequest, WorkerMessage } from "./protocol.ts";

/**
 * The upload page: hand a PDF to the engine worker, show progress and the
 * engine log, and offer the resulting packs as a zip. All work happens in this
 * tab — the file is read locally and never sent anywhere.
 */

function element<T extends HTMLElement>(id: string, type: new () => T): T {
    const el = document.getElementById(id);
    if (!(el instanceof type)) {
        throw new Error(`missing #${id}`);
    }
    return el;
}

const input = element("pdf-input", HTMLInputElement);
const dropZone = element("drop-zone", HTMLLabelElement);
const convert = element("convert", HTMLButtonElement);
const status = element("status", HTMLParagraphElement);
const progress = element("ocr-progress", HTMLProgressElement);
const log = element("log", HTMLPreElement);
const packs = element("packs", HTMLTableElement);
const download = element("download", HTMLAnchorElement);
const target = element("target", HTMLSelectElement);

for (const line of LINES) {
    const option = document.createElement("option");
    option.value = line;
    option.textContent = line;
    option.selected = line === DEFAULT_LINE;
    target.append(option);
}

let chosen: File | null = null;
let worker: Worker | null = null;
let zipUrl: string | null = null;

function choose(file: File | undefined): void {
    chosen = file ?? null;
    convert.disabled = chosen === null;
    status.textContent = chosen === null ? "No file chosen." : `Ready: ${chosen.name}`;
}

function resetResult(): void {
    packs.hidden = true;
    packs.tBodies[0]?.replaceChildren();
    download.hidden = true;
    if (zipUrl !== null) {
        URL.revokeObjectURL(zipUrl);
        zipUrl = null;
    }
    log.textContent = "";
    progress.value = 0;
}

function appendLog(line: string): void {
    log.append(document.createTextNode(`${line}\n`));
}

function showResult(message: Extract<WorkerMessage, { type: "result" }>, name: string): void {
    const body = packs.tBodies[0];
    if (body !== undefined) {
        for (const pack of message.packs) {
            const row = document.createElement("tr");
            const packCell = document.createElement("td");
            packCell.textContent = pack.pack;
            const countCell = document.createElement("td");
            countCell.textContent = String(pack.documents);
            row.append(packCell, countCell);
            body.append(row);
        }
    }
    packs.hidden = message.packs.length === 0;
    zipUrl = URL.createObjectURL(new Blob([message.zip], { type: "application/zip" }));
    download.href = zipUrl;
    download.download = `${name.replace(/\.pdf$/iu, "")}-packs.zip`;
    download.hidden = false;
    status.textContent = `Done: ${message.documents} documents in ${message.packs.length} packs, ${message.assets} images, ${message.warnings} warnings.`;
    download.focus();
}

function finish(): void {
    worker?.terminate();
    worker = null;
    convert.disabled = chosen === null;
    input.disabled = false;
    target.disabled = false;
}

async function start(): Promise<void> {
    if (chosen === null) {
        return;
    }
    const file = chosen;
    resetResult();
    convert.disabled = true;
    input.disabled = true;
    target.disabled = true;
    status.textContent = `Reading ${file.name}…`;
    const pdf = await file.arrayBuffer();

    const engine = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    worker = engine;
    engine.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        switch (message.type) {
            case "ready": {
                status.textContent = "Converting…";
                const request: RunRequest = { type: "run", pdf, target: target.value };
                engine.postMessage(request, [pdf]);
                break;
            }
            case "log":
                appendLog(message.line);
                break;
            case "progress":
                progress.max = message.total;
                progress.value = message.done;
                status.textContent = `Recognizing pages: ${message.done} of ${message.total}`;
                break;
            case "result":
                showResult(message, file.name);
                finish();
                break;
            case "refused":
                status.textContent = "Refused: this PDF is encrypted. Supply a decrypted file.";
                finish();
                break;
            case "error":
                status.textContent = `Failed: ${message.message}`;
                finish();
                break;
        }
    });
    engine.addEventListener("error", (event) => {
        status.textContent = `Failed: ${event.message}`;
        finish();
    });
    status.textContent = "Starting the engine…";
}

input.addEventListener("change", () => choose(input.files?.[0]));
convert.addEventListener("click", () => {
    start().catch((err: unknown) => {
        status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
        finish();
    });
});
dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (file !== undefined && (file.type === "application/pdf" || /\.pdf$/iu.test(file.name))) {
        choose(file);
    }
});
