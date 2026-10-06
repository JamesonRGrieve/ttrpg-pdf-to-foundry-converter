// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_TARGET, TARGET_IDS, targetFor, targetId } from "../src/infer/targets.ts";
import type { RunRequest, WorkerMessage } from "./protocol.ts";
import { planResources } from "./resources.ts";

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
const cores = element("cores", HTMLSelectElement);
const memory = element("memory", HTMLSelectElement);

/** Logical cores the browser reports (1 where it reports none). */
const availableCores = Math.max(1, navigator.hardwareConcurrency || 1);

/** Core choices from all of them down to one; all is the default. */
function fillCores(): void {
    for (let n = availableCores; n >= 1; n -= 1) {
        const option = document.createElement("option");
        option.value = String(n);
        option.textContent = n === availableCores ? `All ${n} (use everything)` : String(n);
        option.selected = n === availableCores;
        cores.append(option);
    }
}
fillCores();

/** The memory budget chosen, in MB, or null to use everything. */
const memoryBudget = (): number | null => (memory.value === "" ? null : Number(memory.value));

/** A chosen PDF, the control holding the target the user picked for it, and its remove button. */
interface ChosenPdf {
    file: File;
    line: HTMLSelectElement;
    remove: HTMLButtonElement;
}

let chosen: ChosenPdf[] = [];
let worker: Worker | null = null;
let zipUrl: string | null = null;

const isPdf = (file: File): boolean => file.type === "application/pdf" || /\.pdf$/iu.test(file.name);

/** A target picker for one PDF (game lines and rulesets grouped by system), defaulting to the default line. */
function linePicker(file: File, index: number): HTMLSelectElement {
    const select = document.createElement("select");
    select.id = `line-${index}`;
    select.setAttribute("aria-label", `Target schema for ${file.name}`);
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const id of TARGET_IDS) {
        const system = targetFor(id)?.system ?? "";
        let group = groups.get(system);
        if (group === undefined) {
            group = document.createElement("optgroup");
            group.label = system;
            groups.set(system, group);
            select.append(group);
        }
        const option = document.createElement("option");
        option.value = id;
        option.textContent = id;
        option.selected = id === targetId(DEFAULT_TARGET);
        group.append(option);
    }
    return select;
}

/** The pickers and remove buttons are locked while a conversion runs. */
function setPickersDisabled(disabled: boolean): void {
    for (const { line, remove } of chosen) {
        line.disabled = disabled;
        remove.disabled = disabled;
    }
    cores.disabled = disabled;
    memory.disabled = disabled;
}

/** Show the pending batch and whether it can be converted. */
function renderChosen(): void {
    chosenList.replaceChildren(
        ...chosen.map(({ file, line, remove }) => {
            const item = document.createElement("li");
            const name = document.createElement("span");
            name.textContent = file.name;
            item.append(name, " ", line, " ", remove);
            return item;
        }),
    );
    convert.disabled = chosen.length === 0;
    status.textContent =
        chosen.length === 0
            ? "No file chosen."
            : `Ready: ${chosen.length} PDF${chosen.length === 1 ? "" : "s"}.`;
}

/** A button that takes one PDF out of the pending batch. */
function removeButton(file: File): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "remove";
    button.textContent = "×";
    button.setAttribute("aria-label", `Remove ${file.name}`);
    button.addEventListener("click", () => {
        const index = chosen.findIndex((c) => c.remove === button);
        chosen = chosen.filter((c) => c.remove !== button);
        renderChosen();
        // Keep keyboard focus in the list: on the next remove button, else the file picker.
        (chosen[Math.min(index, chosen.length - 1)]?.remove ?? input).focus();
    });
    return button;
}

function choose(files: readonly File[]): void {
    chosen = files
        .filter(isPdf)
        .map((file, i) => ({ file, line: linePicker(file, i), remove: removeButton(file) }));
    renderChosen();
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
    setPickersDisabled(false);
}

async function start(): Promise<void> {
    if (chosen.length === 0) {
        return;
    }
    const picked = [...chosen];
    const files = picked.map(({ file }) => file);
    resetResult();
    convert.disabled = true;
    input.disabled = true;
    setPickersDisabled(true);
    status.textContent = `Reading ${files.length} PDF${files.length === 1 ? "" : "s"}…`;
    const documents = await Promise.all(
        picked.map(async ({ file, line }) => ({ pdf: await file.arrayBuffer(), target: line.value })),
    );
    progress.max = files.length;
    const plan = planResources(
        Number(cores.value),
        memoryBudget(),
        documents.reduce((n, d) => n + d.pdf.byteLength, 0),
    );
    if (plan.overBudget) {
        appendLog("The memory budget is below what one OCR worker needs; running one anyway.");
    }

    const engine = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    worker = engine;
    engine.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        switch (message.type) {
            case "ready": {
                status.textContent = "Converting…";
                const request: RunRequest = {
                    type: "run",
                    documents,
                    siteBase: new URL("./", document.baseURI).href,
                    ocrWorkers: plan.ocrWorkers,
                    maxInFlight: plan.maxInFlight,
                };
                const transfer = documents.map((d) => d.pdf);
                engine.postMessage(request, transfer);
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

input.addEventListener("change", () => {
    choose([...(input.files ?? [])]);
    // Clear the picker so choosing the same file again (after removing it) still fires.
    input.value = "";
});
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
