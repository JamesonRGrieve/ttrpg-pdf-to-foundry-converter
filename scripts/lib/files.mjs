// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Directories never scanned by CI gates (generated / vendored / regenerable). */
const IGNORED = new Set(["node_modules", ".git", "dist", ".cache", "coverage", ".vitest"]);

/** Recursively list repo-relative file paths, skipping ignored/binary trees. */
export function listFiles(root, dir = root) {
    const out = [];
    for (const entry of readdirSync(dir).sort()) {
        if (IGNORED.has(entry)) {
            continue;
        }
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listFiles(root, full));
        } else {
            out.push(relative(root, full));
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
