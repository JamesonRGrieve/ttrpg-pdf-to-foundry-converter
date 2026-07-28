// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Confirms the CI gate scripts actually pass against the committed corpus, from
 * within the test suite (not just `gate:all` / CI). Read-only scanner gates
 * inspect `golden/` + the tree; the CLI-behavior gates spawn the engine and
 * write only to the OS temp dir. The heavy cold/warm determinism gate is not
 * re-run here — its guarantee is already covered byte-for-byte by
 * `golden.test.ts` and `determinism.test.ts`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGate(script: string): void {
    execFileSync("node", [join(repoRoot, "scripts", script)], { cwd: repoRoot, stdio: "pipe" });
}

describe("CI gate scripts pass against the corpus", () => {
    it("G10 dependency-pin", () => {
        expect(() => runGate("gate-dep-pin.mjs")).not.toThrow();
    });
    it("G8 timestamp scan of the golden entity files", () => {
        expect(() => runGate("gate-timestamp-scan.mjs")).not.toThrow();
    });
    it("G9 title scan against the denylist", () => {
        expect(() => runGate("gate-title-scan.mjs")).not.toThrow();
    });
    it("G13 wiki-data scan", () => {
        expect(() => runGate("gate-wiki-scan.mjs")).not.toThrow();
    });
    it("G5/G6 fail-closed refusals (spawns the CLI; writes only to tmp)", () => {
        expect(() => runGate("gate-refusals.mjs")).not.toThrow();
    }, 60_000);
});
