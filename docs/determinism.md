# Determinism model

The engine is a deterministic interpreter. Its core guarantee is:

```
f(complete_pdf, profile, engine_version) -> output corpus
```

Given the same complete PDF, the same profile, and the same engine version, the
`_source/*.json` pack corpus and the extracted Tier A image assets are
**byte-identical** — across platforms, Node runtimes, and whether the run started
cold or warm from cache. This document describes how that guarantee is built and
where it stops.

## Input contract

- The only input is a **complete PDF**. There is no entry point that resumes from
  an intermediate representation — no `--from-markdown`, no `--resume`. The
  intermediate cache is read only when a complete PDF hashes to a key that
  already exists.
- The **profile** and the **engine version** are the other two inputs. The
  engine version and the IR version participate in both the function above and
  the cache key, so any change to extraction or normalization rules forks the
  output cleanly rather than silently.

## Determinism tiers

| Tier               | Scope                                      | Guarantee                                                       | Gating                              |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------- |
| **A — Core**       | PDF → entities + embedded image extraction | Byte-identical across platforms, runtimes, and cold/warm cache  | Blocking (golden + gate scripts)    |
| **B — Raster**     | Vector art rendered to a bitmap            | Byte-identical only for a pinned renderer on a pinned platform  | Opt-in, non-blocking cross-platform |
| **C — Enrichment** | Wiki image-link resolution                 | Deterministic given a fixed lockfile; the network itself is not | Non-blocking                        |

**Tier A output is byte-identical whether or not Tier B or C ran.** Enrichment is
written only into designated fields, after the `_id` is fixed, so a run with
enrichment and a run without it produce identical ids, filenames, and Tier A
field values.

## Intermediates and the cache

Extraction, normalization, and image recovery are a pure function of the complete
PDF, so their result (the canonical IR plus the recovered image assets) is cached
under a content key:

```
key = sha256( sha256(pdf) | "eng:" ENGINE_VERSION | "ir:" IR_VERSION )[:32]
```

The cache lives under `.cache/<key>/` (`ir.json`, `manifest.json`, `assets/`) and
is **gitignored and fully regenerable**. It is a pure optimization: deleting it
and re-running produces identical output (cold vs. warm cache are proven equal by
CI). The raw PDF content hash is used locally only — never emitted, never written
to a tracked path, never logged to a shared sink. A cached entry whose recorded
engine/IR version no longer matches is ignored.

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
   `(page, band, x)` order.
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

`canonical_content` is the byte-sorted JSON projection of the entity's Tier A
fields and images, **excluding** `_id`, `_stats`, `sort`, and all Tier C
enrichment fields. Crucially, an image reference contributes its **content
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
produce the same asset tree.

## Tier C: enrichment reproducibility

Wiki link resolution is fail-open (any offline/unreachable/no-match outcome logs
and proceeds with no link) and is made reproducible by a **local lockfile**, not
by the network. The first enriching run resolves names and writes the lockfile;
subsequent runs read it and make **zero** network calls. The resolver's ranking
is a pure function of the candidate set (versioned by `RESOLVER_VERSION`), so a
fixed lockfile yields a fixed result. The lockfile pins page revid and image
SHA-1 so `--refresh-enrichment` can detect staleness. The lockfile is user-local,
gitignored, and never distributed.

## Compiled packs caveat

Every determinism guarantee, golden test, and CI gate in this repo
(`gate:determinism`, `gate:timestamps`, `gate:titles`, `gate:wiki`) operates on
the **`_source/*.json` pack corpus** — the human-readable, per-document JSON the
engine emits.

If that corpus is later compiled downstream into a binary Foundry **LevelDB**
pack, **that artifact is not byte-reproducible.** LevelDB storage-engine layout
and compaction are not stable across compiler versions or runs, so two
compilations of identical `_source` JSON can differ byte-for-byte. This is
expected and out of scope: the reproducibility contract is the `_source` corpus,
not the compiled pack. Do not file a determinism bug against the LevelDB output.
