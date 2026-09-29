// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

/**
 * The upload page converts entirely client-side and produces exactly what the
 * CLI produces: the downloaded zip must match the committed golden output byte
 * for byte, and the page may only ever talk to its own origin.
 */

const repoRoot = resolve(import.meta.dirname, "..");

function goldenTree(name: string): Map<string, Uint8Array> {
    const dir = resolve(repoRoot, "golden", name);
    const out = new Map<string, Uint8Array>();
    const walk = (d: string): void => {
        for (const entry of readdirSync(d).sort()) {
            const full = join(d, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else {
                out.set(relative(dir, full), new Uint8Array(readFileSync(full)));
            }
        }
    };
    walk(dir);
    return out;
}

/** Record every request that leaves the page's own origin. */
function watchOffOrigin(page: Page, origin: string): string[] {
    const offOrigin: string[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== origin && url.protocol !== "blob:" && url.protocol !== "data:") {
            offOrigin.push(request.url());
        }
    });
    return offOrigin;
}

/** Upload the PDFs, convert, and check the downloaded module against a golden case. */
async function convertsLikeCli(page: Page, baseURL: string | undefined, pdfs: string[], goldenCase: string) {
    if (baseURL === undefined) {
        throw new Error("baseURL is set in playwright.config.ts");
    }
    const offOrigin = watchOffOrigin(page, new URL(baseURL).origin);
    await page.goto("/");
    const target = page.getByLabel("Output schema (game line)");
    await expect(target).toHaveValue("dh2");
    await expect(target.locator("option")).toHaveCount(7);
    await page.getByLabel(/drop pdfs here/i).setInputFiles(pdfs.map((pdf) => resolve(repoRoot, pdf)));
    const chosen = page.getByRole("list", { name: "Chosen PDFs" }).getByRole("listitem");
    await expect(chosen).toHaveCount(pdfs.length);
    await page.getByRole("button", { name: "Convert" }).click();

    const link = page.getByRole("link", { name: /download module/i });
    await expect(link).toBeVisible({ timeout: 280_000 });
    await expect(page.getByRole("status")).toContainText("Done:");
    const progress = page.getByRole("progressbar", { name: "Conversion progress" });
    await expect(progress).toHaveAttribute("value", String(pdfs.length));

    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    const zip = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const produced = new Map(Object.entries(zip));
    const golden = goldenTree(goldenCase);

    expect([...produced.keys()].sort()).toEqual([...golden.keys()].sort());
    for (const [path, bytes] of golden) {
        const made = produced.get(path);
        expect(
            made !== undefined && Buffer.from(made).equals(Buffer.from(bytes)),
            `bytes differ: ${path}`,
        ).toBe(true);
    }
    expect(offOrigin, "requests left the page's origin").toEqual([]);
}

test("converts a PDF in-browser into a module identical to the CLI golden", async ({ page, baseURL }) => {
    await convertsLikeCli(page, baseURL, ["fixtures/rendered/field-manual.pdf"], "field-manual");
});

test("converts several PDFs in one run into one module", async ({ page, baseURL }) => {
    await convertsLikeCli(
        page,
        baseURL,
        ["fixtures/rendered/images.pdf", "fixtures/rendered/field-manual.pdf"],
        "combined",
    );
});

test("refuses an encrypted PDF", async ({ page }) => {
    await page.goto("/");
    await page
        .getByLabel(/drop pdfs here/i)
        .setInputFiles(resolve(repoRoot, "fixtures/rendered/encrypted.pdf"));
    await page.getByRole("button", { name: "Convert" }).click();
    await expect(page.getByRole("status")).toContainText("Refused", { timeout: 60_000 });
    await expect(page.getByRole("link", { name: /download module/i })).toBeHidden();
});
