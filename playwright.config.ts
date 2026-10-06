// SPDX-License-Identifier: AGPL-3.0-or-later
import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests for the client-side upload page. The page is built
 * and served statically (`vite preview`); every conversion runs in the browser.
 */

const PORT = 4173;
/**
 * The page is served under a path, as a project site is (GitHub Pages serves
 * it at `/<repo>/`), so every URL it resolves must hold below the origin root.
 */
const SITE_PATH = "/converter/";
/**
 * Tests run side by side, a page each. A page's engine recognizes on half the
 * machine's cores, so a quarter of the core count keeps them all busy without
 * crowding each other out.
 */
const E2E_WORKERS = Math.max(1, Math.floor(availableParallelism() / 4));
/** A cold in-browser run renders + OCRs every page; allow for slow CI machines. */
const CONVERSION_TIMEOUT_MS = 300_000;

export default defineConfig({
    testDir: "e2e",
    timeout: CONVERSION_TIMEOUT_MS,
    // Each test converts in its own page; they share only the preview server.
    fullyParallel: true,
    workers: E2E_WORKERS,
    reporter: [["list"]],
    use: {
        baseURL: `http://127.0.0.1:${PORT}${SITE_PATH}`,
        acceptDownloads: true,
    },
    projects: [
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                // E2E_CHROMIUM points at an already-installed Chromium instead of
                // Playwright's managed download (e.g. /usr/bin/chromium).
                launchOptions:
                    process.env["E2E_CHROMIUM"] === undefined
                        ? {}
                        : { executablePath: process.env["E2E_CHROMIUM"] },
            },
        },
    ],
    webServer: {
        command: `pnpm web:build && pnpm exec vite preview --base ${SITE_PATH} --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}${SITE_PATH}`,
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
