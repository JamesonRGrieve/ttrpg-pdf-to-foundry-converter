// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A path relative to `root`, with `/` separators on every platform (as module paths are). */
export function posixRelative(root, full) {
    return relative(root, full).split(sep).join("/");
}

/** Directories never scanned by CI gates (generated / vendored / regenerable). */
const IGNORED = new Set([
    "node_modules",
    ".git",
    "dist",
    ".cache",
    ".tmp",
    "coverage",
    ".vitest",
    // The Foundry e2e suite's local Foundry release and its throwaway worlds (third-party files, never committed),
    // and Playwright's own reports (page snapshots of whatever system a test world ran).
    ".foundry-release",
    "test-results",
    "playwright-report",
]);
/** Throwaway Foundry e2e data directories, one per test server port. */
const IGNORED_PREFIX = ".foundry-test-data-";

/** Recursively list repo-relative file paths, skipping ignored/binary trees. */
export function listFiles(root, dir = root) {
    const out = [];
    for (const entry of readdirSync(dir).sort()) {
        if (IGNORED.has(entry) || entry.startsWith(IGNORED_PREFIX)) {
            continue;
        }
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listFiles(root, full));
        } else {
            out.push(posixRelative(root, full));
        }
    }
    return out;
}

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|md|txt|typ|py)$/;

export function isText(relPath) {
    return TEXT_EXT.test(relPath);
}

export function read(root, relPath) {
    return readFileSync(join(root, relPath), "utf8");
}
