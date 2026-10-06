# foundry-pdf-parser

Turns a tabletop RPG PDF you own into Foundry VTT compendium packs:

- **5th edition, for the dnd5e system** (2014 or 2024 rules): classes and
  their features, subclasses, species, backgrounds and feats, with the
  system's advancement — proficiencies, features by level, scale values,
  ability score improvements — wired up. See
  [dnd5e character options](#dnd5e-character-options).
- **The wh40k-rpg system's game lines**: weapons, armour, gear, talents,
  traits, psychic powers, origin paths, NPC and vehicle statblocks and more.

You give it a PDF and nothing else. It reads the text layer, renders and OCRs
every page, corrects the text layer against what is actually printed, works out
the layout (tables, statblocks, catalogue entries, headings), and writes
documents in the system's own schema.

It runs in two places with identical results:

- **In the browser.** A static page does the whole conversion inside the tab.
  The PDF never leaves the machine. The page is published at
  <https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/> on every
  push to `main`.
- **From the command line** (Node ≥ 22.13).

Same PDF + same engine version gives byte-identical output in either.

## Notice

This is an unofficial, independent tool. It is not affiliated with, endorsed,
sponsored or approved by Wizards of the Coast, Games Workshop, Fantasy Flight
Games, Cubicle 7, Foundry Gaming, or any other publisher of a game, book or
Foundry VTT game system it can read or write for.

Dungeons & Dragons and D&D are trademarks of Wizards of the Coast LLC.
Warhammer 40,000 is a trademark of Games Workshop Limited. Foundry Virtual
Tabletop is a trademark of Foundry Gaming LLC. All other trademarks and
copyrights belong to their respective owners; game and system names appear here
only to say what the tool works with.

The tool contains no book content and ships none: you supply the PDF and every
value in the output comes from it. Use it only on PDFs you have lawfully
obtained, for your own use. A converted module contains text from your book, so
do not share, upload or redistribute it. The tool will not open encrypted
(DRM-protected) PDFs, and you should not remove protection to make one convert.

## Hard constraints

- **The PDF is the only content input.** No profiles, no config files, no path
  or file name inspection. Besides where output and caches go, the one user
  choice is the **target schema**: a dnd5e ruleset (`dnd5e-2014`,
  `dnd5e-2024`) or a wh40k-rpg game line (`dh2`, the default, `dh1`, `rt`,
  `dw`, `ow`, `bc`, `im`). It selects a mechanical structure — document types, field
  paths, value types and bounds — never content: a schema holds no enumerated
  entries and no per-entry values, and the user's PDF supplies every value.
- **No document identification.** The engine never works out which book, game
  line or ruleset a PDF is; the target schema comes only from the user. It recognizes
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
# the target of the PDFs after it (an entity printed in several wh40k-rpg lines
# is homologated). A module holds one system's packs, so a run's targets are
# all wh40k-rpg lines or all dnd5e rulesets.
pnpm cli infer [--target <id>] <pdf> [[--target <id>] <pdf>…] [--out-dir <dir>] [--cache-dir <dir>] [--ocr-workers <n>]
pnpm cli batch [--target <id>] <dir> [[--target <id>] <dir>…]
```

The output is a **Foundry VTT module** that exposes the packs as compendiums of
the targets' system:

```
<module id>/module.json            declares every pack for the system
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
`<target>-<book>-<category>`; the book segment comes from the PDF's own metadata
title.

Each module is versioned by the converter release that built it, a
`YYYY-MM-DD-HH-MM` stamp (UTC) also recorded on every pack. Its one script,
`scripts/update-check.js`, runs for the GM when a world loads: it reads the
latest release from `release.json` beside the web page and, if a newer
converter exists, says so once (for all converted modules) and offers to
rebuild. It changes nothing, stays silent offline, and has a checkbox to hide
the notice until a newer release.

## How it works

1. **Extract**: text runs (position, font, size, weight) and embedded images,
   via pinned `pdfjs-dist` and `pdf-lib`.
2. **OCR**: every page is rendered with pinned `mupdf` at 300 DPI and read by
   Tesseract's LSTM engine (pinned `tesseract.js`, plain-SIMD WASM core, pinned
   model data). A page with no text layer (a scan) is read first by PP-OCR
   (pinned PP-OCRv4 detection and recognition networks in onnxruntime-web's
   plain WebAssembly build), then by further Tesseract passes (sparse,
   binarized, inverted) that fill what it missed, and the cells of statblock
   grids read only in part are read again one by one. All of it is served
   locally, never from a CDN.
3. **Arbitrate**: the text layer is kept where it is intact. OCR corrects it
   where it demonstrably fails: custom font encodings, letter-spaced display
   text, split drop caps, ligature fragments, small-caps faces (detected per
   font from the text layer itself), and text that exists only as outlines.
4. **Normalize**: canonical text, quantized geometry, gutter-based text columns,
   a total reading order.
5. **Infer**: tables are classified by header vocabulary and read row by row.
   Catalogue entries are typed by their field labels or their section heading.
   Statblocks are found by their 3×3 characteristic grid. Result tables with
   `Name: effect` rows become one item per result. For a dnd5e target the
   engine reads character options instead (see below).
6. **Emit**: one stable JSON document per entity, with a content-derived `_id`
   and the system's cost/variant/provenance shapes, in the target's own
   document types. A document that grants another (a class its features)
   references it by compendium UUID.
7. **Package**: the documents of every PDF in the run, merged into one module
   (`module.json` with the engine's identity in its flags, NeDB packs, assets).

The engine core (`src/`) is runtime-neutral; `src/node/` holds the CLI and its
filesystem caches, and `web/` holds the upload page and its worker.

## dnd5e character options

With a `dnd5e-2014` or `dnd5e-2024` target the engine writes the dnd5e system's
character-option Items, each marked with the chosen ruleset
(`system.source.rules`). It reads the page as regions — columns, and tables set
across both columns — and the sections its headings nest, and recognizes each
option by the schema fields it carries, never by its name:

| Option        | Recognized by                                                                            | Written as                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class         | a hit-die field and a level table with Level and Features columns                        | `class`: hit die, primary ability, advancement (hit points, save/armor/weapon/skill proficiency traits, features by level, ability score improvements, a scale value per extra table column, the subclass level) |
| Class feature | a heading the level table's features column names, or `Level N: <name>`                  | `feat` (class feature), granted at its level                                                                                                                                                                     |
| Subclass      | `<…> Subclass: <name>`, or a section of the class whose subsections state their levels   | `subclass` with its features granted by level                                                                                                                                                                    |
| Species       | size and speed fields or traits; a section inside it with traits of its own is a subrace | `race`: speed, darkvision, creature type, size and ability-score advancements, traits granted as features                                                                                                        |
| Background    | skill-proficiency and equipment fields                                                   | `background`: skill proficiencies, ability scores, its feat or feature granted                                                                                                                                   |
| Feat          | an italic first line naming a feat category or a prerequisite                            | `feat` with its category, prerequisite level and repeatability                                                                                                                                                   |

Not yet read: spells (and the spells a subclass grants), equipment, monsters,
spellcasting progression, and proficiencies in specific weapons, tools and
languages (only weapon and armor categories map to the system's keys).

## Checking output

- `node scripts/validate-output.mjs <modules dir> [--system <system checkout>]` checks
  the modules (packs declared for their system, document types it registers)
  and, for wh40k-rpg modules, runs that system's own pack validators (schema,
  actor completeness, Zod content gate).
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
