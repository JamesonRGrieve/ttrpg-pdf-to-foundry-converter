// SPDX-License-Identifier: AGPL-3.0-or-later
/** Types for `modules.mjs`. */

export interface ModuleDocument {
    module: string;
    pack: string;
    /** The pack's document type (Item, Actor, …). */
    type: string;
    doc: Record<string, unknown>;
}

export function moduleDocuments(root: string): ModuleDocument[];

export function moduleManifests(root: string): { dir: string; manifest: Record<string, unknown> }[];
