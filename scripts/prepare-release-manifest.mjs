#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stamp the published version and manifest/download URLs onto the built
 * Foundry package's module.json (dist-foundry/module.json), before it is
 * zipped. Driven by .github/workflows/release.yml (both channels), as the
 * wh40k-rpg system and the cartography module do.
 *
 * Channels:
 *   nightly — the rolling prerelease under the fixed `nightly` tag. Version is
 *             the built version + the workflow run number. A prerelease is
 *             never the "latest" release alias, so both URLs use
 *             /releases/download/nightly/.
 *   release — an official versioned release cut from a `v<version>` tag, which
 *             must equal the built version (src/version.ts's RELEASE as a
 *             package version). `manifest` is the /releases/latest/ alias (so
 *             installs follow future releases); `download` is pinned to this
 *             tag, so each version's manifest on the Foundry package listing
 *             fetches its own zip.
 *
 * Env:
 *   CHANNEL        — `nightly` (default) or `release`.
 *   RUN            — nightly: the build counter (release.yml's run_number).
 *   TAG            — the release tag; nightly defaults to `nightly`, release requires `v<version>`.
 *   REPO_URL       — https://github.com/<owner>/<repo>.
 *   MANIFEST_FILE  — file to rewrite (default dist-foundry/module.json).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ZIP_NAME = "ttrpg-pdf-converter.zip";
const MANIFEST_NAME = "module.json";
const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

/**
 * The version and URL fields a channel publishes. Pure.
 * @param {string} builtVersion module.json's version as built
 * @param {{channel: string, run?: string, tag?: string, repoUrl: string}} opts
 * @returns {{version: string, manifest: string, download: string}}
 */
export function releaseFields(builtVersion, { channel, run, tag, repoUrl }) {
    if (!repoUrl) {
        throw new Error("REPO_URL is required (https://github.com/<owner>/<repo>).");
    }
    const assets = (t) => `${repoUrl}/releases/download/${t}`;

    if (channel === "release") {
        const match = RELEASE_TAG.exec(tag ?? "");
        if (!match) {
            throw new Error(`release tag must be v<version> (e.g. v2026.1111.1350), got "${tag ?? ""}".`);
        }
        // The tagged commit must carry the release it publishes, so the repo records what shipped.
        if (match[1] !== builtVersion) {
            throw new Error(
                `tag ${tag} does not match the built version ${builtVersion}; bump RELEASE before tagging.`,
            );
        }
        return {
            version: match[1],
            manifest: `${repoUrl}/releases/latest/download/${MANIFEST_NAME}`,
            download: `${assets(tag)}/${ZIP_NAME}`,
        };
    }

    if (channel !== "nightly") {
        throw new Error(`unknown CHANNEL "${channel}" (expected nightly or release).`);
    }
    const nightlyTag = tag ?? "nightly";
    return {
        version: `${builtVersion}.${run ?? "0"}`,
        manifest: `${assets(nightlyTag)}/${MANIFEST_NAME}`,
        download: `${assets(nightlyTag)}/${ZIP_NAME}`,
    };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const file = process.env.MANIFEST_FILE ?? "dist-foundry/module.json";
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    try {
        Object.assign(
            manifest,
            releaseFields(String(manifest.version), {
                channel: process.env.CHANNEL ?? "nightly",
                run: process.env.RUN,
                tag: process.env.TAG,
                repoUrl: process.env.REPO_URL,
            }),
        );
    } catch (err) {
        console.error(`prepare-release-manifest: ${err.message}`);
        process.exit(1);
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(
        `release manifest → version=${manifest.version} manifest=${manifest.manifest} download=${manifest.download}`,
    );
}
