// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parity harness: convert each book of a local manifest and score the output
 * against a reference compendium tree (hand-curated `_source/*.json`
 * documents). Scoring is `scripts/lib/parity.ts`.
 *
 * The manifest and every report stay local (both name the books they
 * describe): keep the manifest as `scripts/<name>.json` and reports under
 * `.tmp/` (both gitignored; the repo gates skip `.tmp`).
 *
 * Manifest:
 *   { "referenceRoot": "<compendium tree: <group>/<pack>/_source/*.json>",
 *     "cacheDir": "<optional IR/OCR cache>",
 *     "systemRoot": "<optional wh40k-rpg system checkout: its Foundry-free NPC
 *                    migrations then read both sides as the system loads them>",
 *     "books": [{ "name": "<id>", "pdf": "<path>", "target": "<target id>",
 *                 "line": "<line key>", "reference": "<source.book label>" }] }
 *
 * Usage:
 *   tsx scripts/parity.ts --manifest scripts/parity-books.json [--only a,b] [--no-run]
 *       [--out .tmp/parity] [--baseline <report.json>] [--show 10]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { moduleDocuments } from "./lib/modules.mjs";
import {
    asLoaded,
    type BookReport,
    citesBook,
    type Doc,
    type Json,
    type Loader,
    scoreBook,
} from "./lib/parity.ts";

const { values } = parseArgs({
    options: {
        manifest: { type: "string" },
        only: { type: "string" },
        "no-run": { type: "boolean" },
        out: { type: "string" },
        baseline: { type: "string" },
        show: { type: "string" },
    },
});
if (values.manifest === undefined) {
    process.stderr.write(
        "usage: parity.ts --manifest <file> [--only a,b] [--no-run] [--out dir] [--baseline file]\n",
    );
    process.exit(2);
}

interface Book {
    name: string;
    pdf: string;
    target: string;
    line: string;
    reference: string;
}
interface Manifest {
    referenceRoot: string;
    cacheDir?: string;
    systemRoot?: string;
    books: Book[];
}
const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as Manifest;

type Migration = (source: Record<string, unknown>) => void;
/** The system's own legacy NPC migrations, in the order its NPC model applies them. */
const NPC_MIGRATIONS = [
    "migrateArmourPoints",
    "migrateArmour",
    "migrateMove",
    "migrateCharacteristics",
    "migrateWeapons",
    "migrateSkills",
] as const;

/** A loader applying the system's Foundry-free NPC migrations, or the built-in reading without a system checkout. */
async function systemLoader(root: string | undefined): Promise<Loader> {
    if (root === undefined) {
        return asLoaded;
    }
    const module = (await import(join(root, "src/module/data/actor/npc-import-migration.ts"))) as Record<
        string,
        Migration | undefined
    >;
    const migrations = NPC_MIGRATIONS.map((name) => module[name]).filter(
        (m): m is Migration => m !== undefined,
    );
    return (type, system) => {
        if (type !== "npc" || typeof system !== "object" || system === null || Array.isArray(system)) {
            return system;
        }
        const source = structuredClone(system) as Record<string, unknown>;
        for (const migrate of migrations) {
            migrate(source);
        }
        return source as Json;
    };
}
const load = await systemLoader(manifest.systemRoot);
const outRoot = resolve(values.out ?? ".tmp/parity");
const SHOW = Number(values.show ?? "8");
const only = values.only === undefined ? null : new Set(values.only.split(","));
const books = manifest.books.filter((b) => only === null || only.has(b.name));

function referenceDocs(root: string): Doc[] {
    const docs: Doc[] = [];
    for (const group of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
    )) {
        if (!group.isDirectory() || group.name.startsWith("homebrew") || group.name.startsWith("_")) {
            continue;
        }
        for (const pack of readdirSync(join(root, group.name)).sort()) {
            const dir = join(root, group.name, pack, "_source");
            if (!existsSync(dir)) {
                continue;
            }
            for (const f of readdirSync(dir)
                .filter((n) => n.endsWith(".json"))
                .sort()) {
                try {
                    docs.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Doc);
                } catch {
                    // A malformed reference file is the reference's problem, not a score.
                }
            }
        }
    }
    return docs;
}

const reference = referenceDocs(manifest.referenceRoot);
const reports: Record<string, BookReport> = {};
for (const book of books) {
    const dir = join(outRoot, book.name);
    if (values["no-run"] !== true) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const args = ["tsx", "src/node/cli.ts", "infer", "--target", book.target, book.pdf, "--out-dir", dir];
        if (manifest.cacheDir !== undefined) {
            args.push("--cache-dir", manifest.cacheDir);
        }
        args.push("--ocr-workers", "4", "--log-level", "warn");
        process.stderr.write(`converting ${book.name}…\n`);
        execFileSync("npx", args, { stdio: ["ignore", "ignore", "inherit"] });
    }
    const output = moduleDocuments(dir).map(
        ({ type, doc }) => ("type" in doc ? doc : { ...doc, type }) as Doc,
    );
    // Untyped reference documents are journal chapters: prose the engine does not emit as documents.
    const refs = reference.filter(
        (d) => typeof d["type"] === "string" && d["type"] !== "" && citesBook(d, book.line, book.reference),
    );
    reports[book.name] = scoreBook(refs, output, book.line, load);
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}`;
const baseline =
    values.baseline !== undefined && existsSync(values.baseline)
        ? (JSON.parse(readFileSync(values.baseline, "utf8")) as Record<string, BookReport>)
        : null;
const delta = (now: number, was: number | undefined): string =>
    was === undefined ? "" : ` (${now - was >= 0 ? "+" : ""}${pct(now - was)})`;

let refTotal = 0;
let scoreTotal = 0;
let mechTotal = 0;
for (const [name, r] of Object.entries(reports)) {
    const was = baseline?.[name];
    refTotal += r.reference;
    scoreTotal += r.score * r.reference;
    mechTotal += r.mechanicsScore * r.reference;
    process.stdout.write(
        `\n# ${name}: ref ${r.reference} out ${r.output} matched ${r.matched}  score ${pct(r.score)}${delta(r.score, was?.score)}  mechanics ${pct(r.mechanicsScore)}${delta(r.mechanicsScore, was?.mechanicsScore)}\n`,
    );
    process.stdout.write(
        `${"type".padEnd(20)}${"ref".padStart(5)}${"out".padStart(5)}${"match".padStart(6)}${"mistyp".padStart(7)}${"extra".padStart(6)}${"score".padStart(7)}${"mech".padStart(7)}${"desc".padStart(7)}\n`,
    );
    for (const [type, t] of Object.entries(r.types).sort((a, b) => b[1].reference - a[1].reference)) {
        const wt = was?.types[type];
        process.stdout.write(
            `${type.padEnd(20)}${String(t.reference).padStart(5)}${String(t.output).padStart(5)}${String(t.matched).padStart(6)}${String(t.misTyped.length).padStart(7)}${String(t.extra.length).padStart(6)}${pct(t.docScore).padStart(7)}${pct(t.mechanicsScore).padStart(7)}${(t.descriptionF1.n === 0 ? "-" : pct(t.descriptionF1.sum / t.descriptionF1.n)).padStart(7)}${wt === undefined ? "" : delta(t.docScore, wt.docScore)}\n`,
        );
    }
    if (SHOW > 0) {
        for (const [type, t] of Object.entries(r.types)) {
            const worst = Object.entries(t.fields)
                .filter(([, f]) => f.score < f.checks)
                .sort((a, b) => b[1].checks - b[1].score - (a[1].checks - a[1].score))
                .slice(0, SHOW);
            if (worst.length === 0) {
                continue;
            }
            process.stdout.write(
                `  ${type} worst fields: ${worst.map(([p, f]) => `${p} ${f.score.toFixed(0)}/${f.checks}`).join(", ")}\n`,
            );
        }
    }
}
// Across books: per type, and the leaves losing the most score (a missing document loses one whole document).
const agg = new Map<
    string,
    { ref: number; matched: number; score: number; mech: number; misTyped: number; extra: number }
>();
const loss = new Map<string, number>();
for (const r of Object.values(reports)) {
    for (const [type, t] of Object.entries(r.types)) {
        const a = agg.get(type) ?? { ref: 0, matched: 0, score: 0, mech: 0, misTyped: 0, extra: 0 };
        a.ref += t.reference;
        a.matched += t.matched;
        a.score += t.docScore * t.reference;
        a.mech += t.mechanicsScore * t.reference;
        a.misTyped += t.misTyped.length;
        a.extra += t.extra.length;
        agg.set(type, a);
        const unmatched = t.reference - t.matched;
        if (unmatched > 0) {
            loss.set(`${type} <document missing>`, (loss.get(`${type} <document missing>`) ?? 0) + unmatched);
        }
        for (const [field, f] of Object.entries(t.fields)) {
            // A field's loss is spread over the leaves of each document; weight by the type's mean leaf count.
            const leavesPerDoc =
                Object.values(t.fields).reduce((s, x) => s + x.checks, 0) / Math.max(1, t.matched);
            const lost = (f.checks - f.score) / leavesPerDoc;
            if (lost > 0) {
                loss.set(`${type} ${field}`, (loss.get(`${type} ${field}`) ?? 0) + lost);
            }
        }
    }
}
process.stdout.write(
    `\n# ALL BOOKS\n${"type".padEnd(20)}${"ref".padStart(6)}${"match".padStart(6)}${"mistyp".padStart(7)}${"extra".padStart(6)}${"score".padStart(7)}${"mech".padStart(7)}\n`,
);
for (const [type, a] of [...agg].sort((x, y) => y[1].ref - x[1].ref)) {
    if (a.ref === 0) {
        continue;
    }
    process.stdout.write(
        `${type.padEnd(20)}${String(a.ref).padStart(6)}${String(a.matched).padStart(6)}${String(a.misTyped).padStart(7)}${String(a.extra).padStart(6)}${pct(a.score / a.ref).padStart(7)}${pct(a.mech / a.ref).padStart(7)}\n`,
    );
}
process.stdout.write("\n# BIGGEST LOSSES (document-equivalents of score)\n");
for (const [what, n] of [...loss].sort((a, b) => b[1] - a[1]).slice(0, Math.max(SHOW, 1) * 5)) {
    process.stdout.write(`${n.toFixed(1).padStart(8)}  ${what}\n`);
}
if (refTotal > 0) {
    process.stdout.write(
        `\nOVERALL ref ${refTotal}: score ${pct(scoreTotal / refTotal)}  mechanics ${pct(mechTotal / refTotal)}\n`,
    );
}
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, "report.json"), `${JSON.stringify(reports, null, 1)}\n`);
