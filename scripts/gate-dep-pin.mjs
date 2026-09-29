// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G10: the lockfile is present and the determinism-critical dependencies
// (text-layer extractor, page renderer, OCR engine + its model data, hashing,
// compression) are pinned EXACTLY in package.json, and src/pins.ts — which keys
// caches and stamps provenance — records those same versions. A drifting
// extractor, renderer, encoder or OCR model silently breaks byte-identity.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read } from "./lib/files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXACT = /^\d+\.\d+\.\d+$/;

const violations = [];
if (!existsSync(resolve(repoRoot, "pnpm-lock.yaml"))) {
    violations.push("pnpm-lock.yaml is missing");
}

// src/pins.ts is a flat object literal of `"name": "x.y.z"` entries.
const pinsSource = read(repoRoot, "src/pins.ts");
const pins = new Map(
    [...pinsSource.matchAll(/^\s*"?([@\w./-]+)"?:\s*"([^"]+)",?$/gmu)].map((m) => [m[1], m[2]]),
);
if (pins.size === 0) {
    violations.push("src/pins.ts declares no pins");
}

const deps = JSON.parse(read(repoRoot, "package.json")).dependencies ?? {};
for (const [name, pinned] of pins) {
    const spec = deps[name];
    if (spec === undefined) {
        violations.push(`${name} is pinned in src/pins.ts but is not a direct dependency`);
    } else if (!EXACT.test(spec)) {
        violations.push(`${name} is not pinned exactly in package.json (found "${spec}")`);
    } else if (spec !== pinned) {
        violations.push(`${name}: package.json has ${spec} but src/pins.ts has ${pinned}`);
    }
}

if (violations.length > 0) {
    process.stderr.write(`G10 dependency-pin FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
    process.exit(1);
}
process.stdout.write(`G10 dependency-pin: ${pins.size} critical deps pinned exactly and in sync\n`);
