// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    type Conflict,
    type ConvertedModule,
    type ConvertedPack,
    canonicalContent,
    documentKeys,
    type ExistingDocument,
    type ImportFlags,
    type IncomingDocument,
    PACKAGE_ID,
    type PackPlan,
    planPack,
    pointAtWorld,
    REMOVAL_KEPT,
    type Resolution,
    sha256,
} from "./sync.ts";

/**
 * Writing a converted module into the world: its images under the world's
 * folder, its packs as world compendiums in one compendium folder, and on a
 * re-import the documents it changed, with any the GM has edited since put to
 * the GM first.
 */

/** What an import did, for the GM. */
export interface ImportReport {
    packs: number;
    created: number;
    replaced: number;
    removed: number;
    unchanged: number;
    kept: number;
}

type Log = (line: string) => void;

/** Asset images go under the world, beside nothing else: `worlds/<world>/ttrpg-pdf-converter/assets`. */
function assetDir(): string {
    return `worlds/${game.world.id}/${PACKAGE_ID}/assets`;
}

/** Create a directory under Foundry's data folder if it is not there. */
async function ensureDirectory(path: string): Promise<void> {
    const picker = foundry.applications.apps.FilePicker.implementation;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
        const dir = parts.slice(0, i).join("/");
        try {
            await picker.browse("data", dir);
        } catch {
            await picker.createDirectory("data", dir);
        }
    }
}

/** Upload the module's images that the world does not have yet (their names are content hashes). */
async function uploadAssets(module: ConvertedModule, log: Log): Promise<void> {
    if (module.assets.size === 0) {
        return;
    }
    const picker = foundry.applications.apps.FilePicker.implementation;
    const dir = assetDir();
    await ensureDirectory(dir);
    const have = new Set((await picker.browse("data", dir)).files.map((f) => f.split("/").pop() ?? ""));
    let uploaded = 0;
    for (const [name, bytes] of module.assets) {
        if (have.has(name)) {
            continue;
        }
        await picker.upload("data", dir, new File([bytes as BlobPart], name), {}, { notify: false });
        uploaded += 1;
    }
    log(`images: ${uploaded} uploaded, ${module.assets.size - uploaded} already in the world`);
}

/** The books a module holds, as its title names them: the compendium folder's name and key. */
function booksOf(module: ConvertedModule): string {
    const named = /^[^:]*:\s*(?<books>.*?)\s*\([^)]*\)\s*$/u.exec(module.title)?.groups?.["books"];
    return named !== undefined && named.length > 0 ? named : module.id;
}

/** Title Case a list of book slugs for the folder's name. */
function folderName(books: string): string {
    return books
        .split(/,\s*/u)
        .map((slug) =>
            slug
                .split("-")
                .filter((w) => w.length > 0)
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" "),
        )
        .join(", ");
}

/** The compendium folder this module's packs go in, found by its flag or made. */
async function ensureFolder(module: ConvertedModule): Promise<string> {
    const books = booksOf(module);
    const existing = game.folders.contents.find(
        (f) => f.type === "Compendium" && f.getFlag(PACKAGE_ID, "books") === books,
    );
    if (existing !== undefined) {
        return existing.id;
    }
    const folder = await foundry.documents.Folder.create({
        name: folderName(books),
        type: "Compendium",
        flags: { [PACKAGE_ID]: { books } },
    });
    return folder.id;
}

/** The world pack a converted pack goes in, made (unlocked, in the folder) if there is none. */
async function ensurePack(pack: ConvertedPack, folder: string, release: string): Promise<FoundryPack> {
    const flags = { ...pack.flags, [PACKAGE_ID]: { release } };
    let world = game.packs.get(`world.${pack.name}`);
    if (world === undefined) {
        world = await foundry.documents.collections.CompendiumCollection.createCompendium({
            name: pack.name,
            label: pack.label,
            type: pack.type,
            flags,
            ownership: pack.ownership,
        });
    }
    if (world.locked) {
        await world.configure({ locked: false });
    }
    if (world.folder?.id !== folder) {
        await world.setFolder(folder);
    }
    return world;
}

/** A world document's import flags, when it was imported by this package. */
function importFlags(doc: FoundryDocument): ImportFlags | null {
    const flags = doc.toObject()["flags"];
    const own =
        flags !== null && typeof flags === "object"
            ? (flags as Record<string, unknown>)[PACKAGE_ID]
            : undefined;
    if (own === null || typeof own !== "object") {
        return null;
    }
    const f = own as Partial<ImportFlags>;
    return typeof f.key === "string" && typeof f.sourceHash === "string" && typeof f.fingerprint === "string"
        ? {
              key: f.key,
              sourceHash: f.sourceHash,
              fingerprint: f.fingerprint,
              release: String(f.release ?? ""),
          }
        : null;
}

/** One pack's plan with what applying it needs. */
interface PackWork {
    pack: ConvertedPack;
    world: FoundryPack;
    plan: PackPlan;
}

/** Plan one pack against the world pack it goes in. */
async function planOne(pack: ConvertedPack, world: FoundryPack): Promise<PackWork> {
    const keys = documentKeys(pack.type, pack.documents);
    const incoming: IncomingDocument[] = [];
    for (const [i, source] of pack.documents.entries()) {
        incoming.push({ key: keys[i] ?? "", sourceHash: await sha256(canonicalContent(source)), source });
    }
    const existing: ExistingDocument[] = [];
    for (const doc of await world.getDocuments()) {
        existing.push({
            _id: doc.id,
            name: doc.name,
            flags: importFlags(doc),
            currentFingerprint: await sha256(canonicalContent(doc.toObject())),
        });
    }
    return { pack, world, plan: planPack(incoming, existing) };
}

/** Ask the GM how to settle each conflict; keep is the default. */
async function settleConflicts(conflicts: readonly Conflict[]): Promise<Map<Conflict, Resolution>> {
    const resolutions = new Map<Conflict, Resolution>(conflicts.map((c) => [c, "keep"]));
    if (conflicts.length === 0) {
        return resolutions;
    }
    const rows = conflicts
        .map((c, i) => {
            const what =
                c.kind === "changed"
                    ? "The new conversion changed it."
                    : "The new conversion no longer has it.";
            const take = c.kind === "changed" ? "Take the new version" : "Delete it";
            return `<tr><td>${escapeHtml(c.name)}</td><td>${what}</td><td><select name="c${i}">
<option value="keep" selected>Keep my edits</option><option value="replace">${take}</option></select></td></tr>`;
        })
        .join("");
    const content = `<p>You edited these documents since they were last imported. Choose what to do with each.</p>
<table class="${PACKAGE_ID}-conflicts"><thead><tr><th>Document</th><th>Change</th><th>Choice</th></tr></thead>
<tbody>${rows}</tbody></table>
<p><button type="button" data-all="keep">Keep all my edits</button>
<button type="button" data-all="replace">Take all new versions</button></p>`;
    const read = (form: HTMLFormElement | null): void => {
        conflicts.forEach((c, i) => {
            const value = form?.querySelector<HTMLSelectElement>(`select[name="c${i}"]`)?.value;
            resolutions.set(c, value === "replace" ? "replace" : "keep");
        });
    };
    // Set every choice at once from the two buttons above the dialog's own.
    const wire = (): void => {
        for (const button of document.querySelectorAll<HTMLButtonElement>(
            `.${PACKAGE_ID}-conflicts ~ p [data-all]`,
        )) {
            button.addEventListener("click", () => {
                for (const select of button.closest("form")?.querySelectorAll("select") ?? []) {
                    select.value = button.dataset["all"] ?? "keep";
                }
            });
        }
    };
    setTimeout(wire, 0);
    await foundry.applications.api.DialogV2.wait({
        window: { title: "Edited documents" },
        content,
        position: { width: 640 },
        rejectClose: false,
        buttons: [
            {
                action: "apply",
                label: "Apply",
                default: true,
                callback: (_event, button) => read(button.form),
            },
        ],
    });
    return resolutions;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Import a converted module into the world. */
export async function importModule(module: ConvertedModule, log: Log): Promise<ImportReport> {
    const report: ImportReport = { packs: 0, created: 0, replaced: 0, removed: 0, unchanged: 0, kept: 0 };
    await uploadAssets(module, log);
    const folder = await ensureFolder(module);
    const work: PackWork[] = [];
    for (const pack of module.packs) {
        const world = await ensurePack(pack, folder, module.release);
        work.push(await planOne(pack, world));
    }
    // References cross packs: every converter id maps to the world id it lives under.
    const idMap = new Map<string, string>();
    for (const w of work) {
        for (const [from, to] of w.plan.idMap) {
            idMap.set(from, to);
        }
    }
    const conflicts = work.flatMap((w) => w.plan.conflicts);
    const resolutions = await settleConflicts(conflicts);
    const dir = assetDir();
    for (const { pack, world, plan } of work) {
        const cls = CONFIG[pack.type]?.documentClass;
        if (cls === undefined) {
            log(`${pack.label}: Foundry has no ${pack.type} documents; skipped`);
            continue;
        }
        const options = { pack: world.collection };
        const toWrite: { id: string; incoming: IncomingDocument }[] = [
            ...plan.create.map((incoming) => ({
                id: idMap.get(incoming.source._id) ?? incoming.source._id,
                incoming,
            })),
            ...plan.replace.map((r) => ({ id: r.existingId, incoming: r.incoming })),
        ];
        const toDelete = [...plan.remove, ...plan.replace.map((r) => r.existingId)];
        const acknowledged: Record<string, unknown>[] = [];
        for (const c of plan.conflicts) {
            if (resolutions.get(c) === "replace") {
                toDelete.push(c.existingId);
                if (c.incoming !== undefined) {
                    toWrite.push({ id: c.existingId, incoming: c.incoming });
                }
            } else {
                report.kept += 1;
                acknowledged.push({
                    _id: c.existingId,
                    [`flags.${PACKAGE_ID}.sourceHash`]: c.incoming?.sourceHash ?? REMOVAL_KEPT,
                });
            }
        }
        if (toDelete.length > 0) {
            await cls.deleteDocuments(toDelete, options);
        }
        const data = toWrite.map(({ id, incoming }) => {
            const pointed = pointAtWorld(incoming.source, module.id, idMap, dir) as Record<string, unknown>;
            const flags = (pointed["flags"] as Record<string, unknown> | undefined) ?? {};
            const own: ImportFlags = {
                key: incoming.key,
                sourceHash: incoming.sourceHash,
                fingerprint: "",
                release: module.release,
            };
            return { ...pointed, _id: id, flags: { ...flags, [PACKAGE_ID]: own } };
        });
        if (data.length > 0) {
            const created = await cls.createDocuments(data, { ...options, keepId: true });
            // Each document's fingerprint is taken as Foundry stored it, to tell a later edit.
            const prints: Record<string, unknown>[] = [];
            for (const doc of created) {
                prints.push({
                    _id: doc.id,
                    [`flags.${PACKAGE_ID}.fingerprint`]: await sha256(canonicalContent(doc.toObject())),
                });
            }
            await cls.updateDocuments(prints, options);
        }
        if (acknowledged.length > 0) {
            await cls.updateDocuments(acknowledged, options);
        }
        const replaced = toWrite.length - plan.create.length;
        log(
            `${pack.label}: ${plan.create.length} new, ${replaced} replaced, ${plan.remove.length} removed, ${plan.unchanged} unchanged`,
        );
        report.packs += 1;
        report.created += plan.create.length;
        report.replaced += replaced;
        report.removed += plan.remove.length;
        report.unchanged += plan.unchanged;
    }
    return report;
}
