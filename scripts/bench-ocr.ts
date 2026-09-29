// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OCR benchmark: how accurately does each reading of a PDF reproduce a verified
 * reference transcription?
 *
 *   text-layer  — the PDF's own text layer, unmodified
 *   ocr         — the embedded OCR engine's words alone
 *   arbitrated  — the text layer corrected against OCR (what the engine uses)
 *
 * The reference is a directory of per-page transcriptions named
 * `p<NNNN>.Final[.<reviewer>].md` (1-based page numbers); the highest-precedence
 * variant of each page is used. Scores are micro-averaged bag-of-words F1 over
 * the sampled pages, case-sensitive and case-insensitive.
 *
 * Usage:
 *   tsx scripts/bench-ocr.ts --pdf <file> --reference <dir> [--every 10 | --pages 10-40]
 *       [--workers N] [--cache-dir <dir>] [--json <out>] [--worst 10]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createLogger } from "../src/logger.ts";
import { FileOcrPageStore } from "../src/node/ocr-store.ts";
import { NodeTesseractEngine } from "../src/node/tesseract-node.ts";
import { arbitrate } from "../src/ocr/arbitrate.ts";
import { recognizeDocument } from "../src/ocr/recognize.ts";
import { RENDER_DPI } from "../src/ocr/render.ts";
import type { OcrPage } from "../src/ocr/types.ts";
import { extract } from "../src/stages/extract.ts";
import type { RawDoc } from "../src/types/ir.ts";
import { type BagScore, addScores, f1, markdownToText, scoreBag, tokens } from "./lib/bag-score.ts";

/** An Opus full-page sign-off wins over the arbiter's read (same order as stitch_books.py). */
const REFERENCE_PRECEDENCE = [".Final.Opus.md", ".Final.md"];

const { values } = parseArgs({
    options: {
        pdf: { type: "string" },
        reference: { type: "string" },
        every: { type: "string" },
        pages: { type: "string" },
        workers: { type: "string" },
        "cache-dir": { type: "string" },
        json: { type: "string" },
        worst: { type: "string" },
    },
});
const USAGE = "usage: bench-ocr.ts --pdf <file> --reference <dir> [--every N | --pages A-B]\n";

function usageError(): never {
    process.stderr.write(USAGE);
    process.exit(2);
}

const pdfPath: string = values.pdf ?? usageError();
const referenceDir: string = values.reference ?? usageError();
const log = createLogger("info", "bench");

function referencePage(pageIndex: number): string | null {
    const id = `p${String(pageIndex + 1).padStart(4, "0")}`;
    for (const suffix of REFERENCE_PRECEDENCE) {
        const path = join(referenceDir, `${id}${suffix}`);
        if (existsSync(path)) {
            return readFileSync(path, "utf8");
        }
    }
    return null;
}

/** Parse `--pages A-B` (or a single `A`) into its inclusive bounds. */
function pageRange(spec: string): [number, number] {
    const [first, last = first] = spec.split("-").map((n) => Number(n));
    if (first === undefined || last === undefined || !Number.isInteger(first) || !Number.isInteger(last)) {
        return usageError();
    }
    return [first, last];
}

function selectPages(total: number): number[] {
    if (values.pages !== undefined) {
        const [first, last] = pageRange(values.pages);
        const out: number[] = [];
        for (let i = first; i <= last; i += 1) {
            out.push(i);
        }
        return out.filter((i) => i >= 0 && i < total);
    }
    const every = Number(values.every ?? "10");
    return Array.from({ length: total }, (_, i) => i).filter((i) => i % every === 0);
}

function pageText(raw: RawDoc, pageIndex: number): string {
    return raw.textRuns
        .filter((r) => r.pageIndex === pageIndex)
        .map((r) => r.text)
        .join(" ");
}

const pdfBytes = new Uint8Array(readFileSync(pdfPath));
const raw = await extract(pdfBytes);
const references = new Map<number, string>();
for (const pageIndex of selectPages(raw.pages.length)) {
    const text = referencePage(pageIndex);
    if (text !== null) {
        references.set(pageIndex, markdownToText(text));
    }
}
const sample = [...references.keys()];
log.info(`${sample.length} sampled pages with a reference transcription`);

const workers = Number(values.workers ?? String(Math.max(1, Math.floor(availableParallelism() / 2))));
const engine = await NodeTesseractEngine.create(workers, RENDER_DPI);
let ocrPages: OcrPage[];
try {
    ocrPages = await recognizeDocument(
        pdfBytes,
        raw.pages.filter((p) => sample.includes(p.pageIndex)),
        engine,
        {
            store: new FileOcrPageStore(values["cache-dir"] ?? join(tmpdir(), "foundry-pdf-parser", "cache")),
            maxInFlight: workers * 2,
            log,
        },
    );
} finally {
    await engine.close();
}
const arbitrated = arbitrate(raw, ocrPages);
const ocrByPage = new Map(ocrPages.map((p) => [p.pageIndex, p.words.map((w) => w.text).join(" ")] as const));

type Mode = "text-layer" | "ocr" | "arbitrated";
const MODES: Mode[] = ["text-layer", "ocr", "arbitrated"];
const zero = (): BagScore => ({ matched: 0, candidate: 0, reference: 0 });
const perMode = <T>(make: () => T): Record<Mode, T> => ({
    "text-layer": make(),
    ocr: make(),
    arbitrated: make(),
});
const totals = { cs: perMode(zero), ci: perMode(zero) };
const perPage: { page: number; f1: Record<Mode, number> }[] = [];

for (const [pageIndex, reference] of references) {
    const readings: Record<Mode, string> = {
        "text-layer": pageText(raw, pageIndex),
        ocr: ocrByPage.get(pageIndex) ?? "",
        arbitrated: pageText(arbitrated, pageIndex),
    };
    const row = { page: pageIndex + 1, f1: perMode(() => 0) };
    for (const mode of MODES) {
        const cs = scoreBag(tokens(readings[mode], true), tokens(reference, true));
        const ci = scoreBag(tokens(readings[mode], false), tokens(reference, false));
        totals.cs[mode] = addScores(totals.cs[mode], cs);
        totals.ci[mode] = addScores(totals.ci[mode], ci);
        row.f1[mode] = f1(cs).f1;
    }
    perPage.push(row);
}

const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
const modes: Partial<Record<Mode, unknown>> = {};
const report = { engine: engine.id, pages: sample.length, modes };
process.stdout.write(`engine ${engine.id}\npages ${sample.length}\n\n`);
process.stdout.write(
    `${"mode".padEnd(12)} ${"P (cs)".padStart(8)} ${"R (cs)".padStart(8)} ${"F1 (cs)".padStart(8)}   ${"F1 (ci)".padStart(8)}\n`,
);
for (const mode of MODES) {
    const cs = f1(totals.cs[mode]);
    const ci = f1(totals.ci[mode]);
    modes[mode] = { caseSensitive: cs, caseInsensitive: ci };
    process.stdout.write(
        `${mode.padEnd(12)} ${pct(cs.precision).padStart(8)} ${pct(cs.recall).padStart(8)} ${pct(cs.f1).padStart(8)}   ${pct(ci.f1).padStart(8)}\n`,
    );
}
const worst = Number(values.worst ?? "10");
process.stdout.write(`\nworst ${worst} pages by arbitrated F1 (cs):\n`);
for (const row of [...perPage].sort((a, b) => a.f1.arbitrated - b.f1.arbitrated).slice(0, worst)) {
    process.stdout.write(
        `  p${row.page}: text ${pct(row.f1["text-layer"])}  ocr ${pct(row.f1.ocr)}  arb ${pct(row.f1.arbitrated)}\n`,
    );
}
if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify({ ...report, perPage }, null, 4)}\n`);
}
