# foundry-pdf-parser

A deterministic interpreter that turns a **complete PDF** plus a **user-supplied
profile** into a Foundry VTT compendium pack corpus. The engine contains no
knowledge of any specific document and ships no third-party data: every
document-specific behavior — which typography marks a record, how fields are
extracted, how they map onto Foundry documents — arrives as profile _data_ at
runtime. Same PDF + same profile + same engine version gives byte-identical
output, everywhere.

## Hard constraints

These are load-bearing and demonstrable by running the shipped artifact:

- **No profile, no output (fail closed).** `run` without `--profile` in a
  non-interactive context exits `2` and writes nothing. The engine never
  synthesizes or auto-selects a profile.
- **No wiki data is distributed.** No bundled URLs, no cached index, no shipped
  lockfile, no mirrored images — a fresh clone contains zero wiki-derived bytes.
  Enrichment resolves links on your machine at runtime and is never redistributed
  (the lockfile and any localized images are gitignored and user-local).
- **Enrichment stores links only.** By default enrichment records resolved image
  **URLs** and nothing else. Downloading remote image bytes (`--localize-images`)
  is opt-in, off by default, and gated behind an interactive confirmation into a
  separate subtree — never implied by any other flag.
- **Encrypted/DRM'd PDFs are refused, never decrypted.** An encrypted input exits
  `3` with no password attempt.
- **Zero commercial data.** The engine ships no profiles for commercial products
  and no commercial titles, authors, or ISBNs anywhere. The one bundled profile
  targets a synthetic, free-content (`CC0-1.0`) fixture as a working
  demonstration.

Exit codes: `0` success, `1` recoverable error (e.g. an unmatched _required_
field at end of run), `2` no profile supplied, `3` encrypted input refused.

## Determinism tiers

| Tier               | Scope                                      | Guarantee                                                                                            |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **A — Core**       | PDF → entities + embedded image extraction | Byte-identical across platforms, runtimes, and cold/warm cache. Gated and blocking.                  |
| **B — Raster**     | Vector art rendered to a bitmap            | Byte-identical only for a pinned renderer on a pinned platform. Opt-in, non-blocking cross-platform. |
| **C — Enrichment** | Wiki image-link resolution                 | Deterministic given a fixed lockfile; the network itself is not deterministic.                       |

**Tier A output is byte-identical whether or not Tier B or C ran** — enrichment
is written into designated fields after each document `_id` is fixed and never
perturbs identity. Full detail in [docs/determinism.md](./docs/determinism.md).

### Compiled packs caveat

All determinism guarantees, golden tests, and CI gates operate on the
`_source/*.json` pack corpus the engine emits. If that corpus is later compiled
downstream into a binary Foundry **LevelDB** pack, that artifact is **not**
byte-reproducible — storage-engine layout and compaction are not stable. That is
expected and out of scope; do not file a determinism bug against the LevelDB
output.

## Install and usage

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
pnpm cli run <pdf> --profile <profile.yml>
```

`pnpm cli` runs the CLI from source (`tsx src/cli.ts`). To use the compiled
binary instead, `pnpm build` and run the `foundry-pdf-parser` bin.

### Commands

```
foundry-pdf-parser run <pdf> --profile <path>   Parse a PDF into the pack corpus.
foundry-pdf-parser detect <pdf>                 Show metadata + ranked profile suggestions (advisory).
foundry-pdf-parser validate-profile <path>      Validate a profile against the schema.
```

`detect` scores each candidate profile's fingerprint against the document's
structure and prints a non-binding ranked list; it never applies a profile. The
input to `run` is a **complete PDF only** — there is no `--from-markdown`, no
`--resume`, and no entry point that starts from an intermediate representation.

### Flags for `run`

| Flag                     | Effect                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| `--profile <path>`       | **Required.** Profile file (YAML or JSON).                                |
| `--repo-root <dir>`      | Engine repo root (default: cwd); anchors default paths.                   |
| `--packs-dir <dir>`      | Output pack corpus root.                                                  |
| `--assets-dir <dir>`     | Extracted image asset root.                                               |
| `--cache-dir <dir>`      | Intermediate cache directory.                                             |
| `--asset-ref-prefix <s>` | Image-reference prefix written into documents.                            |
| `--enrich`               | Enable Tier C wiki link enrichment (off by default).                      |
| `--refresh-enrichment`   | Re-resolve enrichment instead of using the lockfile.                      |
| `--offline`              | Hard-disable all network access.                                          |
| `--localize-images`      | Download resolved wiki images (requires `--enrich`; interactive confirm). |
| `--dry-run`              | Compute output but do not write to disk.                                  |
| `--log-level <level>`    | `debug` \| `info` \| `warn` \| `error` (default `info`).                  |

Diagnostics go to stderr; stdout stays clean for machine-consumable output.

## Paths and layout

Defaults assume a sibling-submodule layout, and every path is overridable:

- **Input** — source PDFs are read-only input at `../pdfs`; the engine never
  writes there.
- **Output** — the sibling `.foundry-system` pack tree:
  `.../.foundry-system/src/packs/<group>/<pack>/_source/<slug>_<id>.json`.
- **Images** — extracted embedded images under the configured asset tree; Tier B
  rasters live in a separate subtree so Tier A gates can exclude them by path.
- **Cache** — `.cache/` holds regenerable intermediates (IR + assets keyed by PDF
  content hash + engine version + IR version). Gitignored; deleting it and
  re-running yields identical output.

## Pipeline

The full flow is a fixed sequence of stages; `run` executes them in order after
the profile has been supplied.

1. **Extract** — one pinned extractor reads text runs (position, font, size,
   weight), embedded image XObjects, and best-effort image placements from the
   PDF; encrypted input is refused here.
2. **Normalize** — erases extractor nondeterminism: canonicalizes text, quantizes
   geometry, canonicalizes font identity, and imposes a total column-major
   reading order, producing the canonical IR.
3. **Images** — recovers embedded images as content-addressed Tier A assets
   (lossless passthrough or a pinned re-encode), deduplicated by their bytes.
4. **Detect** — scores user-supplied profile fingerprints against the document
   and _suggests_ candidates; advisory only and run only for the `detect`
   command, since `run` is given the profile explicitly.
5. **Apply** — interprets the validated profile against the IR: segments blocks,
   extracts fields through the DSL, associates images by geometry, and binds
   instances into entities; an unmatched required field is a fatal-at-end error.
6. **Enrich** — optional Tier C wiki link resolution, written only into
   designated enrichment fields, reproducible from a local lockfile.
7. **Emit** — serializes each entity to stable per-document JSON with a
   content-derived `_id`, byte-sorted keys, and fixed non-content fields.

## Status and known limitations

- **Image recovery (Tier A)** implements lossless passthrough for `DCTDecode`
  (JPEG) and `JPXDecode` (JPEG 2000), and re-encodes `FlateDecode` rasters to PNG
  with a pinned encoder for RGB / Gray / CMYK at 8 bits per component, handling
  PNG and TIFF row predictors (and no-predictor). CMYK→RGB uses a fixed in-house
  transform, never a system ICC profile.
- **Not yet implemented:** LZW/CCITT filters, indexed/palette colorspaces,
  sub-byte bit depths, and unmodeled predictors are refused with a warning rather
  than guessed. **Tier B raster fallback** (rendering vector art to a bitmap) is a
  reserved, separate path — configured but not yet wired to the pipeline or the
  CLI.
- **Enrichment** targets a configured
  wiki via the MediaWiki `api.php` (structured API, never HTML
  scraping), rate-limited and offline-aware. It resolves links only.

## Documentation

- [docs/profiles.md](./docs/profiles.md) — the profile DSL reference.
- [docs/determinism.md](./docs/determinism.md) — the determinism model.
- [docs/profile.schema.json](./docs/profile.schema.json) — the JSON Schema
  profiles are validated against.

## License

AGPL-3.0-or-later. Every source file carries an
`// SPDX-License-Identifier: AGPL-3.0-or-later` header.
