#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { makeConfig, EXIT, type ConfigOverrides, type ExitCode } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { runPipeline } from "./pipeline.ts";
import { detect } from "./stages/detect.ts";
import { extract } from "./stages/extract.ts";
import { normalize } from "./stages/normalize.ts";
import { loadProfile, loadProfilesDir } from "./profile/load.ts";
import { HttpWikiClient } from "./enrich/mediawiki.ts";
import { localizeImages, ttyConfirm } from "./enrich/localize.ts";
import { sha256Hex } from "./util/hash.ts";

/**
 * CLI (spec §7.3, §16). Fails closed: `run` without `--profile` in
 * non-interactive mode exits 2 (A1); an encrypted input exits 3 (§4); unmatched
 * required fields exit 1 (§8.6). There is no entry point that starts from an
 * intermediate — the only input is a complete PDF (§16.10).
 */

const USAGE = `foundry-pdf-parser <command> [options]

Commands:
  run <pdf> --profile <path>     Parse a PDF into the pack corpus.
  detect <pdf>                   Show metadata + ranked profile suggestions (advisory).
  validate-profile <path>        Validate a profile against the schema.

Options for run:
  --profile <path>        Required. Profile file (YAML/JSON).
  --repo-root <dir>       Engine repo root (default: cwd). Anchors default paths.
  --packs-dir <dir>       Output pack corpus root.
  --assets-dir <dir>      Extracted image asset root.
  --cache-dir <dir>       Intermediate cache dir.
  --asset-ref-prefix <s>  Image reference prefix written into documents.
  --enrich                Enable Tier C wiki link enrichment (off by default).
  --refresh-enrichment    Re-resolve enrichment (otherwise the lockfile is used).
  --offline               Hard-disable all network access.
  --localize-images       Download resolved wiki images (interactive confirm required).
  --dry-run               Compute output but do not write to disk.
  --log-level <level>     debug | info | warn | error (default: info).
`;

interface CommonOverrides extends ConfigOverrides {
    repoRoot: string;
}

function collectOverrides(values: Record<string, unknown>): CommonOverrides {
    const overrides: CommonOverrides = { repoRoot: resolve(String(values["repo-root"] ?? process.cwd())) };
    if (typeof values["packs-dir"] === "string") {
        overrides.packsDir = resolve(values["packs-dir"]);
    }
    if (typeof values["assets-dir"] === "string") {
        overrides.assetsDir = resolve(values["assets-dir"]);
    }
    if (typeof values["cache-dir"] === "string") {
        overrides.cacheDir = resolve(values["cache-dir"]);
    }
    if (typeof values["asset-ref-prefix"] === "string") {
        overrides.assetRefPrefix = values["asset-ref-prefix"];
    }
    if (typeof values["log-level"] === "string") {
        overrides.logLevel = values["log-level"] as NonNullable<ConfigOverrides["logLevel"]>;
    }
    overrides.enrich = values["enrich"] === true;
    overrides.refreshEnrichment = values["refresh-enrichment"] === true;
    overrides.offline = values["offline"] === true;
    overrides.localizeImages = values["localize-images"] === true;
    return overrides;
}

function writeResultToDisk(
    result: Awaited<ReturnType<typeof runPipeline>>,
    packsDir: string,
    assetsDir: string,
    cacheDir: string,
    log: Logger,
): void {
    for (const file of result.files) {
        const full = join(packsDir, file.relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, file.contents, "utf8");
    }
    for (const prov of result.provenance) {
        const full = join(packsDir, prov.relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, prov.contents, "utf8");
    }
    for (const asset of result.assets) {
        const full = join(assetsDir, asset.relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, asset.bytes);
    }
    if (result.enrichmentReport !== null) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, "enrichment-report.md"), result.enrichmentReport, "utf8");
    }
    log.info(`wrote ${result.files.length} documents, ${result.assets.length} assets`);
}

async function cmdRun(positionals: string[], values: Record<string, unknown>): Promise<ExitCode> {
    const pdfPath = positionals[0];
    const profilePath = typeof values["profile"] === "string" ? values["profile"] : null;
    const overrides = collectOverrides(values);
    const config = makeConfig(overrides.repoRoot, overrides);
    const log = createLogger(config.logLevel);

    if (pdfPath === undefined) {
        log.error("run requires a <pdf> argument");
        return EXIT.ERROR;
    }
    // Fail closed: no profile in non-interactive mode (A1 / §7.3).
    if (profilePath === null) {
        log.error("run requires --profile <path>; the engine produces no output without a profile");
        return EXIT.NO_PROFILE;
    }

    const profileBytes = readFileSync(profilePath);
    const profile = loadProfile(profilePath);
    const pdfBytes = new Uint8Array(readFileSync(pdfPath));
    const client = config.enrich ? new HttpWikiClient({ offline: config.offline }) : null;

    const result = await runPipeline(
        pdfBytes,
        profile,
        { sha256: sha256Hex(new Uint8Array(profileBytes)), sourceBasename: basename(pdfPath) },
        config,
        log,
        client,
    );

    if (result.encrypted) {
        log.error("refused: encrypted PDF; supply a decrypted file");
        return EXIT.ENCRYPTED;
    }

    for (const warning of result.warnings) {
        log.warn(warning);
    }
    if (values["dry-run"] !== true) {
        writeResultToDisk(result, config.packsDir, config.assetsDir, config.cacheDir, log);
    }

    if (config.localizeImages) {
        if (!config.enrich) {
            log.warn("--localize-images requires --enrich; nothing to localize");
        } else {
            await localizeImages(
                {
                    lockfilePath: config.lockfilePath,
                    localizedDir: resolve(config.assetsDir, "..", "localized"),
                    offline: config.offline,
                    confirm: ttyConfirm,
                },
                log,
            );
        }
    }

    if (result.errors.length > 0) {
        for (const err of result.errors) {
            log.error(err);
        }
        return EXIT.ERROR;
    }
    return EXIT.SUCCESS;
}

async function cmdDetect(positionals: string[], values: Record<string, unknown>): Promise<ExitCode> {
    const pdfPath = positionals[0];
    const overrides = collectOverrides(values);
    const config = makeConfig(overrides.repoRoot, overrides);
    const log = createLogger(config.logLevel);
    if (pdfPath === undefined) {
        log.error("detect requires a <pdf> argument");
        return EXIT.ERROR;
    }
    const raw = await extract(new Uint8Array(readFileSync(pdfPath)));
    if (raw.encrypted) {
        log.error("refused: encrypted PDF; supply a decrypted file");
        return EXIT.ENCRYPTED;
    }
    const ir = normalize(raw);
    const profiles = loadProfilesDir(config.profilesDir);
    const detection = detect(ir, profiles);
    process.stdout.write(`Detected metadata title: ${JSON.stringify(detection.metadata.title)}\n`);
    process.stdout.write("Suggested profiles:\n");
    detection.suggestions.forEach((s, i) => {
        process.stdout.write(
            `  ${i + 1}. ${s.name} (${s.profileId}) — fingerprint match ${s.score.toFixed(2)}\n`,
        );
    });
    process.stdout.write("  [ ] None — select a profile file with --profile\n");
    return EXIT.SUCCESS;
}

function cmdValidateProfile(positionals: string[]): ExitCode {
    const path = positionals[0];
    const log = createLogger("info");
    if (path === undefined) {
        log.error("validate-profile requires a <path> argument");
        return EXIT.ERROR;
    }
    try {
        const profile = loadProfile(path);
        process.stdout.write(
            `OK: ${profile.profile_id} v${profile.version} (${profile.blocks.length} blocks)\n`,
        );
        return EXIT.SUCCESS;
    } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        return EXIT.ERROR;
    }
}

async function main(): Promise<void> {
    const [, , command, ...rest] = process.argv;
    if (command === undefined || command === "--help" || command === "-h") {
        process.stdout.write(USAGE);
        process.exit(command === undefined ? EXIT.ERROR : EXIT.SUCCESS);
    }

    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            profile: { type: "string" },
            "repo-root": { type: "string" },
            "packs-dir": { type: "string" },
            "assets-dir": { type: "string" },
            "cache-dir": { type: "string" },
            "asset-ref-prefix": { type: "string" },
            "log-level": { type: "string" },
            enrich: { type: "boolean" },
            "refresh-enrichment": { type: "boolean" },
            offline: { type: "boolean" },
            "localize-images": { type: "boolean" },
            "dry-run": { type: "boolean" },
        },
    });

    let code: ExitCode;
    try {
        switch (command) {
            case "run":
                code = await cmdRun(positionals, values);
                break;
            case "detect":
                code = await cmdDetect(positionals, values);
                break;
            case "validate-profile":
                code = cmdValidateProfile(positionals);
                break;
            default:
                process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
                code = EXIT.ERROR;
                break;
        }
    } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        code = EXIT.ERROR;
    }
    process.exit(code);
}

void main();
