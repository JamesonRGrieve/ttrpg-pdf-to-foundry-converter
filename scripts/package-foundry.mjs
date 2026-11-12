// SPDX-License-Identifier: AGPL-3.0-or-later
// Finish the Foundry package built into dist-foundry/: add its licence and
// readme, and zip it as the release asset Foundry installs from
// (dist-foundry-release/ttrpg-pdf-converter.zip, beside a copy of module.json,
// the manifest Foundry checks for updates).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "dist-foundry");
const release = join(repoRoot, "dist-foundry-release");
const PACKAGE_ID = "ttrpg-pdf-converter";

copyFileSync(join(repoRoot, "LICENSE"), join(dist, "LICENSE"));
copyFileSync(join(repoRoot, "README.md"), join(dist, "README.md"));

/** Every file under `dir`, sorted, as paths relative to it. */
function files(dir) {
    return readdirSync(dir)
        .sort()
        .flatMap((name) => {
            const full = join(dir, name);
            return statSync(full).isDirectory() ? files(full).map((f) => join(name, f)) : [name];
        });
}

// A fixed entry time keeps the zip's bytes a function of its contents.
const mtime = new Date(1980, 0, 2, 12, 0, 0);
const entries = {};
for (const file of files(dist)) {
    entries[relative(dist, join(dist, file)).split("\\").join("/")] = [
        new Uint8Array(readFileSync(join(dist, file))),
        { mtime },
    ];
}
mkdirSync(release, { recursive: true });
writeFileSync(join(release, `${PACKAGE_ID}.zip`), zipSync(entries, { level: 9 }));
copyFileSync(join(dist, "module.json"), join(release, "module.json"));
process.stdout.write(
    `packaged ${Object.keys(entries).length} files into dist-foundry-release/${PACKAGE_ID}.zip\n`,
);
