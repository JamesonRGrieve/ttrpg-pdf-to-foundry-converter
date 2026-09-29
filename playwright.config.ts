// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests for the client-side upload page. The page is built
 * and served statically (`vite preview`); every conversion runs in the browser.
 */

const PORT = 4173;
/** A cold in-browser run renders + OCRs every page; allow for slow CI machines. */
const CONVERSION_TIMEOUT_MS = 300_000;

export default defineConfig({
    testDir: "e2e",
    timeout: CONVERSION_TIMEOUT_MS,
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
    use: {
        baseURL: `http://127.0.0.1:${PORT}/`,
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
        command: `pnpm web:build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
