# Profile reference

A **profile** is the only document-specific input the engine accepts. The engine
ships no knowledge of any particular PDF; every rule for turning a given layout
into Foundry documents lives in a profile you write and pass at runtime.

Profiles are **data, not code**. A profile is parsed from YAML or JSON, validated
against [`profile.schema.json`](./profile.schema.json), then interpreted. It is
never `eval`'d and is granted no filesystem or network access. Loading performs
two passes:

1. **Structural** — the JSON Schema (`additionalProperties: false` throughout, so
   unknown keys are rejected).
2. **Semantic** — every selector reference resolves to a defined selector, block
   ids are unique, every `match`/`capture` pattern compiles under RE2, every
   `transform` is in the closed vocabulary, every `emit` rule points at a real
   block and maps a `name` field.

Validate a profile without running it:

```bash
pnpm cli validate-profile profiles/example-bestiary-two-column.yml
```

## Top-level fields

| Field            | Required | Purpose                                                                                    |
| ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| `schema_version` | yes      | Integer schema major. The engine supports major `1`; an unsupported major is a load error. |
| `profile_id`     | yes      | Stable id, `^[a-z0-9][a-z0-9-]*$`.                                                         |
| `name`           | yes      | Human-readable display name (shown by `detect`).                                           |
| `version`        | yes      | Profile semver, `MAJOR.MINOR.PATCH`. Recorded in provenance.                               |
| `license`        | no       | SPDX id for the profile itself.                                                            |
| `fingerprint`    | no       | Layout descriptors used only to _rank_ this profile during `detect`.                       |
| `exclude`        | no       | Page-furniture regions to drop before matching.                                            |
| `selectors`      | yes      | Named typographic predicates (≥ 1).                                                        |
| `blocks`         | yes      | Record segmentation + field extraction (≥ 1).                                              |
| `emit`           | yes      | Binding of blocks to Foundry documents (≥ 1).                                              |

## `fingerprint`

Advisory only. `detect` scores each candidate profile's fingerprint against the
document's normalized structure and prints a ranked, non-binding list — it never
auto-selects a profile, and the engine holds no built-in fingerprints. Every
field is optional; the score is the mean of the parts that are present:

```yaml
fingerprint:
    page_size: { w: 612, h: 792, tol: 2 } # matched within tol points
    columns: 2 # detected column count
    fonts: ["libertinusserif-bold", ...] # fraction of these present (case-insensitive)
    size_buckets: [8.0, 9.0, 10.5] # fraction present (epsilon compare)
```

## `exclude`

Regions, in **absolute page coordinates** (PDF user space, origin bottom-left),
whose runs are removed before any block matching — running heads, folios,
footers. This is the **only** place absolute coordinates are permitted; all
record structure is expressed typographically. `x_min`/`x_max` are optional
(omit for a full-width horizontal band):

```yaml
exclude:
    - { region: { y_min: 0, y_max: 45 } } # footer folio
    - { region: { y_min: 748, y_max: 792 } } # running head
```

## `selectors`

A selector is a named predicate over a normalized text run, expressed in
**typographic terms only**. A run matches when every present key matches; size
comparison uses an epsilon, never float equality.

| Key      | Type               | Matches                                                   |
| -------- | ------------------ | --------------------------------------------------------- |
| `weight` | `normal` \| `bold` | Font weight (from descriptor flags, else name).           |
| `size`   | number (pt)        | Quantized font size, compared within ±0.05 pt.            |
| `italic` | boolean            | Italic/oblique.                                           |
| `font`   | string             | Canonical font name (subset prefix stripped, lowercased). |
| `column` | integer ≥ 0        | Zero-based column index from detected page geometry.      |
| `indent` | `{ min, max }`     | Left indent (pt) relative to the run's column edge.       |

```yaml
selectors:
    creature_name: { weight: bold, size: 10.5 }
    body: { weight: normal, size: 9.0 }
```

## `blocks`

A block segments the run stream into repeating records and extracts fields from
each.

- `id` — unique block id, `^[a-z0-9][a-z0-9_-]*$`.
- `starts_at` — selector name; each matching run opens a new record instance.
- `ends_at` — `{ next: <selector> }` (close at the next run matching that
  selector, typically the same one that starts the block) **or**
  `{ selector: <selector> }` (close at the next run matching a different
  selector). Exactly one form.
- `fields` — extracted field specs (below).
- `images` — optional image associations (below).

### `fields[]`

Each field reads the text of the runs in the instance that match its `from`
selector (joined with newlines), then optionally narrows and transforms it.

| Key         | Required | Meaning                                                                                                                         |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | yes      | Field name referenced later as `$name` in `emit.map`.                                                                           |
| `from`      | yes      | Selector whose runs supply the source text.                                                                                     |
| `match`     | no       | RE2 pattern; the capture group is taken as the value.                                                                           |
| `capture`   | no       | Capture group index (default `1`; `0` = whole match).                                                                           |
| `transform` | no       | Ordered transform pipeline (closed vocabulary).                                                                                 |
| `required`  | no       | When `true`, an empty result is a **hard error** with page/coordinate context; the entry is skipped and the run exits non-zero. |

### `images[]`

Associates a recovered image asset with the record by geometry (image placements
come from a best-effort content-stream scan).

- `id` — association id, referenced later as `$id` in `emit.map`.
- `where` — filter: `within_block` (image centre inside the record's text
  region), `max_area_pt2` (upper bound on placed area), `aspect: { min, max }`.
- `pick` — `largest` (max placed area), `first_by_sort` (reading-order first),
  or `all` (currently collapses to `first_by_sort` for a single-valued target,
  with a warning). Ties break on asset id. Unresolved association emits no image.

## Transform vocabulary (closed)

Transforms are a **closed set** — adding one is a schema-major bump. Each is a
pure function of its input and its fixed argument, so a field pipeline is fully
deterministic. Array results (from `split`) are joined to a scalar at emit time.

| Transform                 | Arg                       | Effect                                                          |
| ------------------------- | ------------------------- | --------------------------------------------------------------- |
| `trim`                    | —                         | Strip leading/trailing whitespace.                              |
| `collapse_ws`             | —                         | Collapse whitespace runs to a single space, then trim.          |
| `join_lines`              | —                         | Replace line breaks with a single space.                        |
| `dehyphenate`             | —                         | Remove a hyphen followed by a line break (re-join split words). |
| `upper`                   | —                         | Uppercase.                                                      |
| `lower`                   | —                         | Lowercase.                                                      |
| `title_case`              | —                         | Lowercase, then uppercase the first letter of each word.        |
| `to_int`                  | —                         | Parse an integer (non-digits stripped); empty on failure.       |
| `to_float`                | —                         | Parse a float (non-numeric stripped); empty on failure.         |
| `split(sep)`              | separator                 | Split on `sep`, trim parts, drop empties.                       |
| `capture(pattern, group)` | RE2 pattern + group index | Take a capture group from the value.                            |
| `default(value)`          | literal                   | Substitute `value` when the input is empty.                     |

## Regular expressions (RE2)

All `match` and `capture(...)` patterns run through **RE2** (`re2js`): linear-time
matching with no catastrophic backtracking, so a careless or hostile profile can
never hang an import. RE2 syntax has **no lookbehind and no backreferences**;
patterns using them are rejected at load. Match semantics are fully specified
rather than engine-dependent.

## `emit`

Each emit rule turns the instances of one block into Foundry documents.

| Key             | Required | Meaning                                                        |
| --------------- | -------- | -------------------------------------------------------------- |
| `block`         | yes      | Block id to bind.                                              |
| `document_type` | yes      | `Item` \| `Actor` \| `JournalEntry` \| `RollTable` \| `Scene`. |
| `pack`          | yes      | Pack directory name, `^[a-z0-9][a-z0-9_-]*$`.                  |
| `group`         | no       | Group directory under `packs/` (defaults to `pack`).           |
| `map`           | yes      | Foundry field path → value. Must include a `name`.             |
| `enrichment`    | no       | Foundry field path → `{ from: wiki, key: <ref> }`.             |

`map` values are either a **reference** (`$field` or `$image`, resolved against
the record's extracted fields and image associations) or a **literal** (any
string without a leading `$`). Dotted paths build nested objects
(`system.attributes.wounds.max`). A field that resolves to nothing is omitted; if
nothing supplies `name`, the document falls back to a name slug of `entry` with a
warning.

`enrichment` targets are the **only** fields fed by Tier C wiki resolution. Their
`key` is a reference (e.g. `$name`) resolved to the lookup string. Enrichment
fields are written after the document `_id` is fixed and never contribute to it —
see [determinism.md](./determinism.md).

## Worked example

The one bundled profile, `profiles/example-bestiary-two-column.yml`, targets a
two-column bestiary with bold creature headers over normal-weight body text. It
is written against a synthetic, free-content fixture and ships no commercial data
(license `CC0-1.0`).

```yaml
schema_version: 1
profile_id: example-bestiary-two-column
name: Two-column bestiary with bold creature headers
version: 1.0.0
license: CC0-1.0

fingerprint:
    page_size: { w: 612, h: 792, tol: 2 }
    columns: 2
    fonts: ["libertinusserif-bold", "libertinusserif-regular"]
    size_buckets: [8.0, 9.0, 10.5]

exclude:
    - { region: { y_min: 0, y_max: 45 } } # footer folio
    - { region: { y_min: 748, y_max: 792 } } # running head

selectors:
    creature_name: { weight: bold, size: 10.5 }
    body: { weight: normal, size: 9.0 }

blocks:
    - id: statblock
      starts_at: creature_name
      ends_at: { next: creature_name }
      fields:
          - { name: name, from: creature_name, transform: [trim], required: true }
          - { name: flavor, from: body, match: "(?s)^(.*?)Armor Class", capture: 1, transform: [collapse_ws] }
          - { name: ac, from: body, match: 'Armor Class (\d+)', capture: 1, transform: [to_int] }
          - { name: hp, from: body, match: 'Hit Points (\d+)', capture: 1, transform: [to_int] }
          - { name: speed, from: body, match: 'Speed (\d+)', capture: 1, transform: [to_int] }

emit:
    - block: statblock
      document_type: Actor
      group: examples
      pack: fixture-bestiary
      map:
          name: $name
          type: npc
          system.description: $flavor
          system.attributes.armor.value: $ac
          system.attributes.wounds.max: $hp
          system.attributes.speed.value: $speed
```

How it reads:

- `exclude` drops the folio and running head so they never enter matching.
- Two selectors describe the only typography that matters: a **bold 10.5 pt**
  creature header and **normal 9 pt** body.
- The `statblock` block opens on each header run and closes at the next header,
  so every creature becomes one record instance.
- `name` is `required`; a header run with no text would fail the whole run.
  `flavor` captures the prose up to `Armor Class`; `ac`/`hp`/`speed` capture
  their numbers and coerce to integers.
- The emit rule writes one Foundry **Actor** per record into
  `examples/fixture-bestiary/_source/`, mapping fields (and the literal
  `type: npc`) onto nested Foundry paths.
