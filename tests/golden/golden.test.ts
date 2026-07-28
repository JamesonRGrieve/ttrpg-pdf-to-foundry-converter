// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifest, runCase } from "../../scripts/lib/run-case.ts";

/**
 * Golden gate (spec §13 G4): fixture output must match `golden/` exactly, byte
 * for byte, across every case in the manifest. Regenerate goldens only via
 * `pnpm golden:update` in a dedicated commit when a change legitimately moves them.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string): string[] {
    const out: string[] = [];
    const recurse = (current: string): void => {
        for (const entry of readdirSync(current).sort()) {
            const full = join(current, entry);
            if (statSync(full).isDirectory()) {
                recurse(full);
            } else {
                out.push(relative(dir, full));
            }
        }
    };
    recurse(dir);
    return out;
}

describe("golden output", () => {
    for (const entry of loadManifest(repoRoot)) {
        it(`${entry.name} matches golden/ byte-for-byte`, async () => {
            const output = await runCase(entry, repoRoot);
            const goldenDir = resolve(repoRoot, "golden", entry.name);
            const goldenFiles = walk(goldenDir);

            // Same set of files — no extras, none missing.
            expect([...output.keys()].sort()).toEqual([...goldenFiles].sort());

            for (const rel of goldenFiles) {
                const golden = new Uint8Array(readFileSync(join(goldenDir, rel)));
                const actual = output.get(rel);
                expect(actual, `missing output for ${rel}`).toBeDefined();
                expect(
                    Buffer.from(actual!).equals(Buffer.from(golden)),
                    `byte mismatch in ${entry.name}/${rel}`,
                ).toBe(true);
            }
        });
    }
});
