// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, type Plugin } from "vite";
import { packageVersion, RELEASE } from "./src/version.ts";

/** The Foundry package's id, its repository, and where its releases are published. */
const PACKAGE_ID = "ttrpg-pdf-converter";
const REPOSITORY = "https://github.com/JamesonRGrieve/ttrpg-pdf-to-foundry-converter";

/**
 * The package's manifest, versioned by the converter release. Foundry reads
 * `manifest` to look for updates and `download` to install this release.
 */
function manifest(): Plugin {
    return {
        name: "foundry-manifest",
        generateBundle() {
            const body = {
                id: PACKAGE_ID,
                title: "TTRPG PDF Converter",
                description:
                    "Converts tabletop RPG PDFs you own into compendiums for the wh40k-rpg game system, inside Foundry. The conversion runs in the GM's browser and the PDF is never uploaded; converting the same book again updates the compendiums and asks before replacing anything you have edited. The package contains no book content: every value comes from your PDF.",
                // scripts/prepare-release-manifest.mjs restamps version and URLs per release channel.
                version: packageVersion(RELEASE),
                authors: [{ name: "JamesonRGrieve", url: "https://github.com/JamesonRGrieve" }],
                compatibility: { minimum: "14", verified: "14" },
                relationships: { systems: [{ id: "wh40k-rpg", type: "system" }] },
                esmodules: ["scripts/converter.js"],
                url: REPOSITORY,
                manifest: `${REPOSITORY}/releases/latest/download/module.json`,
                download: `${REPOSITORY}/releases/download/v${packageVersion(RELEASE)}/${PACKAGE_ID}.zip`,
                bugs: `${REPOSITORY}/issues`,
                license: "LICENSE",
                readme: "README.md",
            };
            this.emitFile({
                type: "asset",
                fileName: "module.json",
                source: `${JSON.stringify(body, null, 4)}\n`,
            });
        },
    };
}

/**
 * The Foundry package (foundry/): one ES module script, the engine's worker
 * beside it, and the OCR runtime under vendor/ (web/public, staged by
 * scripts/copy-web-assets.mjs). Paths are relative, so the package works
 * from Foundry's `modules/<id>/` folder.
 */
export default defineConfig({
    root: "foundry",
    base: "./",
    publicDir: "../web/public",
    plugins: [manifest()],
    build: {
        outDir: "../dist-foundry",
        emptyOutDir: true,
        target: "esnext",
        rollupOptions: {
            input: "foundry/main.ts",
            preserveEntrySignatures: false,
            output: {
                format: "es",
                entryFileNames: "scripts/converter.js",
                chunkFileNames: "scripts/[name]-[hash].js",
                assetFileNames: "scripts/assets/[name]-[hash][extname]",
            },
        },
    },
    worker: {
        format: "es",
    },
    optimizeDeps: {
        exclude: ["mupdf"],
    },
});
