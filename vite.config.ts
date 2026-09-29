// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite";

/**
 * The client-side upload page (web/). The engine runs in a module Web Worker;
 * mupdf and tesseract load WebAssembly by URL and mupdf uses top-level await,
 * hence the ES worker format and the esnext target. The OCR runtime is served
 * from web/public/vendor (staged by scripts/copy-web-assets.mjs).
 */
export default defineConfig({
    root: "web",
    base: "./",
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
