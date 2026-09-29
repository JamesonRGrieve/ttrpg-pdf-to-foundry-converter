// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read the Foundry modules the engine writes: every `<dir>/<module id>/module.json`
 * under a root, and each declared pack's NeDB `.db` file (one JSON document
 * per line). Shared by the output audit and the validator gate.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every document of every module under `root`.
 * @param {string} root A modules directory (holding `<id>/module.json`).
 * @returns {{ module: string; pack: string; type: string; doc: Record<string, unknown> }[]}
 */
export function moduleDocuments(root) {
    const out = [];
    for (const { dir, manifest } of moduleManifests(root)) {
        for (const pack of manifest.packs ?? []) {
            const db = join(dir, `${pack.path}.db`);
            const text = existsSync(db) ? readFileSync(db, "utf8") : "";
            for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
                out.push({ module: manifest.id, pack: pack.name, type: pack.type, doc: JSON.parse(line) });
            }
        }
    }
    return out;
}

/**
 * The manifests of every module under `root`.
 * @param {string} root
 * @returns {{ dir: string; manifest: Record<string, unknown> }[]}
 */
export function moduleManifests(root) {
    if (!existsSync(root)) {
        return [];
    }
    return readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "module.json")))
        .map((e) => ({
            dir: join(root, e.name),
            manifest: JSON.parse(readFileSync(join(root, e.name, "module.json"), "utf8")),
        }))
        .sort((a, b) => (a.dir < b.dir ? -1 : 1));
}
