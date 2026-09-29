#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLogger, type Logger, type LogLevel } from "../logger.ts";
import { RENDER_DPI } from "../ocr/render.ts";
import type { OcrEngine } from "../ocr/types.ts";
import { runEngine, type EngineResult } from "../run.ts";
import { EXIT, makeConfig, type ConfigOverrides, type EngineConfig, type ExitCode } from "./config.ts";
import { FileIrCache } from "./ir-cache.ts";
import { FileOcrPageStore } from "./ocr-store.ts";
import { NodeTesseractEngine } from "./tesseract-node.ts";

/**
 * CLI. The only input is a complete PDF; the engine infers everything else.
 * An encrypted input is refused with exit 3 and nothing is written.
 */

const USAGE = `foundry-pdf-parser <command> [options]

Commands:
  infer <pdf>              Convert one PDF into compendium packs.
  batch <dir> [dir...]     Convert every PDF under the directories (recursive).

Options:
  --out-dir <dir>          Pack output root (default: <tmp>/foundry-pdf-parser/packs).
  --assets-dir <dir>       Extracted image root (default: <tmp>/foundry-pdf-parser/assets).
  --cache-dir <dir>        IR/OCR cache (default: <tmp>/foundry-pdf-parser/cache).
  --asset-ref-prefix <s>   Image path prefix written into documents.
  --ocr-workers <n>        OCR threads (default: half the CPU count).
  --dry-run                Run everything but write nothing.
  --log-level <level>      debug | info | warn | error (default: info).
`;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(value: string): value is LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(value);
}

interface CliOptions {
    config: EngineConfig;
    dryRun: boolean;
}

function parseOptions(values: Record<string, string | boolean | undefined>): CliOptions | string {
    const overrides: ConfigOverrides = {};
    const str = (key: string): string | undefined => {
        const v = values[key];
        return typeof v === "string" ? v : undefined;
    };
    const outDir = str("out-dir");
    if (outDir !== undefined) {
        overrides.packsDir = outDir;
    }
    const assetsDir = str("assets-dir");
    if (assetsDir !== undefined) {
        overrides.assetsDir = assetsDir;
    }
    const cacheDir = str("cache-dir");
    if (cacheDir !== undefined) {
        overrides.cacheDir = cacheDir;
    }
    const prefix = str("asset-ref-prefix");
    if (prefix !== undefined) {
        overrides.assetRefPrefix = prefix;
    }
    const workers = str("ocr-workers");
    if (workers !== undefined) {
        const n = Number(workers);
        if (!Number.isInteger(n) || n < 1) {
            return `--ocr-workers must be a positive integer, got ${JSON.stringify(workers)}`;
        }
        overrides.ocrWorkers = n;
    }
    const level = str("log-level");
    if (level !== undefined) {
        if (!isLogLevel(level)) {
            return `--log-level must be one of ${LOG_LEVELS.join(", ")}`;
        }
        overrides.logLevel = level;
    }
    return { config: makeConfig(overrides), dryRun: values["dry-run"] === true };
}

function write(result: EngineResult, config: EngineConfig, log: Logger): void {
    for (const file of result.files) {
        const full = join(config.packsDir, file.relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, file.contents, "utf8");
    }
    for (const asset of result.assets) {
        const full = join(config.assetsDir, asset.relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, asset.bytes);
    }
    log.info(
        `wrote ${result.files.length} files to ${config.packsDir}, ${result.assets.length} assets to ${config.assetsDir}`,
    );
}

async function convert(pdfPath: string, engine: OcrEngine, opts: CliOptions, log: Logger): Promise<ExitCode> {
    const result = await runEngine(new Uint8Array(readFileSync(pdfPath)), {
        ocr: engine,
        ocrStore: new FileOcrPageStore(opts.config.cacheDir),
        irCache: new FileIrCache(opts.config.cacheDir),
        maxInFlight: opts.config.ocrWorkers * 2,
        assetRefPrefix: opts.config.assetRefPrefix,
        log,
    });
    if (result.encrypted) {
        log.error(`${basename(pdfPath)}: refused — encrypted PDF; supply a decrypted file`);
        return EXIT.ENCRYPTED;
    }
    for (const warning of result.warnings) {
        log.debug(warning);
    }
    log.info(`${basename(pdfPath)}: ${result.warnings.length} warnings (--log-level debug to list)`);
    if (!opts.dryRun) {
        write(result, opts.config, log);
    }
    return EXIT.SUCCESS;
}

function findPdfs(dirs: readonly string[]): string[] {
    const pdfs: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.toLowerCase().endsWith(".pdf")) {
                pdfs.push(full);
            }
        }
    };
    for (const dir of dirs) {
        walk(resolve(dir));
    }
    return pdfs.sort();
}

async function main(): Promise<ExitCode> {
    const [, , command, ...rest] = process.argv;
    if (command === undefined || command === "--help" || command === "-h") {
        process.stdout.write(USAGE);
        return command === undefined ? EXIT.ERROR : EXIT.SUCCESS;
    }
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            "out-dir": { type: "string" },
            "assets-dir": { type: "string" },
            "cache-dir": { type: "string" },
            "asset-ref-prefix": { type: "string" },
            "ocr-workers": { type: "string" },
            "dry-run": { type: "boolean" },
            "log-level": { type: "string" },
        },
    });
    const opts = parseOptions(values);
    if (typeof opts === "string") {
        process.stderr.write(`${opts}\n\n${USAGE}`);
        return EXIT.ERROR;
    }
    const log = createLogger(opts.config.logLevel);

    let pdfs: string[];
    const [single] = positionals;
    if (command === "infer" && positionals.length === 1 && single !== undefined) {
        pdfs = [resolve(single)];
    } else if (command === "batch" && positionals.length > 0) {
        pdfs = findPdfs(positionals);
        log.info(`batch: ${pdfs.length} PDFs`);
    } else {
        process.stderr.write(USAGE);
        return EXIT.ERROR;
    }

    const engine = await NodeTesseractEngine.create(opts.config.ocrWorkers, RENDER_DPI);
    let code: ExitCode = EXIT.SUCCESS;
    try {
        for (const pdf of pdfs) {
            const result = await convert(pdf, engine, opts, log);
            if (result !== EXIT.SUCCESS) {
                code = result;
            }
        }
    } finally {
        await engine.close();
    }
    return code;
}

main().then(
    (code) => process.exit(code),
    (err: unknown) => {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(EXIT.ERROR);
    },
);
