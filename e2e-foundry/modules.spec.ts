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
 * (`<dir>/<book>/<module>/module.json`); otherwise it is skipped.
 */

const MODULES_DIR = process.env["TPC_MODULES_DIR"];
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
        if (!statSync(bookDir).isDirectory()) {
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
