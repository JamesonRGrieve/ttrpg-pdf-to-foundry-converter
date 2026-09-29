#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LINES } from "../infer/schema.ts";
import { DEFAULT_TARGET, targetFor, type TargetSchema } from "../infer/targets.ts";
import { createLogger, type Logger, type LogLevel } from "../logger.ts";
import { RENDER_DPI } from "../ocr/render.ts";
import type { OcrEngine } from "../ocr/types.ts";
import { runModule } from "../run.ts";
import type { BuiltModule } from "../stages/module.ts";
import { EXIT, makeConfig, type ConfigOverrides, type EngineConfig, type ExitCode } from "./config.ts";
import { FileIrCache } from "./ir-cache.ts";
import { FileOcrPageStore } from "./ocr-store.ts";
import { NodeTesseractEngine } from "./tesseract-node.ts";

/**
 * CLI. The only content input is a complete PDF; the engine infers its
 * structure, and writes it in the target schema the user chooses (`--target`).
 * An encrypted input is refused with exit 3 and nothing is written.
 */

const USAGE = `foundry-pdf-parser <command> [options]

Commands:
  infer <pdf> [pdf...]     Convert the PDFs into one Foundry module of compendium packs.
  batch <dir> [dir...]     Convert every PDF under the directories (recursive) into one module.

Options:
  --target <line>          Output schema: ${LINES.join(" | ")} (default: ${DEFAULT_TARGET.line}).
  --out-dir <dir>          Where the module is written, e.g. Foundry's Data/modules
                           (default: <tmp>/foundry-pdf-parser/modules).
  --cache-dir <dir>        IR/OCR cache (default: <tmp>/foundry-pdf-parser/cache).
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
    target: TargetSchema;
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
        overrides.modulesDir = outDir;
    }
    const cacheDir = str("cache-dir");
    if (cacheDir !== undefined) {
        overrides.cacheDir = cacheDir;
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
    const targetId = str("target");
    const target = targetId === undefined ? DEFAULT_TARGET : targetFor(targetId);
    if (target === null) {
        return `--target must be one of ${LINES.join(", ")}, got ${JSON.stringify(targetId)}`;
    }
    return { config: makeConfig(overrides), target, dryRun: values["dry-run"] === true };
}

function write(module: BuiltModule, config: EngineConfig, log: Logger): void {
    for (const file of module.files) {
        const full = join(config.modulesDir, file.relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, file.contents);
    }
    log.info(`wrote module ${module.id} (${module.files.length} files) to ${config.modulesDir}`);
}

/** Convert the PDFs into one module; exit 3 when any was refused as encrypted. */
async function convert(
    pdfPaths: readonly string[],
    engine: OcrEngine,
    opts: CliOptions,
    log: Logger,
): Promise<ExitCode> {
    const result = await runModule(
        pdfPaths.map((p) => new Uint8Array(readFileSync(p))),
        {
            target: opts.target,
            ocr: engine,
            ocrStore: new FileOcrPageStore(opts.config.cacheDir),
            irCache: new FileIrCache(opts.config.cacheDir),
            maxInFlight: opts.config.ocrWorkers * 2,
            log,
        },
    );
    for (const index of result.refused) {
        log.error(`${basename(pdfPaths[index] ?? "")}: refused — encrypted PDF; supply a decrypted file`);
    }
    for (const warning of result.warnings) {
        log.debug(warning);
    }
    log.info(`${result.warnings.length} warnings (--log-level debug to list)`);
    if (result.module !== null && !opts.dryRun) {
        write(result.module, opts.config, log);
    }
    return result.refused.length > 0 ? EXIT.ENCRYPTED : EXIT.SUCCESS;
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
            target: { type: "string" },
            "out-dir": { type: "string" },
            "cache-dir": { type: "string" },
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
    if (command === "infer" && positionals.length > 0) {
        pdfs = positionals.map((p) => resolve(p));
    } else if (command === "batch" && positionals.length > 0) {
        pdfs = findPdfs(positionals);
        log.info(`batch: ${pdfs.length} PDFs`);
    } else {
        process.stderr.write(USAGE);
        return EXIT.ERROR;
    }

    const engine = await NodeTesseractEngine.create(opts.config.ocrWorkers, RENDER_DPI);
    try {
        return await convert(pdfs, engine, opts, log);
    } finally {
        await engine.close();
    }
}

main().then(
    (code) => process.exit(code),
    (err: unknown) => {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(EXIT.ERROR);
    },
);
