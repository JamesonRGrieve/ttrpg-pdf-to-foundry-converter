// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, type Plugin } from "vite";
import { RELEASE } from "./src/version.ts";

/** Publishes the converter's release beside the page, where converted modules look for newer ones. */
function releaseFeed(): Plugin {
    return {
        name: "release-feed",
        generateBundle() {
            this.emitFile({
                type: "asset",
                fileName: "release.json",
                source: `${JSON.stringify({ release: RELEASE })}\n`,
            });
        },
    };
}

/**
 * The client-side upload page (web/). The engine runs in a module Web Worker;
 * mupdf and tesseract load WebAssembly by URL and mupdf uses top-level await,
 * hence the ES worker format and the esnext target. The OCR runtime is served
 * from web/public/vendor (staged by scripts/copy-web-assets.mjs).
 */
export default defineConfig({
    root: "web",
    base: "./",
    plugins: [releaseFeed()],
    build: {
        outDir: "../dist-web",
        emptyOutDir: true,
        target: "esnext",
    },
    worker: {
        format: "es",
    },
    optimizeDeps: {
        exclude: ["mupdf"],
    },
});
