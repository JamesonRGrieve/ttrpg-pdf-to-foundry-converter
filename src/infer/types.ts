// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IRTextRun } from "../types/ir.ts";

export interface TableCell {
    text: string;
    colIndex: number;
    isHeader: boolean;
}

export interface TableRow {
    cells: TableCell[];
    isHeaderRow: boolean;
    isSectionHeader: boolean;
    sectionName: string | null;
}

/** A table region found by layout: header texts, data rows, optional caption. */
export interface DetectedTable {
    pageIndex: number;
    headers: string[];
    rows: TableRow[];
    tableTitle: string | null;
}

/** A captioned table with the text runs of its header and records. */
export interface TitledTable extends DetectedTable {
    runs: IRTextRun[];
}

/** A 3×3 characteristic grid with its heading and the statblock lines around it. */
export interface DetectedNumericGrid {
    pageIndex: number;
    labels: string[];
    values: number[];
    name: string;
    /** The caption line the name was read from, for a statblock printed as a row (null for a grid). */
    caption: string | null;
    /** A lone number on the name banner line, when printed. */
    bannerNumber: number | null;
    associatedText: string[];
    /**
     * The panel's text as blocks, each opened by a bold `Label:` (null:
     * unlabelled lines), with the page the block opens on.
     */
    blocks: { label: string | null; text: string; pageIndex: number }[];
}

/** Content kinds a table can be classified as (the Foundry system's type vocabulary). */
export type ContentType =
    | "weapon"
    | "armour"
    | "ammo"
    | "gear"
    | "tool"
    | "cybernetic"
    | "force-field"
    | "consumable"
    | "weapon-mod"
    | "armour-mod"
    | "talent"
    | "trait"
    | "skill"
    | "psychic-power"
    | "critical-injury"
    | "condition"
    | "mutation"
    | "malignancy"
    | "mental-disorder"
    | "rolltable"
    | "ship-component"
    | "unknown";

export interface Classification {
    contentType: ContentType;
    confidence: number;
}
