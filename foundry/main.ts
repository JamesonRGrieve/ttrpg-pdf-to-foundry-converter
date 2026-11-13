// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_TARGET, OFFERED_TARGET_IDS, targetFor, targetId } from "../src/infer/targets.ts";
import { RELEASE } from "../src/version.ts";
import type { RunRequest, WorkerMessage } from "../web/protocol.ts";
import { automaticBudgetMb, looksOutOfMemory, planResources } from "../web/resources.ts";
import { importModule } from "./importer.ts";
import { PACKAGE_ID, readConvertedModule } from "./sync.ts";

/**
 * The Foundry package: a *Convert PDF* button in the Compendium sidebar opens
 * the converter for the GM. The same engine worker as the upload page runs in
 * the GM's browser, and its packs are written into the world as compendiums.
 */

/**
 * The package's own folder, where the worker and the OCR runtime are served:
 * this script's URL without its `scripts/<file>` tail. (Written as a string
 * operation: the bundler would take `new URL("../", import.meta.url)` for an
 * asset to inline.)
 */
const PACKAGE_BASE = import.meta.url.replace(/scripts\/[^/]*$/u, "");

/** The targets offered: the lines of the world's system. */
function offeredTargets(): string[] {
    return OFFERED_TARGET_IDS.filter((id) => targetFor(id)?.system === game.system.id);
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<HTMLElementTagNameMap[K]> = {},
    children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

/** The converter window's controls. */
interface View {
    root: HTMLElement;
    input: HTMLInputElement;
    list: HTMLUListElement;
    cores: HTMLSelectElement;
    debug: HTMLInputElement;
    convert: HTMLButtonElement;
    progress: HTMLProgressElement;
    status: HTMLParagraphElement;
    log: HTMLPreElement;
}

function buildView(): View {
    const input = el("input", { type: "file", accept: "application/pdf,.pdf", multiple: true });
    const list = el("ul", { className: `${PACKAGE_ID}-files` });
    const cores = el("select");
    const available = Math.max(1, navigator.hardwareConcurrency || 1);
    for (let n = available; n >= 1; n -= 1) {
        cores.append(el("option", { value: String(n), textContent: String(n), selected: n === available }));
    }
    const debug = el("input", { type: "checkbox" });
    const convert = el("button", { type: "button", textContent: "Convert", disabled: true });
    const progress = el("progress", { max: 1, value: 0 });
    const status = el("p", { textContent: "Choose the PDFs you own to convert." });
    status.setAttribute("role", "status");
    const log = el("pre", { className: `${PACKAGE_ID}-log` });
    const root = el("div", { className: `${PACKAGE_ID}-app` }, [
        el("p", {
            textContent:
                "The PDFs are read in this browser and never uploaded. The packs are written into this world as compendiums; converting the same book again updates them, and asks before replacing anything you have edited.",
        }),
        el("label", {}, ["PDFs ", input]),
        list,
        el("label", {}, ["CPU cores ", cores]),
        el("label", {}, [
            debug,
            " Debug logging (lists every table, entry, statblock, document and warning)",
        ]),
        convert,
        progress,
        status,
        el("details", {}, [el("summary", { textContent: "Engine log" }), log]),
    ]);
    return { root, input, list, cores, debug, convert, progress, status, log };
}

/** One chosen PDF and its target picker. */
interface Chosen {
    file: File;
    target: HTMLSelectElement;
}

function targetPicker(targets: readonly string[]): HTMLSelectElement {
    const select = el("select");
    const preferred = targetId(DEFAULT_TARGET);
    for (const id of targets) {
        select.append(el("option", { value: id, textContent: id, selected: id === preferred }));
    }
    return select;
}

/** Run the engine worker over the chosen PDFs and import what it writes. */
async function run(view: View, chosen: readonly Chosen[]): Promise<void> {
    const append = (line: string): void => {
        view.log.append(document.createTextNode(`${line}\n`));
    };
    view.convert.disabled = true;
    view.log.textContent = "";
    const documents = await Promise.all(
        chosen.map(async ({ file, target }) => ({ pdf: await file.arrayBuffer(), target: target.value })),
    );
    const plan = planResources(
        Number(view.cores.value),
        automaticBudgetMb((navigator as Navigator & { deviceMemory?: number }).deviceMemory),
        documents.reduce((n, d) => n + d.pdf.byteLength, 0),
    );
    const worker = new Worker(new URL("../web/engine.worker.ts", import.meta.url), { type: "module" });
    const done = (text: string): void => {
        worker.terminate();
        view.status.textContent = text;
        view.convert.disabled = chosen.length === 0;
    };
    worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        switch (message.type) {
            case "ready": {
                view.status.textContent = "Converting…";
                const request: RunRequest = {
                    type: "run",
                    documents,
                    siteBase: PACKAGE_BASE,
                    ocrWorkers: plan.ocrWorkers,
                    maxInFlight: plan.maxInFlight,
                    debug: view.debug.checked,
                    output: "files",
                };
                worker.postMessage(
                    request,
                    documents.map((d) => d.pdf),
                );
                break;
            }
            case "log":
                append(message.line);
                break;
            case "progress":
                view.progress.max = message.documents;
                view.progress.value =
                    message.document + (message.pages > 0 ? message.page / message.pages : 0);
                view.status.textContent = `${chosen[message.document]?.file.name ?? "PDF"}: page ${message.page} of ${message.pages}`;
                break;
            case "files": {
                worker.terminate();
                view.progress.value = view.progress.max;
                view.status.textContent = "Writing the compendiums…";
                const module = readConvertedModule(message.files);
                importModule(module, append)
                    .then((r) => {
                        const text = `Done: ${r.packs} compendiums — ${r.created} new, ${r.replaced} updated, ${r.removed} removed, ${r.unchanged} unchanged, ${r.kept} of your edits kept.`;
                        done(text);
                        ui.notifications.info(`${PACKAGE_ID}: ${text}`);
                    })
                    .catch((err: unknown) =>
                        done(`Failed while writing: ${err instanceof Error ? err.message : String(err)}`),
                    );
                break;
            }
            case "result":
                done("Unexpected zip result.");
                break;
            case "refused":
                done("Refused: every PDF is encrypted. Supply decrypted files.");
                break;
            case "error":
                append(`error: ${message.message}`);
                done(
                    `Failed: ${message.message}${looksOutOfMemory(message.message) ? " (the browser ran out of memory: use fewer cores)" : ""}`,
                );
                break;
        }
    });
    worker.addEventListener("error", (event) => {
        const reason =
            event.message ||
            "the converter stopped unexpectedly (most often the browser ending it for memory)";
        append(`error: ${reason}`);
        done(`Failed: ${reason}`);
    });
    view.status.textContent = "Starting the engine…";
}

/** Wire the converter window's controls. */
function wire(view: View): void {
    const chosen: Chosen[] = [];
    const targets = offeredTargets();
    if (targets.length === 0) {
        view.status.textContent = `This world's system (${game.system.id}) has no conversion target.`;
        view.input.disabled = true;
        return;
    }
    const redraw = (): void => {
        view.list.replaceChildren(
            ...chosen.map((c, i) => {
                const remove = el("button", {
                    type: "button",
                    textContent: "×",
                    title: `Remove ${c.file.name}`,
                });
                remove.addEventListener("click", () => {
                    chosen.splice(i, 1);
                    redraw();
                });
                return el("li", {}, [`${c.file.name} `, c.target, remove]);
            }),
        );
        view.convert.disabled = chosen.length === 0;
    };
    view.input.addEventListener("change", () => {
        for (const file of view.input.files ?? []) {
            chosen.push({ file, target: targetPicker(targets) });
        }
        view.input.value = "";
        redraw();
    });
    view.convert.addEventListener("click", () => {
        run(view, chosen).catch((err: unknown) => {
            view.status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
            view.convert.disabled = false;
        });
    });
}

/** Open the converter window (built on Foundry's ApplicationV2 once Foundry has loaded). */
function openConverter(): void {
    const Base = foundry.applications.api.ApplicationV2;
    class ConverterApp extends Base {
        static DEFAULT_OPTIONS = {
            id: PACKAGE_ID,
            window: { title: `Convert PDF (release ${RELEASE})`, resizable: true },
            position: { width: 560, height: "auto" },
        };
        async _renderHTML(): Promise<HTMLElement> {
            const view = buildView();
            wire(view);
            return view.root;
        }
        _replaceHTML(result: HTMLElement, content: HTMLElement): void {
            content.replaceChildren(result);
        }
    }
    void new ConverterApp().render(true);
}

Hooks.on("renderCompendiumDirectory", (_app, html) => {
    if (!game.user.isGM || !(html instanceof HTMLElement)) {
        return;
    }
    if (html.querySelector(`[data-${PACKAGE_ID}]`) !== null) {
        return;
    }
    const button = el("button", {
        type: "button",
        innerHTML: '<i class="fa-solid fa-file-pdf"></i> Convert PDF',
    });
    button.setAttribute(`data-${PACKAGE_ID}`, "");
    button.addEventListener("click", openConverter);
    const actions = html.querySelector(".header-actions") ?? html.querySelector("header") ?? html;
    actions.append(button);
});
