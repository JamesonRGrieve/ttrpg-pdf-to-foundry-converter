// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_LINE, LINES } from "../src/infer/schema.ts";
import type { RunRequest, WorkerMessage } from "./protocol.ts";

/**
 * The upload page: hand one or more PDFs to the engine worker, show overall
 * progress and the engine log, and offer the resulting Foundry module as a
 * zip. All work happens in this tab — the files are read locally and never
 * sent anywhere.
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
const chosenList = element("chosen", HTMLUListElement);
const convert = element("convert", HTMLButtonElement);
const status = element("status", HTMLParagraphElement);
const progress = element("progress", HTMLProgressElement);
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

let chosen: File[] = [];
let worker: Worker | null = null;
let zipUrl: string | null = null;

const isPdf = (file: File): boolean => file.type === "application/pdf" || /\.pdf$/iu.test(file.name);

function choose(files: readonly File[]): void {
    chosen = files.filter(isPdf);
    chosenList.replaceChildren(
        ...chosen.map((file) => {
            const item = document.createElement("li");
            item.textContent = file.name;
            return item;
        }),
    );
    convert.disabled = chosen.length === 0;
    status.textContent =
        chosen.length === 0
            ? "No file chosen."
            : `Ready: ${chosen.length} PDF${chosen.length === 1 ? "" : "s"}.`;
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
    progress.max = 1;
    progress.value = 0;
}

function appendLog(line: string): void {
    log.append(document.createTextNode(`${line}\n`));
}

const refusedNames = (files: readonly File[], refused: readonly number[]): string =>
    refused.map((i) => files[i]?.name ?? `#${i + 1}`).join(", ");

function showResult(message: Extract<WorkerMessage, { type: "result" }>, files: readonly File[]): void {
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
    download.download = `${message.moduleId}.zip`;
    download.hidden = false;
    progress.value = progress.max;
    const refused =
        message.refused.length === 0 ? "" : ` Refused (encrypted): ${refusedNames(files, message.refused)}.`;
    status.textContent = `Done: module ${message.moduleId} — ${message.documents} documents in ${message.packs.length} packs, ${message.assets} images, ${message.warnings} warnings.${refused}`;
    download.focus();
}

function finish(): void {
    worker?.terminate();
    worker = null;
    convert.disabled = chosen.length === 0;
    input.disabled = false;
    target.disabled = false;
}

async function start(): Promise<void> {
    if (chosen.length === 0) {
        return;
    }
    const files = [...chosen];
    resetResult();
    convert.disabled = true;
    input.disabled = true;
    target.disabled = true;
    status.textContent = `Reading ${files.length} PDF${files.length === 1 ? "" : "s"}…`;
    const pdfs = await Promise.all(files.map((file) => file.arrayBuffer()));
    progress.max = files.length;

    const engine = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    worker = engine;
    engine.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        switch (message.type) {
            case "ready": {
                status.textContent = "Converting…";
                const request: RunRequest = { type: "run", pdfs, target: target.value };
                engine.postMessage(request, pdfs);
                break;
            }
            case "log":
                appendLog(message.line);
                break;
            case "progress":
                // Overall progress: whole documents done plus the current one's share.
                progress.max = message.documents;
                progress.value = message.document + (message.pages > 0 ? message.page / message.pages : 0);
                status.textContent = `${files[message.document]?.name ?? "PDF"} (${message.document + 1} of ${message.documents}): page ${message.page} of ${message.pages}`;
                break;
            case "result":
                showResult(message, files);
                finish();
                break;
            case "refused":
                status.textContent = `Refused: every PDF is encrypted (${refusedNames(files, message.refused)}). Supply decrypted files.`;
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

input.addEventListener("change", () => choose([...(input.files ?? [])]));
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
    choose([...(event.dataTransfer?.files ?? [])]);
});
