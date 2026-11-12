// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The Foundry package's e2e suite: the built package (dist-foundry/) running
 * in a real Foundry v14 server with the wh40k-rpg system, one isolated world
 * per run on port FOUNDRY_TEST_PORT (base 30201, clear of the system's and
 * the cartography module's suites). `scripts/e2e-foundry-world.mjs`
 * provisions it. The Foundry release comes from FOUNDRY_RELEASE_DIR (default
 * `.foundry-release`, gitignored); without one, every spec is skipped with a
 * banner unless FOUNDRY_INTEGRATION=required.
 */

const PORT = Number(process.env["FOUNDRY_TEST_PORT"] ?? 30201);
const RELEASE = resolve(process.env["FOUNDRY_RELEASE_DIR"] ?? ".foundry-release");
const FOUNDRY_PRESENT = existsSync(resolve(RELEASE, "main.js"));
const REQUIRED = process.env["FOUNDRY_INTEGRATION"] === "required";
const SYSTEM_CHROMIUM = "/usr/bin/chromium";
const executablePath =
    process.env["CHROMIUM_PATH"] ?? (existsSync(SYSTEM_CHROMIUM) ? SYSTEM_CHROMIUM : undefined);
/** Foundry v14 runs on Node 24 or later. */
const FOUNDRY_NODE = process.env["FOUNDRY_NODE"] ?? "node";
/** A cold world boot can take a while on a loaded machine. */
const BOOT_TIMEOUT_MS = 180_000;
/** A conversion renders and reads every page in the browser, twice in the update test. */
const TEST_TIMEOUT_MS = 900_000;

if (!FOUNDRY_PRESENT && !REQUIRED) {
    console.warn(
        `[foundry-e2e] SKIPPED: no Foundry release at ${RELEASE} (set FOUNDRY_RELEASE_DIR, or FOUNDRY_INTEGRATION=required to fail)`,
    );
}

export default defineConfig({
    testDir: "e2e-foundry",
    testIgnore: FOUNDRY_PRESENT || REQUIRED ? [] : ["**/*.spec.ts"],
    workers: 1,
    retries: 0,
    timeout: TEST_TIMEOUT_MS,
    forbidOnly: process.env["CI"] !== undefined,
    reporter: [["list"]],
    expect: { timeout: 30_000 },
    use: {
        browserName: "chromium",
        // Foundry needs at least 1366 × 768, or it shows a blocking warning.
        viewport: { width: 1440, height: 900 },
        baseURL: `http://127.0.0.1:${PORT}`,
        launchOptions: {
            ...(executablePath === undefined ? {} : { executablePath }),
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader"],
        },
    },
    webServer: FOUNDRY_PRESENT
        ? [
              {
                  command: `node scripts/e2e-foundry-world.mjs ${PORT} && exec ${FOUNDRY_NODE} --require ./scripts/foundry-hostname-shim.cjs ${RELEASE}/main.js --dataPath=./.foundry-test-data-${PORT} --port=${PORT} --noupnp --headless > .foundry-test-data-${PORT}/server.log 2>&1`,
                  url: `http://127.0.0.1:${PORT}/join`,
                  reuseExistingServer: false,
                  timeout: BOOT_TIMEOUT_MS,
                  stdout: "ignore" as const,
                  stderr: "pipe" as const,
              },
          ]
        : [],
});
