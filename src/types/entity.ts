// SPDX-License-Identifier: AGPL-3.0-or-later

/** Top-level Foundry document classes the engine emits into compendium packs. */
export type FoundryDocumentType = "Item" | "Actor" | "JournalEntry" | "RollTable";

/** A JSON value as it lands in an emitted `_source/*.json` document. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** A field value produced by inference before emit maps it into a document. */
export type FieldValue = JsonValue;

/**
 * One extracted entity, prior to `_id` assignment. `ordinal` is the position in
 * the deterministic IR order and drives both the `sort` value and collision
 * disambiguation.
 */
export interface Entity {
    blockId: string;
    documentType: FoundryDocumentType;
    /** Game-line directory the pack lives under (`<group>/<pack>/_source`). */
    group: string;
    pack: string;
    ordinal: number;
    /** Foundry document field path → value. Feeds the `_id` hash. */
    fields: Record<string, FieldValue>;
    /** Resolved Foundry-path → asset id. Feeds the `_id` hash. */
    images: Record<string, string>;
    /** Source page/coordinate context for diagnostics. */
    provenance: { pageIndex: number; y: number };
}

export interface EntityGraph {
    entities: Entity[];
    /** Non-fatal issues surfaced during inference (unparsed cells, etc.). */
    warnings: string[];
}
