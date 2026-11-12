#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Provision an isolated Foundry data directory for one Foundry e2e server:
 * `.foundry-test-data-<port>/`, with
 *   - the wh40k-rpg system, built (FOUNDRY_SYSTEM_DIST, default the sibling
 *     checkout's dist/): its static files linked, its LevelDB packs copied (a
 *     pack is locked by the one server that opens it),
 *   - this package's build (dist-foundry/), linked so the world runs it,
 *   - an empty world on that system,
 *   - Config/options.json for a headless, auth-free instance, and the
 *     release's licence.
 * Each run rebuilds the directory, so every server starts from the same state.
 *
 * Usage: node scripts/e2e-foundry-world.mjs <port>
 * Env:   FOUNDRY_RELEASE_DIR (default .foundry-release)
 *        FOUNDRY_SYSTEM_DIST (default ../.foundry-system/dist)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = resolve(ROOT, process.env.FOUNDRY_RELEASE_DIR ?? ".foundry-release");
const SYSTEM_DIST = resolve(ROOT, process.env.FOUNDRY_SYSTEM_DIST ?? "../.foundry-system/dist");
const PACKAGE_DIST = join(ROOT, "dist-foundry");
const PACKAGE_ID = "ttrpg-pdf-converter";
const SYSTEM_ID = "wh40k-rpg";
const WORLD_ID = "tpc-e2e";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
    console.error("usage: node scripts/e2e-foundry-world.mjs <port>");
    process.exit(2);
}
for (const [path, hint] of [
    [join(RELEASE, "main.js"), "point FOUNDRY_RELEASE_DIR at a Foundry v14 release"],
    [join(SYSTEM_DIST, "system.json"), "build the wh40k-rpg system, or set FOUNDRY_SYSTEM_DIST"],
    [join(PACKAGE_DIST, "module.json"), "run `pnpm foundry:build` first"],
]) {
    if (!existsSync(path)) {
        console.error(`[e2e-foundry-world] ${path} is missing: ${hint}`);
        process.exit(3);
    }
}

const DATA_ROOT = join(ROOT, `.foundry-test-data-${port}`);
const DATA = join(DATA_ROOT, "Data");
const CONFIG = join(DATA_ROOT, "Config");
rmSync(DATA_ROOT, { recursive: true, force: true });

const systemDir = join(DATA, "systems", SYSTEM_ID);
mkdirSync(systemDir, { recursive: true });
for (const entry of readdirSync(SYSTEM_DIST)) {
    const source = join(SYSTEM_DIST, entry);
    if (entry === "packs") {
        cpSync(source, join(systemDir, entry), { recursive: true });
    } else {
        symlinkSync(source, join(systemDir, entry));
    }
}

mkdirSync(join(DATA, "modules"), { recursive: true });
symlinkSync(PACKAGE_DIST, join(DATA, "modules", PACKAGE_ID));

const worldDir = join(DATA, "worlds", WORLD_ID);
mkdirSync(worldDir, { recursive: true });
const world = {
    id: WORLD_ID,
    title: "PDF Converter E2E",
    description: "Ephemeral world for the PDF converter's Foundry e2e suite.",
    system: SYSTEM_ID,
    // Foundry requires the core version a world was made with; it rewrites it on launch.
    coreVersion: "14.368",
    compatibility: { minimum: "14", verified: "14" },
};
writeFileSync(join(worldDir, "world.json"), `${JSON.stringify(world, null, 4)}\n`);

mkdirSync(CONFIG, { recursive: true });
const options = {
    port,
    hostname: "127.0.0.1",
    world: WORLD_ID,
    adminPassword: null,
    proxyPort: null,
    compressStatic: false,
    noUpdate: true,
    telemetry: false,
};
writeFileSync(join(CONFIG, "options.json"), `${JSON.stringify(options, null, 4)}\n`);
if (existsSync(join(RELEASE, "license.json"))) {
    cpSync(join(RELEASE, "license.json"), join(CONFIG, "license.json"));
} else {
    console.warn(
        `[e2e-foundry-world] ${RELEASE}/license.json is missing: Foundry may stop at its licence page`,
    );
}
console.log(`[e2e-foundry-world] ready: ${DATA_ROOT} (port ${port}, world ${WORLD_ID})`);
