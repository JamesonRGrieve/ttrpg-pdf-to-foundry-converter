// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FoundryDocumentType } from "./profile.ts";

/** A field value produced by the apply stage before emit maps it into a document. */
export type FieldValue = string | number | boolean | null;

/**
 * One extracted entity, prior to `_id` assignment. `enrichmentFields` are kept
 * strictly separate from `fields`: they are excluded from the `_id` hash and
 * from every Tier A field so enrichment can never perturb identity (spec §9.1,
 * §10.6). `ordinal` is the position in the deterministic IR order and drives
 * both the `sort` value and collision disambiguation (§9.2).
 */
export interface Entity {
    blockId: string;
    documentType: FoundryDocumentType;
    pack: string;
    group: string;
    ordinal: number;
    /** Foundry document field path → value (Tier A). Feeds the `_id` hash. */
    fields: Record<string, FieldValue>;
    /** Resolved Foundry-path → asset id (Tier A). Feeds the `_id` hash. */
    images: Record<string, string>;
    /** Pending Tier C lookups: Foundry field path → already-resolved wiki key. */
    enrichmentRequests: { path: string; key: string }[];
    /** Tier C enrichment field path → value. NEVER feeds the `_id` hash. */
    enrichmentFields: Record<string, FieldValue>;
    /** Source page/coordinate context for diagnostics. */
    provenance: { pageIndex: number; y: number };
}

export interface EntityGraph {
    entities: Entity[];
    /** Non-fatal issues surfaced during apply/enrich (unmatched optional fields, etc.). */
    warnings: string[];
}
