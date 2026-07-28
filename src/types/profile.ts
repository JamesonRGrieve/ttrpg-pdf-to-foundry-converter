// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FontWeight } from "./ir.ts";

/**
 * Profile DSL types (spec §8). These mirror the published JSON Schema exactly
 * (keys stay snake_case to match the YAML/JSON on disk). Profiles are *data*,
 * not code (§8.1): validated at load, then interpreted — never `eval`'d, never
 * granted filesystem or network access.
 */

export interface FingerprintSpec {
    page_size?: { w: number; h: number; tol: number };
    columns?: number;
    fonts?: string[];
    size_buckets?: number[];
}

export interface RegionSpec {
    y_min: number;
    y_max: number;
    x_min?: number;
    x_max?: number;
}

export interface ExcludeRule {
    region: RegionSpec;
}

export interface Selector {
    weight?: FontWeight;
    /** Quantized font size in points; compared with epsilon, never `===` (§5.3). */
    size?: number;
    italic?: boolean;
    font?: string;
    column?: number;
    indent?: { min: number; max: number };
}

/** Closed transform vocabulary (§8.4). Encoded as strings, parsed at load. */
export type TransformExpr = string;

export interface FieldSpec {
    name: string;
    from: string;
    /** RE2-compatible, backtracking-free pattern over normalized text (§8.2). */
    match?: string;
    capture?: number;
    transform?: TransformExpr[];
    required?: boolean;
}

export interface ImageWhere {
    within_block?: boolean;
    max_area_pt2?: number;
    aspect?: { min: number; max: number };
}

export type ImagePick = "largest" | "first_by_sort" | "all";

export interface ImageAssocSpec {
    id: string;
    where: ImageWhere;
    pick: ImagePick;
}

export interface BlockSpec {
    id: string;
    starts_at: string;
    ends_at: { next: string } | { selector: string };
    fields: FieldSpec[];
    images?: ImageAssocSpec[];
}

export type FoundryDocumentType = "Item" | "Actor" | "JournalEntry" | "RollTable" | "Scene";

export interface EnrichmentTarget {
    from: "wiki";
    key: string;
}

export interface EmitRule {
    block: string;
    document_type: FoundryDocumentType;
    pack: string;
    /** Group directory under `packs/` (matches the `<group>/<pack>/_source` layout). */
    group?: string;
    map: Record<string, string>;
    enrichment?: Record<string, EnrichmentTarget>;
}

export interface Profile {
    schema_version: number;
    profile_id: string;
    name: string;
    version: string;
    license?: string;
    fingerprint?: FingerprintSpec;
    exclude?: ExcludeRule[];
    selectors: Record<string, Selector>;
    blocks: BlockSpec[];
    emit: EmitRule[];
}
