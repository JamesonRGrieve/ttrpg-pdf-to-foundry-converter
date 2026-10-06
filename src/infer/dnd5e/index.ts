// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from "../../logger.ts";
import type { EntityGraph } from "../../types/entity.ts";
import type { IR } from "../../types/ir.ts";
import { inferBookSlug } from "../book.ts";
import { inferPageNumbering } from "../page-numbers.ts";
import type { Dnd5eTarget } from "../targets.ts";
import { buildDocuments } from "./documents.ts";
import { readLayout } from "./layout.ts";
import { readCharacterOptions } from "./read.ts";

/**
 * Structural inference for the dnd5e system: IR → character-option Items
 * (classes and their features and subclasses, species, backgrounds, feats),
 * marked with the ruleset the user chose.
 */

export interface Dnd5eInferResult {
    graph: EntityGraph;
    book: string;
}

export function inferDnd5e(ir: IR, log: Logger, target: Dnd5eTarget): Dnd5eInferResult {
    const book = inferBookSlug(ir);
    const layout = readLayout(ir);
    const readings = readCharacterOptions(layout);
    const title = ir.meta.title?.trim();
    const entities = buildDocuments(
        readings,
        target,
        book,
        title === undefined || title.length === 0 ? book : title,
        inferPageNumbering(ir),
    );
    log.info(
        `dnd5e ${target.rules}: ${readings.classes.length} classes, ${readings.classes.reduce((n, c) => n + c.subclasses.length, 0)} subclasses, ${readings.species.length} species, ${readings.backgrounds.length} backgrounds, ${readings.feats.length} feats → ${entities.length} documents`,
    );
    return { graph: { entities, warnings: [] }, book };
}
