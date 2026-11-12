// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * The Foundry package in a real Foundry v14 world on the wh40k-rpg system:
 * the GM converts a PDF from the Compendium sidebar, the packs land in the
 * world as compendiums matching the CLI's output, and converting again
 * updates them, asking about the documents the GM edited.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ID = "ttrpg-pdf-converter";
const PDF = resolve(repoRoot, "fixtures/rendered/field-manual.pdf");
/** How long Foundry may take to be ready after a load or reload. */
const READY_TIMEOUT_MS = 120_000;
/** A conversion in the browser: render and read every page. */
const CONVERSION_TIMEOUT_MS = 600_000;

/** The CLI's golden module for the same PDF and target: each pack's name and document count. */
function goldenPacks(): Map<string, number> {
    const dir = join(repoRoot, "golden", "field-manual");
    const [module] = readdirSync(dir);
    const packs = new Map<string, number>();
    for (const file of readdirSync(join(dir, module ?? "", "packs"))) {
        const lines = readFileSync(join(dir, module ?? "", "packs", file), "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0);
        packs.set(file.replace(/\.db$/u, ""), lines.length);
    }
    return packs;
}

/** The parts of Foundry's client globals the spec reads in the page. */
interface WorldDocument {
    id: string;
    img?: string;
    getFlag(scope: string, key: string): unknown;
    update(data: Record<string, unknown>): Promise<unknown>;
}
interface WorldPack {
    metadata: { name: string; packageType: string; flags?: Record<string, Record<string, unknown>> };
    folder: { getFlag(scope: string, key: string): unknown } | null;
    getDocuments(): Promise<WorldDocument[]>;
    getDocument(id: string): Promise<WorldDocument | null>;
}
interface Fvtt {
    game: {
        ready?: boolean;
        packs: Iterable<WorldPack> & { get(collection: string): WorldPack | undefined };
        modules: { get(id: string): { active?: boolean } | undefined };
        settings: {
            get(scope: string, key: string): Record<string, boolean> | undefined;
            set(scope: string, key: string, value: unknown): Promise<unknown>;
        };
    };
    ui: { sidebar: { expand?(): void; changeTab(tab: string, group: string): void } };
}

interface PackState {
    name: string;
    documents: number;
    flagged: number;
}

/** The world's compendiums this package wrote, with their document counts. */
async function worldPacks(page: Page): Promise<PackState[]> {
    return page.evaluate(async (scope) => {
        const g = (globalThis as unknown as Fvtt).game;
        const out: { name: string; documents: number; flagged: number }[] = [];
        for (const pack of g.packs) {
            if (pack.metadata.packageType !== "world") {
                continue;
            }
            const docs = await pack.getDocuments();
            out.push({
                name: pack.metadata.name,
                documents: docs.length,
                flagged: docs.filter((d) => d.getFlag(scope, "key") !== undefined).length,
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }, PACKAGE_ID);
}

async function joinAsGamemaster(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        await page.goto("/join");
        if ((await page.locator('input[name="username"]').count()) > 0) {
            break;
        }
        await page.waitForTimeout(2_000);
    }
    await page.fill('input[name="username"]', "Gamemaster");
    await page.click('button[name="join"]');
    await page.waitForURL(/\/game/u);
    await page.waitForFunction(
        () => (globalThis as unknown as Partial<Fvtt>).game?.ready === true,
        undefined,
        {
            timeout: READY_TIMEOUT_MS,
        },
    );
}

/**
 * Stop core's welcome tour: a fresh world starts it a moment after ready, and
 * its overlay swallows clicks. Its start is neutered, an active one exited
 * and its overlay removed (as the wh40k-rpg system's e2e suite does).
 */
async function stopWelcomeTour(page: Page): Promise<void> {
    await page.evaluate(() => {
        const g = globalThis as unknown as {
            game?: { tours?: { get?: (id: string) => { start?: () => Promise<void> } | undefined } };
            foundry?: { nue?: { Tour?: { activeTour?: { exit?: () => void } | null } } };
            document: { querySelectorAll(selector: string): Iterable<{ remove(): void }> };
        };
        const welcome = g.game?.tours?.get?.("core.welcome");
        if (welcome !== undefined) {
            welcome.start = async (): Promise<void> => {
                await Promise.resolve();
            };
        }
        g.foundry?.nue?.Tour?.activeTour?.exit?.();
        for (const n of g.document.querySelectorAll(".tour-overlay, .tour-fadeout, .tour-center-step")) {
            n.remove();
        }
    });
}

/** Activate the package in the world (a reload applies it). */
async function activatePackage(page: Page): Promise<void> {
    const changed = await page.evaluate(async (id) => {
        const g = (globalThis as unknown as Fvtt).game;
        if (g.modules.get(id)?.active === true) {
            return false;
        }
        const current = g.settings.get("core", "moduleConfiguration") ?? {};
        await g.settings.set("core", "moduleConfiguration", { ...current, [id]: true });
        return true;
    }, PACKAGE_ID);
    if (changed) {
        await page.reload();
        await page.waitForFunction(
            () => (globalThis as unknown as Partial<Fvtt>).game?.ready === true,
            undefined,
            {
                timeout: READY_TIMEOUT_MS,
            },
        );
    }
}

/** Open the converter from the Compendium sidebar, convert the PDF, and wait for the outcome. */
async function convert(page: Page, onConflicts?: (page: Page) => Promise<void>): Promise<string> {
    // The GM opens the Compendium tab, which expands the sidebar.
    await page.evaluate(() => {
        const sidebar = (globalThis as unknown as Fvtt).ui.sidebar;
        sidebar.expand?.();
        sidebar.changeTab("compendium", "primary");
    });
    await page.locator(`[data-${PACKAGE_ID}]`).click();
    const app = page.locator(`#${PACKAGE_ID}`);
    await expect(app).toBeVisible();
    await app.locator('input[type="file"]').setInputFiles(PDF);
    await expect(app.locator("li select")).toHaveValue("dh2");
    await stopWelcomeTour(page);
    await app.getByRole("button", { name: "Convert" }).click();
    const status = app.getByRole("status");
    if (onConflicts !== undefined) {
        const dialog = page.locator(".application.dialog", { hasText: "Edited documents" });
        await expect(dialog).toBeVisible({ timeout: CONVERSION_TIMEOUT_MS });
        await onConflicts(page);
    }
    await expect(status).toHaveText(/^(Done|Failed|Refused)/u, { timeout: CONVERSION_TIMEOUT_MS });
    const text = (await status.textContent()) ?? "";
    await app.locator('[data-action="close"]').click();
    return text;
}

test("converts a PDF into world compendiums and updates them, keeping the GM's edits", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    // Foundry reports a document it refuses to create on the console, and creates the rest: a refusal fails the test.
    const refused: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "error" && msg.text().includes("validation errors")) {
            refused.push(msg.text());
        }
    });
    await joinAsGamemaster(page);
    await activatePackage(page);
    await stopWelcomeTour(page);

    // First conversion: every pack of the CLI's module, with the same documents.
    const first = await convert(page);
    expect(refused, "documents Foundry refused to create").toEqual([]);
    expect(first).toMatch(/^Done:/u);
    const golden = goldenPacks();
    const packs = await worldPacks(page);
    expect(packs.map((p) => [p.name, p.documents])).toEqual(
        [...golden].sort((a, b) => a[0].localeCompare(b[0])),
    );
    expect(packs.every((p) => p.flagged === p.documents)).toBe(true);
    // The packs carry the system's flags, so the system finds them, and sit in one folder.
    const placed = await page.evaluate((scope) => {
        const g = (globalThis as unknown as Fvtt).game;
        const ours = [...g.packs].filter((p) => p.metadata.packageType === "world");
        return {
            lines: [...new Set(ours.map((p) => p.metadata.flags?.["wh40k-rpg"]?.["line"]))],
            folders: [...new Set(ours.map((p) => p.folder?.getFlag(scope, "books") ?? null))].length,
        };
    }, PACKAGE_ID);
    expect(placed).toEqual({ lines: ["dh2"], folders: 1 });

    // The GM edits one weapon; another's stored import is made stale, as a newer
    // converter release would leave it.
    const weapons = "world.dh2-wayfarers-field-manual-items-weapons";
    const [edited, stale] = await page.evaluate(
        async ({ collection, scope }) => {
            const pack = (globalThis as unknown as Fvtt).game.packs.get(collection);
            const [a, b] = (await pack?.getDocuments()) ?? [];
            if (a === undefined || b === undefined) {
                throw new Error(`${collection} holds fewer than two documents`);
            }
            await a.update({ img: "icons/svg/item-bag.svg", [`flags.${scope}.sourceHash`]: "stale" });
            await b.update({ [`flags.${scope}.sourceHash`]: "stale" });
            return [a.id, b.id];
        },
        { collection: weapons, scope: PACKAGE_ID },
    );

    // Converting again replaces the unedited weapon and asks about the edited one; keeping it keeps the edit.
    const second = await convert(page, async (p) => {
        const dialog = p.locator(".application.dialog", { hasText: "Edited documents" });
        await expect(dialog.locator("tbody tr")).toHaveCount(1);
        await dialog.getByRole("button", { name: "Apply" }).click();
    });
    expect(second).toMatch(/^Done: .* 0 new, 1 updated, 0 removed, .* 1 of your edits kept\./u);
    const after = await page.evaluate(
        async ({ collection, ids, scope }) => {
            const pack = (globalThis as unknown as Fvtt).game.packs.get(collection);
            const [a, b] = await Promise.all(
                ids.map(async (id: string) => (await pack?.getDocument(id)) ?? null),
            );
            return {
                editedImg: a?.img,
                editedHash: a?.getFlag(scope, "sourceHash"),
                staleHash: b?.getFlag(scope, "sourceHash"),
            };
        },
        { collection: weapons, ids: [edited, stale], scope: PACKAGE_ID },
    );
    expect(after.editedImg).toBe("icons/svg/item-bag.svg");
    expect(after.editedHash).not.toBe("stale");
    expect(after.staleHash).not.toBe("stale");

    // A third conversion of the same PDF changes nothing and asks nothing.
    const third = await convert(page);
    expect(third).toMatch(/^Done: .* 0 new, 0 updated, 0 removed, /u);
    expect((await worldPacks(page)).map((p) => p.documents)).toEqual(packs.map((p) => p.documents));
    expect(errors).toEqual([]);
});
