# foundry-pdf-parser

Turns a PDF into Foundry VTT compendium packs for the wh40k-rpg system. You give
it a PDF and nothing else. It reads the text layer, renders and OCRs every page,
corrects the text layer against what is actually printed, works out the layout
(tables, statblocks, catalogue entries, headings), and writes documents in the
system's own schema.

It runs in two places with identical results:

- **In the browser.** A static page does the whole conversion inside the tab.
  The PDF never leaves the machine.
- **From the command line** (Node ≥ 22).

Same PDF + same engine version gives byte-identical output in either.

## Hard constraints

- **The PDF is the only content input.** No profiles, no config files, no path
  or file name inspection. Besides where output and caches go, the one user
  choice is the **target schema**: which of the system's game lines (`dh2` by
  default) to write. It selects a mechanical structure — document types, field
  paths, value types and bounds — never content: a schema holds no enumerated
  entries and no per-entry values, and the user's PDF supplies every value.
- **No document identification.** The engine never works out which book or game
  line a PDF is; the target schema comes only from the user. It recognizes
  generic layout (aligned columns, captioned tables, characteristic grids, bold
  field labels under display-face headings) and maps it onto the chosen
  schema's vocabulary.
- **No third-party content ships.** No titles, names or text from any
  publication appear in the source, tests or fixtures. The fixtures are
  synthetic.
- **Encrypted PDFs are refused**, never decrypted (exit `3`, nothing written).

## Using it

```bash
pnpm install

# browser: builds and serves the upload page
pnpm web:dev

# command line: every PDF given becomes part of one module; each --target sets
# the line of the PDFs after it (an entity printed in several lines is homologated)
pnpm cli infer [--target <line>] <pdf> [[--target <line>] <pdf>…] [--out-dir <dir>] [--cache-dir <dir>] [--ocr-workers <n>]
pnpm cli batch [--target <line>] <dir> [[--target <line>] <dir>…]
```

The output is a **Foundry VTT module** that exposes the packs as compendiums of
the wh40k-rpg system:

```
<module id>/module.json            declares every pack for the wh40k-rpg system
<module id>/packs/<pack>.db        NeDB: one document per line
<module id>/assets/<id>.<ext>      extracted images the documents reference
```

Put the folder in Foundry's `Data/modules` and enable it in a world; Foundry
builds each pack's LevelDB from its `.db` file the first time the pack opens.
The CLI writes the folder under `--out-dir` (default
`<os tmp>/foundry-pdf-parser/modules/`; pointing it at `Data/modules` installs
it directly). The browser page takes any number of PDFs with one progress bar
across them all and offers the same module as a zip.

Several modules install side by side: the module id is a hash of the module's
own contents, pack names are namespaced by the module, image paths point into
the module, and nothing touches the system or other packages. Packs are named
`<line>-<book>-<category>`; the book segment comes from the PDF's own metadata
title.

## How it works

1. **Extract**: text runs (position, font, size, weight) and embedded images,
   via pinned `pdfjs-dist` and `pdf-lib`.
2. **OCR**: every page is rendered with pinned `mupdf` at 300 DPI and read by
   Tesseract's LSTM engine (pinned `tesseract.js`, plain-SIMD WASM core, pinned
   model data). All of it is served locally, never from a CDN.
3. **Arbitrate**: the text layer is kept where it is intact. OCR corrects it
   where it demonstrably fails: custom font encodings, letter-spaced display
   text, split drop caps, ligature fragments, small-caps faces (detected per
   font from the text layer itself), and text that exists only as outlines.
4. **Normalize**: canonical text, quantized geometry, gutter-based text columns,
   a total reading order.
5. **Infer**: tables are classified by header vocabulary and read row by row.
   Catalogue entries are typed by their field labels or their section heading.
   Statblocks are found by their 3×3 characteristic grid. Result tables with
   `Name: effect` rows become one item per result.
6. **Emit**: one stable JSON document per entity, with a content-derived `_id`
   and the system's cost/variant/provenance shapes, in the target line's own
   document types.
7. **Package**: the documents of every PDF in the run, merged into one module
   (`module.json` with the engine's identity in its flags, NeDB packs, assets).

The engine core (`src/`) is runtime-neutral; `src/node/` holds the CLI and its
filesystem caches, and `web/` holds the upload page and its worker.

## Checking output

- `node scripts/validate-output.mjs <modules dir>` checks the modules (packs declared
  for the system, document types it registers) and runs the wh40k-rpg system's
  own pack validators (schema, actor completeness, Zod content gate).
- `tsx scripts/audit-output.ts --output <modules dir> --reference <canonical packs> --line dh2 --book "<source book>"`
  compares against a canonical compendium tree: per-type coverage and
  field-level disagreements. Only RAW-provenance reference entries count.
- `tsx scripts/bench-ocr.ts --pdf <file> --reference <dir>` scores text-layer,
  OCR-only and arbitrated readings against verified page transcriptions.

## Tests

```bash
pnpm test            # unit, golden and determinism tests
pnpm gate:all        # dependency pins, timestamps, title denylist, refusal, cold/warm determinism
pnpm test:e2e        # browser: converts one and several fixtures in Chromium; byte-identical to the CLI goldens
node scripts/lint-ratchet.mjs   # lint warnings may only fall (baseline: .lint-baseline.json)
```

`pnpm test:e2e` uses Playwright's managed Chromium; set `E2E_CHROMIUM=/path/to/chromium`
to use an installed one.

The fixture PDFs are rendered reproducibly from `fixtures/src` by
`pnpm fixtures:render` (Typst, fixed creation timestamp); regenerate the goldens
afterwards with `pnpm golden:update`.

## License

AGPL-3.0-or-later. Every source file carries an SPDX header.
