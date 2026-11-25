// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { joinAsGamemaster, stopWelcomeTour } from "./world.ts";

/**
 * Every converted module of a regression run works with the current system:
 * in a real Foundry world, each document of each pack is built as the
 * system's document (its DataModel validates the data strictly) and
 * prepared as a sheet prepares it (an Actor with its embedded items).
 *
 * Runs when TPC_MODULES_DIR points at a regression's output directory
 * (`<dir>/<book>/<module>/module.json`); otherwise it is skipped. TPC_BOOKS
 * limits it to some of the books.
 */

const MODULES_DIR = process.env["TPC_MODULES_DIR"];
/** Only these books (comma-separated directory names), when set: a run split into parts. */
const ONLY_BOOKS = process.env["TPC_BOOKS"]?.split(",").map((b) => b.trim());
/** Documents sent to the page at once. */
const BATCH = 200;

interface PackFile {
    type: string;
    documents: Record<string, unknown>[];
}

/** Each book's packs: the module's declared document type and its documents. */
function books(dir: string): Map<string, PackFile[]> {
    const out = new Map<string, PackFile[]>();
    for (const book of readdirSync(dir).sort()) {
        const bookDir = join(dir, book);
        if (!statSync(bookDir).isDirectory() || (ONLY_BOOKS !== undefined && !ONLY_BOOKS.includes(book))) {
            continue;
        }
        for (const module of readdirSync(bookDir)) {
            const manifest = join(bookDir, module, "module.json");
            if (!existsSync(manifest)) {
                continue;
            }
            const { packs } = JSON.parse(readFileSync(manifest, "utf8")) as {
                packs: { type: string; path: string }[];
            };
            out.set(
                book,
                packs.map((p) => ({
                    type: p.type,
                    documents: readFileSync(join(bookDir, module, `${p.path}.db`), "utf8")
                        .split("\n")
                        .filter((l) => l.trim().length > 0)
                        .map((l) => JSON.parse(l) as Record<string, unknown>),
                })),
            );
        }
    }
    return out;
}

test.skip(MODULES_DIR === undefined, "TPC_MODULES_DIR is not set");

test("every converted document validates and prepares under the current system", async ({ page }) => {
    test.setTimeout(3_600_000);
    const dir = resolve(MODULES_DIR ?? ".");
    await joinAsGamemaster(page);
    await stopWelcomeTour(page);
    const failures: string[] = [];
    let checked = 0;
    for (const [book, packs] of books(dir)) {
        for (const pack of packs) {
            for (let at = 0; at < pack.documents.length; at += BATCH) {
                const batch = pack.documents.slice(at, at + BATCH);
                const result = await page.evaluate(
                    ({ type, documents }) => {
                        const config = (
                            globalThis as unknown as {
                                CONFIG: Record<
                                    string,
                                    {
                                        documentClass: new (
                                            data: unknown,
                                            options?: unknown,
                                        ) => {
                                            prepareData(): void;
                                            name: string;
                                        };
                                    }
                                >;
                            }
                        ).CONFIG;
                        const cls = config[type]?.documentClass;
                        if (cls === undefined) {
                            return documents.map((d) => `${String(d["name"])}: no ${type} document class`);
                        }
                        const errors: string[] = [];
                        for (const data of documents) {
                            try {
                                const doc = new cls(structuredClone(data), { strict: true });
                                doc.prepareData();
                            } catch (err) {
                                errors.push(
                                    `${String(data["name"])}: ${(err as Error).message.split("\n").slice(0, 3).join(" ")}`,
                                );
                            }
                        }
                        return errors;
                    },
                    { type: pack.type, documents: batch },
                );
                checked += batch.length;
                failures.push(...result.map((e) => `${book} ${pack.type} ${e}`));
            }
        }
    }
    test.info().annotations.push({
        type: "modules",
        description: `${checked} documents checked, ${failures.length} failed`,
    });
    expect(failures, "documents the system refuses or cannot prepare").toEqual([]);
});

/** Sheets between progress lines within a book. */
const PROGRESS_EVERY = 200;

/** Documents of each pack whose sheets are opened: three, or TPC_SHEETS_PER_PACK (0 opens every one). */
const SHEETS_PER_PACK = Number(process.env["TPC_SHEETS_PER_PACK"] ?? 3);

/**
 * Room for every pack's sample: a full regression opens about 1,500 sheets
 * at some 20 a minute on a shared runner.
 */
const SHEETS_TIMEOUT_MS = Number(process.env["TPC_SHEETS_TIMEOUT_MS"] ?? 2 * 3_600_000);

test("converted documents open their sheets", async ({ page }) => {
    test.setTimeout(SHEETS_TIMEOUT_MS);
    const dir = resolve(MODULES_DIR ?? ".");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await joinAsGamemaster(page);
    await stopWelcomeTour(page);
    const failures: string[] = [];
    let opened = 0;
    for (const [book, packs] of books(dir)) {
        for (const pack of packs) {
            if (pack.type !== "Actor" && pack.type !== "Item") {
                continue;
            }
            const sample = SHEETS_PER_PACK > 0 ? pack.documents.slice(0, SHEETS_PER_PACK) : pack.documents;
            const result = await page.evaluate(
                async ({ type, documents }) => {
                    const config = (
                        globalThis as unknown as {
                            CONFIG: Record<
                                string,
                                {
                                    documentClass: {
                                        create(data: unknown): Promise<{
                                            sheet: {
                                                render(options: unknown): Promise<unknown>;
                                                close(): Promise<unknown>;
                                            } | null;
                                            delete(): Promise<unknown>;
                                        } | null>;
                                    };
                                }
                            >;
                        }
                    ).CONFIG;
                    const cls = config[type]?.documentClass;
                    const out: string[] = [];
                    for (const data of documents) {
                        // As a GM imports it: created in the world, its sheet opened, then removed.
                        try {
                            const { _id: _ignored, ...fields } = structuredClone(data);
                            const doc = await (cls as NonNullable<typeof cls>).create(fields);
                            if (doc === null) {
                                out.push(`${String(data["name"])}: not created`);
                                continue;
                            }
                            const sheet = doc.sheet;
                            if (sheet === null) {
                                out.push(`${String(data["name"])}: no sheet`);
                            } else {
                                await sheet.render({ force: true });
                                await sheet.close();
                            }
                            await doc.delete();
                        } catch (err) {
                            // The message, then where it was thrown: the top frames name the code.
                            const frames = ((err as Error).stack ?? "")
                                .split("\n")
                                .filter((line) => /^\s*at\s/u.test(line))
                                .slice(0, 3)
                                .map((line) => line.trim());
                            out.push(
                                [
                                    `${String(data["name"])}: ${(err as Error).message.split("\n")[0] ?? ""}`,
                                    ...frames,
                                ].join(" | "),
                            );
                        }
                    }
                    return out;
                },
                { type: pack.type, documents: sample },
            );
            const before = opened;
            opened += sample.length;
            failures.push(...result.map((e) => `${book} ${pack.type} ${e}`));
            // Within a long book, a line every PROGRESS_EVERY sheets.
            if (Math.floor(opened / PROGRESS_EVERY) > Math.floor(before / PROGRESS_EVERY)) {
                process.stdout.write(`[sheets] ${book} …: ${opened} opened, ${failures.length} failed\n`);
            }
        }
        // One line per book, so a long run shows its progress as it goes.
        process.stdout.write(`[sheets] ${book}: ${opened} opened, ${failures.length} failed\n`);
    }
    test.info().annotations.push({
        type: "sheets",
        description: `${opened} sheets opened, ${failures.length} failed`,
    });
    expect(failures, "sheets that fail to open").toEqual([]);
    expect(errors, "page errors while sheets open").toEqual([]);
});
