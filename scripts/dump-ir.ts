// SPDX-License-Identifier: AGPL-3.0-or-later
// Dev tool: dump the normalized IR for a PDF so profile authors can see the
// real font names, size buckets, columns, and per-run geometry to target.
import { readFileSync } from "node:fs";
import { createLogger } from "../src/logger.ts";
import { extract } from "../src/stages/extract.ts";
import { recoverImages } from "../src/stages/images.ts";
import { normalize } from "../src/stages/normalize.ts";

const path = process.argv[2];
if (path === undefined) {
    process.stderr.write("usage: tsx scripts/dump-ir.ts <pdf>\n");
    process.exit(1);
}

const raw = await extract(new Uint8Array(readFileSync(path)));
if (raw.encrypted) {
    process.stderr.write("encrypted\n");
    process.exit(3);
}
const ir = normalize(raw);
process.stdout.write(`fonts: ${JSON.stringify(ir.fonts)}\n`);
process.stdout.write(`sizeBuckets: ${JSON.stringify(ir.sizeBuckets)}\n`);
process.stdout.write(`fingerprint: ${JSON.stringify(ir.fingerprint)}\n`);
process.stdout.write(`images: ${raw.images.length}, placements: ${raw.placements.length}\n`);
const assets = recoverImages(raw, createLogger("warn"));
process.stdout.write(`--- recovered assets (${assets.assets.length}) ---\n`);
for (const a of assets.assets) {
    process.stdout.write(
        `  ${a.assetId}.${a.ext} ${a.width}x${a.height} bytes=${a.bytes.length} from=[${a.sourceObjectIds.join(",")}]\n`,
    );
}
process.stdout.write(
    `placements→asset: ${JSON.stringify(assets.placements.map((p) => [p.assetId, p.pageIndex, p.bbox.map((n) => Math.round(n))]))}\n`,
);
process.stdout.write(`--- runs (${ir.runs.length}) ---\n`);
for (const r of ir.runs) {
    process.stdout.write(
        `p${r.pageIndex} col${r.column} band${r.band} x${r.x} y${r.y} ind${r.indent} ${r.weight}${r.italic ? "/it" : ""} sz${r.size} [${r.font}] ${JSON.stringify(r.text)}\n`,
    );
}
