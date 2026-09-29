# foundry-pdf-parser — Project Standards

## What This Tool Is

A **generic, self-inferring PDF → Foundry VTT compendium** utility. It takes
**only official PDFs** as input, plus the user's choice of target schema (which
game line's mechanical structure to write). No profiles, no other user-supplied
configuration, no document-specific identification systems. The engine looks at
the PDF, figures out what's in it by analyzing layout and content structure, and
produces Foundry VTT compendium JSON in the chosen schema.

Same PDF + same target schema + same engine version = deterministic output.

## Hard Constraints (Non-Negotiable)

1. **Input is a PDF, plus the user's choice of target schema.** The sole
   content input is a complete PDF file. There is no `--from-markdown`, no
   `--profile`, no config file, no user-supplied patterns. PDFs are uploaded
   directly by users — the engine infers the document's structure from PDF
   content (typography, layout). It never reads the filesystem path to
   determine what the PDF is. The one other input is the **target schema**
   (see "Target Schema Selection"): an output-format choice the user makes,
   never something the engine infers.

2. **Zero document-specific identification.** The engine ships no fingerprints,
   no title matching, no ISBN databases, no product-specific selectors. It
   recognizes **generic structural patterns** (tables, stat blocks, entry lists,
   section headings) from typography and layout alone. It does not know or care
   what specific book it is processing.

3. **Legally distributable as a generic utility.** The tool must pass every legal
   bar for distribution. It contains no copyrighted content, no content-specific
   targeting, no commercial product metadata. It is a format converter — like
   Calibre, pandoc, or ffmpeg — that operates on user-owned files for personal
   use.

4. **The OCR pipeline is internal, not a separate step.** The engine renders PDF
   pages to images and runs deterministic OCR internally as part of its own
   processing. This exists because **the PDF text layer has errors** — the OCR
   output cross-referenced against the text layer produces the corrected read.
   The existing stitched markdown corpus (in `pdfs/books/`) serves only as a
   **validation oracle** — ground truth to verify the engine's own OCR+inference
   produces correct results. It is never an input to the production pipeline.

5. **Outputs go to tmp.** During development, all outputs land in a temporary
   directory for comparison against the canonical compendium corpus. The
   canonical compendiums are never mutated. The PDFs folder (containing extracted
   images and canonical markdown) is never mutated.

## Architecture

```
PDF ──→ [Render pages to images]
           │
           ├──→ [OCR ensemble: multiple models, deterministic]
           │        produces per-page text with layout
           │
           ├──→ [PDF text layer extraction]
           │        raw text runs with font/size/position
           │
           └──→ [Cross-reference + arbitrate]
                    corrected text with full structural metadata
                         │
                         ▼
                [Structural inference]
                    detect tables, stat blocks, entry lists,
                    section hierarchy — from typography and
                    spatial layout, NOT from content knowledge
                         │
                         ▼
                [Content classification]
                    what type of content is each region?
                    recognized from column headers, field
                    patterns, numeric layouts — using only
                    the Foundry system schema vocabulary
                         │
                         ▼
                [Entity extraction]
                    parse typed values from classified regions
                         │
                         ▼
                [Foundry VTT output]
                    produce compendium JSON in the standard
                    Foundry document format
```

## The OCR Layer

The PDF text layer in many TTRPG books contains errors (garbled characters,
column bleed, wrong reading order, decorative font misreads). The engine
therefore does NOT trust the text layer alone. It:

1. Renders each page to an image (deterministic, pinned renderer + DPI)
2. Runs one or more OCR models against the image
3. Cross-references the OCR read against the PDF text layer
4. Arbitrates disagreements (majority vote + known model strengths)
5. Produces a corrected text representation with full layout metadata

This is internal to the engine. The user does not interact with it. They pass a
PDF; they get compendium JSON.

## Vocabulary Rules

### What IS allowed in source code

- **Foundry VTT system schema terms.** The wh40k-rpg Foundry system is our own
  open-source project. Its schema defines generic TTRPG terms: `weapon`, `armour`,
  `talent`, `trait`, `skill`, `psychic-power`, `ws`, `bs`, `damage`, `range`,
  `penetration`, `clip`, `reload`, `tier`, `prerequisite`, `aptitude`, etc. These
  are the tool's **output format vocabulary** — like knowing field names in a file
  format spec. They may appear in classifiers, extractors, and output mappers.

- **Runtime font analysis.** The engine MAY detect, log, and cross-reference font
  names at runtime. Fonts are structural metadata embedded in the PDF — using them
  for detection (e.g. "numeric runs in a font different from the body text font"
  or "bold text in the same font as other stat-grid labels") is structural
  analysis, not content targeting. The engine discovers font roles dynamically
  from each PDF it processes.

### What is NOT allowed in source code

- **Hardcoded font names.** No string literals like `"berylium"`,
  `"caslonantique"`, `"timesnewroman"` etc. in the source. The engine must not
  check `font.includes("berylium")` — that ties the code to a specific product's
  font choices. Instead, detect font roles structurally: "the most common font is
  body text; a different bold font at a distinct size carries stat values." This
  is discovered at runtime from ANY PDF.

- **Copyrighted content vocabulary.** No lists of specific creature names, book
  titles, ISBNs, publisher names, or any text that originates from the copyrighted
  source material.

- **Content-derived word lists for classification.** No hardcoded lists that
  exist only because a specific product uses those words (e.g. a list of weapon
  names, spell names, or location names from a specific book).

### The distinction

| OK (system schema / structural)        | NOT OK (document-specific)                     |
| -------------------------------------- | ---------------------------------------------- |
| `"weapon"`, `"armour"`, `"talent"`     | `"berylium"`, `"caslonantique-bold-sc700"`     |
| `"damage"`, `"range"`, `"penetration"` | `"<weapon name>"`, `"<creature name>"`         |
| `"ws"`, `"bs"`, `"s"`, `"t"`, `"ag"`   | `"<game line title>"`, `"<publisher name>"`    |
| `font !== bodyFont` (runtime)          | `font.includes("berylium")` (hardcoded)        |
| `run.weight === "bold"` (structural)   | `run.font === "caslonantique-bold"` (targeted) |

## Structural Inference (How It Works Without Profiles)

The engine recognizes content from **generic layout patterns** and **runtime font
analysis**, not from knowing what book it's reading:

- **Tables**: Detected by aligned columns of text with a header row (distinct
  font weight). Column semantics classified using system-schema terms (e.g. a
  column header matching "DAM" or "DAMAGE" → weapon damage field).

- **Stat blocks / numeric grids**: Detected by clusters of bold numeric runs in
  a non-body font, arranged in a 3×3 grid with short text labels above. The
  specific font is discovered at runtime — "which font carries the grid values"
  is inferred from font frequency analysis, not hardcoded.

- **Entry lists**: Detected by repeating [bold header → structured body]
  patterns. Structured fields (bold-label: value lines) are recognized
  structurally; their labels are matched against system-schema terms.

- **Section hierarchy**: Detected from heading font sizes (larger = higher
  level). Chapter → section → subsection → entry.

- **Descriptions**: Prose paragraphs associated with entries by proximity and
  section structure.

## Foundry Output Schema

The engine classifies and maps extracted content using the **Foundry VTT system
schema** (wh40k-rpg). This is output-format knowledge — the tool knows what
fields a Foundry weapon Item or Actor document expects, the same way a word
processor knows what .docx fields look like.

System-schema field paths (`system.damage.formula`, `system.characteristics.ws`,
`system.prerequisites.text`) are used in extractors and output mappers. These are
from our own open-source Foundry system, not from any copyrighted publication.

## Output: A Foundry Module

A run takes one or more PDFs (the browser page: any number, with one progress
bar across them) and writes **one Foundry VTT module** that exposes their
packs as compendiums of the wh40k-rpg system: `module.json`, NeDB
`packs/<pack>.db` files (Foundry builds LevelDB from them on first open) and
`assets/`. Document types are the target line's own registered types.

Modules must **coexist**: any number can be installed together, and none may
compete with another or with the system. The module id is a hash of the
module's own content (never of the input files), pack names are namespaced by
the module, image paths point into the module, and a module touches no global
state — no scripts, no settings, no overrides.

## Target Schema Selection

The user picks the **target schema** the output is written in: one of the
wh40k-rpg system's game lines (`dh2`, `dh1`, `rt`, `dw`, `ow`, `bc`, `im`).
The default is the system's default line, `dh2`. The choice selects which
**mechanical structure** the extracted values are mapped into — the line's
document types, field paths, value types and bounds — the same
uncopyrightable system/method-of-operation structure the Foundry system itself
ships. It is an output-format choice, like choosing .docx or .odt.

- **The engine never infers the target.** It does not look at a PDF to decide
  which line it belongs to (hard constraint 2 still holds in full). The target
  comes only from the user.
- **Switching is structural only.** The selector resolves to a set of field
  mappings — nothing else. There is no per-book logic and no per-book branch.
- **A schema definition is empty structure.** It holds field names, types,
  bounds and cardinality, and nothing populated: no enumerated careers,
  origins, skills, talents, weapons or gear; no per-entry values keyed to
  publication names. The test: if a schema file could be reconstructed into
  a book's content, it is not a schema — it is the compendium with the prose
  stripped, and it does not ship. The user's PDF supplies every value.
- **Line identifiers are descriptive target labels** (`dh2`, `rt`), the system's
  own pack-line keys — never product branding.

Same PDF + same target schema + same engine version = deterministic output.

## Validation and Error Resolution

### Truth hierarchy

**Page PNG (ground truth) > OCR markdown > canonical compendiums.**

No source is infallible. The OCR markdown can have transcription errors. The
canonical compendiums can be incomplete or contain wrong values. A discrepancy
between the engine's output and either source is a **mystery to investigate**,
not a number to blindly match.

### When the engine disagrees with the markdown

Check the page PNG. If the markdown is wrong, correct `text/<page-id>.Final.md`
against the PNG. Once the WHOLE page is audited (every statblock on all five
dimensions, and every non-actor item on the page placed in a pack), rename it
to `text/<page-id>.Final.Opus.md` and re-stitch the book
(`python3 ~/Source/pdfs/ocr/stitch_books.py`). `stitch_books.py` prefers the
`.Final.Opus.md` read, and a `.Final.Opus.md` page is never re-opened. Full rules
are in the `audit-wh40k-actors` skill ("Sign-off convention").

### When the engine disagrees with the canonical compendiums

The compendiums may be **incomplete** (missing entities the book contains) or
**wrong** (values that don't match the book). Check the markdown and/or the
page PNG. If the compendium is wrong or missing content, fix the compendium.
The "do not mutate canonical compendiums" development rule is a safety rail
against accidental corruption, not a prohibition against correcting genuine
errors discovered during verification.

### What "verified" means

The engine's output is verified by comparison, not by identity:

- Every entity the engine extracts should either (a) match a canonical entity,
  or (b) be legitimate content the canonical corpus doesn't yet include.
- Every canonical entity should either (a) be found in the engine's output,
  or (b) be a type the engine doesn't yet extract (with a tracked TODO).
- Discrepancies in mechanical values (characteristics, damage, etc.) are
  investigated against the page PNG — the correct value goes into both the
  engine output AND the canonical corpus.
- All discovered discrepancies (name mismatches, derived composites,
  no-source stubs, wrong page citations, cross-game-line content) are
  documented in `.foundry-system/src/packs-private/DISCREPANCIES.md`. Update it
  when new discrepancies are found or existing ones are resolved.
- `_id` values, multi-system data from other game lines, and image paths
  are expected differences (not failures).

## Development Rules

- All outputs go to `/tmp/foundry-pdf-parser/` or similar — NEVER write to the
  canonical compendiums or the PDFs folder.
- No profiles, no config files, no user-defined patterns. The one user choice
  is the target schema, and it switches structure only (see "Target Schema
  Selection").
- No hardcoded font names — discover font roles at runtime.
- System-schema vocabulary (output format terms) is allowed in source.
- **No copyrighted content in source.** Entity names, book-specific text, or any
  values from the copyrighted material must NOT appear in the engine source code.
  Verification scripts that compare output against the canonical corpus are fine
  (that's comparing output, not building input), but the engine itself must not
  contain copyrighted strings to match against.
- Every structural recognition pattern must be generic (applicable to any PDF
  with similar layout conventions).

## Fixing discrepancies

When the engine produces wrong names or values, the preferred fix order is:

1. **Fix the OCR** — If the stitched markdown has a wrong name (e.g. a plural
   heading where the page prints a fuller singular name), correct that page's markdown against
   the PNG and, once the page is fully audited, sign it off as
   `<page-id>.Final.Opus.md` (see "When the engine disagrees with the markdown"
   above). The engine will then pick up the correct name automatically on next run.

2. **Fix the engine's structural detection** — If the engine misreads a grid,
   misclassifies a table, or garbles a name during IR processing, fix the
   detection heuristics (generically, not with content-specific patches).

3. **Heuristic name cleanup** — As a last resort, add generic string heuristics
   (e.g. strip trailing numbers, normalize whitespace) that aren't specific to
   any particular content. Never add copyrighted entity names as match targets.

Do NOT add lists of expected entity names to match against — that puts copyrighted
content in the source. If 100 names are wrong, fix them in the 100 page transcriptions
(signed off as `.Final.Opus.md`), not with a 100-entry lookup table in the engine.
