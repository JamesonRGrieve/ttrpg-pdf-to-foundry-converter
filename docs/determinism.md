# Determinism model

The engine is a deterministic interpreter. Its core guarantee is:

```
f(complete_pdfs, target_schema, engine_version, pinned dependencies) -> module
```

Given the same complete PDFs (in any order), the same target schema, the same
engine version and the same pinned dependencies, the output module — its
`module.json`, its NeDB `packs/*.db` files and its extracted image assets — is
**byte-identical**: across platforms, between the Node CLI and the in-browser
page, and whether the run started cold or warm from cache. This document
describes how that guarantee is built and where it stops.

## Input contract

- The only content input is a **complete PDF**, written in the user's chosen
  **target schema** (a game line's structure; `dh2` by default). There is no
  entry point that resumes from an intermediate representation, and no profile
  or configuration that changes what is extracted. The same PDF, target schema
  and engine version give byte-identical output. The caches are read only when a complete PDF hashes to a key
  that already exists.
- The engine version, the IR version, and the renderer/OCR identity participate
  in the cache keys, so any change to extraction, OCR, arbitration or
  normalization forks the output cleanly rather than silently.
- The determinism-critical dependencies (text extractor, renderer, OCR engine,
  its WASM core and model data, hashing, compression) are pinned exactly in
  `package.json` and mirrored in `src/pins.ts`; gate G10 keeps the two in sync.

## OCR determinism

OCR runs inside the engine and must be as reproducible as everything else:

- Pages render with the pinned `mupdf` at a fixed 300 DPI in 8-bit grayscale.
- Recognition uses the pinned `tesseract.js` build on the pinned **plain-SIMD
  LSTM** WASM core. tesseract.js would otherwise pick a core by CPU feature
  detection and prefer relaxed-SIMD, whose arithmetic is implementation-defined
  and can differ between CPUs. The Node engine pins the core through its own
  worker entry; the browser engine pins it by pointing `corePath` at the exact
  build file.
- The model data is the pinned `@tesseract.js-data/eng` package, loaded from
  disk (Node) or the page's own origin (browser), never fetched from a CDN.
- Arbitration (correcting the text layer from OCR) iterates only in geometric
  order and uses fixed thresholds, so identical inputs give identical output.

The browser e2e test converts a fixture in Chromium and requires the result to
be byte-identical to the CLI's committed golden output.

## Intermediates and the caches

Two caches, both pure optimizations. Deleting either and re-running produces
identical output (cold vs. warm is proven equal by gate G1/G1b).

```
ocr page key  = sha256( sha256(pdf) | renderer id | ocr engine id )[:32]
read-doc key  = sha256( sha256(pdf) | "eng:" ENGINE_VERSION | "ir:" IR_VERSION | "ocr:" renderer id | ocr engine id )[:32]
```

The CLI keeps them under `--cache-dir` (default `<os tmp>/foundry-pdf-parser/cache`):
recognized words per page under `ocr/<key>/`, and the arbitrated IR plus image
assets under `<key>/`. The browser keeps OCR in memory for the run. The PDF
content hash is used locally only: never emitted, never written to a tracked
path, never logged. A cached read document whose recorded engine/IR version no
longer matches is ignored.

## Normalization

Normalization exists solely to erase extractor nondeterminism. Every rule is
mandatory and applied in a fixed order.

### Reading order

Runs are given a total, locale-free ordering:

```
(page, column, band, x, render_order)  — all ascending
```

`band = floor((page_height - y) / 2.0)`, i.e. distance from the top in 2 pt
bands, so baseline jitter within a line collapses to one band. This is
**column-major, top-to-bottom, left-to-right**.

Two rules here are deliberate deviations from a naive reading of the original
spec, both chosen toward intent and both preserving determinism (only the
concrete golden bytes change, never reproducibility):

1. **Column-major.** `column` is part of the sort key. A row-major order would
   interleave two columns' headers at the same band and make "next header" block
   segmentation impossible. For single-column documents this reduces to the plain
   `(page, band, x)` order. Text columns are found by their **gutters**: vertical
   channels at least 8 pt wide that at most two runs cross, ignoring page
   furniture in the top and bottom margin bands. Tab stops inside a column (a
   label and its value, table cells within prose) are not gutters, because the
   column's full-width lines cross them.
2. **Top-to-bottom bands.** Bands are distance-from-top and sorted **ascending**,
   yielding true reading order — the reverse of the spec's literal descending
   key, which would have ordered the bottom of the page first.

### Text canonicalization

Each run's text is reduced to canonical code points in this exact order, so two
runs (or two platforms) that render the same glyphs hash identically:

1. Expand ligatures (`ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ` → ASCII components).
2. Strip soft hyphens (U+00AD).
3. Fold dash variants (U+2010–U+2015, U+2212) to ASCII `-`.
4. Collapse whitespace runs (including NBSP / figure space / narrow NBSP) to one
   space.
5. Unicode NFC.
6. Trim.

### Quantization

Geometry is snapped to a grid using **banker's rounding** (round half to even),
and the result is re-parsed through a fixed decimal count so representation noise
(e.g. `0.30000000000000004`) never reaches the IR. Raw floats are never compared
directly:

| Quantity               | Grid step | Comparison                    |
| ---------------------- | --------- | ----------------------------- |
| Coordinates (`x`, `y`) | 0.1 pt    | —                             |
| Run width/height       | 0.1 pt    | —                             |
| Font size              | 0.25 pt   | epsilon 0.05 pt (never `===`) |

Line banding for the sort uses a 2.0 pt band height.

### Font identity

A font name is canonicalized by stripping any six-letter PDF subset prefix
(`ABCDEF+Helvetica` → `Helvetica`) and lowercasing. Weight and italic are taken
from the PDF font-descriptor flags where present (descriptor flags win on
disagreement), falling back to the resolved font name.

## Stable identifiers and serialization

### `_id`

Each document `_id` is a 16-character base62 string derived from a SHA-256 over
**content only**:

```
_id = base62( sha256( pack + "\0" + canonical_content ) )[:16]
```

`canonical_content` is the byte-sorted JSON projection of the entity's fields
and images, **excluding** `_id`, `_stats` and `sort`. SHA-256 is the pinned
pure-JS implementation, identical in Node and the browser. Crucially, an image
reference contributes its **content
address** (`asset:<assetId>`) to the hash, not its deployment path — so changing
the asset-reference prefix (a deployment concern) never forks ids across
machines. The base62 alphabet is exactly `[0-9A-Za-z]`, matching Foundry's
`^[a-zA-Z0-9]{16}$` id constraint. A genuine collision within a pack is
disambiguated deterministically by appending the entity's ordinal, with a
warning.

### Non-content fields

- `_stats.createdTime` and `_stats.modifiedTime` are the fixed constant `0` — no
  wall clock ever reaches the corpus.
- `sort` is `ordinal × 100000`, derived from deterministic IR position, never
  insertion order.
- Optional fields are represented by **omission**, never `null`-vs-`undefined`
  drift.

### Serialization

Every document is written with keys **byte-sorted at every level**, **4-space**
indentation, **LF** line endings, no BOM, and a **terminal newline**. Assets are
content-addressed and deduplicated: identical bytes become one file, so two users
produce the same asset tree. Re-encoded rasters use the in-house PNG encoder
(filter 0, pinned zlib, only IHDR/IDAT/IEND). The browser's zip download uses a
fixed entry timestamp, so the archive's bytes depend only on its contents.

## Compiled packs caveat

Every determinism guarantee, golden test, and CI gate in this repo
(`gate:determinism`, `gate:timestamps`, `gate:titles`) operates on
the **module the engine writes**: `module.json`, the NeDB `packs/*.db` files
(one key-sorted JSON document per line, ordered by `_id`) and the assets.

Foundry builds a binary **LevelDB** pack from each `.db` file the first time
the pack opens. **That artifact is not byte-reproducible**: LevelDB layout and
compaction are not stable across versions or runs. This is expected and out of
scope: the reproducibility contract is the module as written, not the database
Foundry derives from it. Do not file a determinism bug against the LevelDB
output.
