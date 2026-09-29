// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from "../logger.ts";
import type { Entity, EntityGraph, FoundryDocumentType, JsonObject, JsonValue } from "../types/entity.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { byteCompare } from "../util/ordered.ts";
import { escapeHtml } from "../util/text.ts";
import { inferBookSlug } from "./book.ts";
import { classifyTable } from "./classify.ts";
import {
    headerRole,
    isAdvanceList,
    isAttributeScale,
    mergedHeaderRoles,
    normalizeHeader,
    type Role,
} from "./columns.ts";
import { detectEntries, type Entry } from "./detect-entries.ts";
import { detectNumericGrids } from "./detect-grids.ts";
import { detectTables } from "./detect-tables.ts";
import { detectTitledTables } from "./detect-titled-tables.ts";
import { entryItem, entryType, typeNamedBy } from "./entry-types.ts";
import {
    cleanName,
    endsMidSentence,
    readsAsProse,
    rejoinSplitWords,
    startsLikeName,
    wordsOf,
} from "./names.ts";
import { parseNpc } from "./npc.ts";
import {
    type OriginPathReading,
    originStepNamedBy,
    readOriginPaths,
    readOriginTable,
} from "./origin-paths.ts";
import { inferPageNumbering, printedPage, type PageNumbering } from "./page-numbers.ts";
import { mapRow, type RowCells, rowType } from "./rows.ts";
import {
    ACTOR_SEGMENT,
    buildItem,
    buildNpc,
    buildOriginPath,
    buildVehicle,
    CRAFT_SEGMENT,
    itemSegment,
    packName,
    toHtml,
    type ItemType,
    type Line,
} from "./schema.ts";
import type { TargetSchema } from "./targets.ts";
import type { ContentType, DetectedTable, TableRow } from "./types.ts";
import { isVehicleProfile, panelPairs, parseVehicle } from "./vehicle.ts";

/**
 * Structural inference: IR → Foundry compendium entities. Everything is found
 * from layout and typography — tables by column alignment or caption, stat
 * blocks by their characteristic grid, catalogue entries by bold-name blocks —
 * and mapped onto the Foundry system's schema. Nothing is looked up by what a
 * document is or says.
 */

export interface InferResult {
    graph: EntityGraph;
    line: Line;
    book: string;
    pageNumbering: PageNumbering;
    diagnostics: {
        tables: number;
        unclassifiedTables: number;
        grids: number;
        entries: number;
        entities: number;
    };
}

/** Table content type → the Foundry item type its rows become. */
const TABLE_ITEM_TYPE: Partial<Record<ContentType, ItemType>> = {
    weapon: "weapon",
    armour: "armour",
    ammo: "ammunition",
    gear: "gear",
    tool: "gear",
    consumable: "gear",
    cybernetic: "cybernetic",
    "force-field": "forceField",
    "weapon-mod": "weaponModification",
    "armour-mod": "armourModification",
    talent: "talent",
    trait: "trait",
    skill: "skill",
    "psychic-power": "psychicPower",
    "critical-injury": "criticalInjury",
    condition: "condition",
    mutation: "mutation",
    malignancy: "malignancy",
    "mental-disorder": "mentalDisorder",
};

/**
 * A table's first (name) column headed with a schema type word says what its
 * rows are ("TALENT", "SKILL", "WEAPON"…) more reliably than the other headers.
 */
const NAME_HEADER_TYPES: readonly [RegExp, ItemType][] = [
    [/^talents?$/u, "talent"],
    [/^skills?$/u, "skill"],
    [/^traits?$/u, "trait"],
    [/^weapons?$/u, "weapon"],
    [/^armou?rs?$/u, "armour"],
    [/^(psychic )?powers?$/u, "psychicPower"],
];

function nameHeaderType(table: DetectedTable): ItemType | undefined {
    const first = normalizeHeader(table.headers[0] ?? "");
    return NAME_HEADER_TYPES.find(([re]) => re.test(first))?.[1];
}

/** Longest plausible entity name; longer "names" are prose that leaked into a name column. */
const MAX_NAME_LENGTH = 60;

/** A variable-level placeholder after a name — `(X)` — that a summary listing may omit. */
const LEVEL_PLACEHOLDER = /\s*\(\p{Lu}\)\s*$/u;

/** Identity of a name for merging readings: case, punctuation and a level placeholder ignored. */
export function nameKey(name: string): string {
    return name
        .replace(LEVEL_PLACEHOLDER, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

class EntityCollector {
    readonly entities: Entity[] = [];
    readonly warnings: string[] = [];
    readonly line: Line;

    constructor(
        readonly target: TargetSchema,
        readonly book: string,
        readonly numbering: PageNumbering,
    ) {
        this.line = target.line;
    }

    page(pageIndex: number): string {
        return printedPage(this.numbering, pageIndex);
    }

    add(
        documentType: FoundryDocumentType,
        segment: string,
        body: JsonObject,
        pageIndex: number,
        blockId: string,
    ): void {
        this.entities.push({
            blockId,
            documentType,
            group: this.line,
            pack: packName(this.line, this.book, segment),
            ordinal: this.entities.length,
            fields: body,
            images: {},
            provenance: { pageIndex, y: 0 },
        });
    }
}

/** Resolve a table's headers to roles; merged headers ("Clip Rld") yield several. */
function columnRoles(table: DetectedTable): (Role[] | null)[] {
    return table.headers.map((h) => {
        const role = headerRole(h);
        return role === null ? mergedHeaderRoles(h) : [role];
    });
}

/** One data row → cells keyed by role, splitting merged columns on whitespace. */
function rowCells(row: TableRow, roles: readonly (Role[] | null)[]): RowCells {
    const cells: RowCells = {};
    for (const cell of row.cells) {
        const cellRoles = roles[cell.colIndex];
        const text = cell.text.trim();
        if (cellRoles === undefined || cellRoles === null || text.length === 0) {
            continue;
        }
        const [only] = cellRoles;
        if (cellRoles.length === 1 && only !== undefined) {
            // Two columns of one role (e.g. two aptitude columns) form a list.
            cells[only] = cells[only] === undefined ? text : `${cells[only]}, ${text}`;
            continue;
        }
        const parts = text.split(/\s+/u);
        if (parts.length === cellRoles.length) {
            parts.forEach((part, i) => {
                const r = cellRoles[i];
                if (r !== undefined) {
                    cells[r] = part;
                }
            });
        }
    }
    return cells;
}

/** The name column: the explicitly named one, else the first column most rows fill. */
function nameColumn(table: DetectedTable, roles: readonly (Role[] | null)[]): number {
    const named = roles.findIndex((r) => r !== null && r.length === 1 && r[0] === "name");
    if (named >= 0) {
        return named;
    }
    let best = 0;
    let bestFill = -1;
    table.headers.forEach((_, col) => {
        const fill = table.rows.filter((r) =>
            r.cells.some((c) => c.colIndex === col && c.text.trim().length > 0),
        ).length;
        if (fill > bestFill && (roles[col] === null || roles[col] === undefined)) {
            best = col;
            bestFill = fill;
        }
    });
    return best;
}

/** A table rendered as HTML: header row, then one row per data row. */
function tableHtml(table: DetectedTable): string {
    const head = `<tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    const cell = (row: TableRow, col: number): string =>
        escapeHtml(row.cells.find((c) => c.colIndex === col)?.text ?? "");
    const body = table.rows
        .filter((r) => !r.isHeaderRow && !r.isSectionHeader)
        .map((r) => `<tr>${table.headers.map((_, i) => `<td>${cell(r, i)}</td>`).join("")}</tr>`)
        .join("");
    return `<table>${head}${body}</table>`;
}

/**
 * A table that is itself one item — a severity table whose rows are the
 * item's graded effects — named by its caption.
 */
function extractTableItem(table: DetectedTable, type: ItemType, out: EntityCollector): void {
    const name = cleanName(table.tableTitle ?? "");
    if (name.length === 0) {
        return;
    }
    const effect = tableHtml(table);
    out.add(
        "Item",
        itemSegment(type),
        buildItem({
            type,
            name,
            line: out.line,
            book: out.book,
            page: out.page(table.pageIndex),
            description: "",
            system: {},
            variantized: { effect },
        }),
        table.pageIndex,
        `table-item:${type}`,
    );
}

/** A result cell that names an outcome and states its effect: `Name: effect`. */
const NAMED_RESULT = /^(?<name>[^:]{2,50}?):\s+(?<effect>.{10,})$/su;

/**
 * A roll table whose result cells read `Name: effect` lists one `type` item per
 * named result. Returns false when the table is not such a list.
 */
function extractResultTable(table: DetectedTable, type: ItemType, out: EntityCollector): boolean {
    const dataRows = table.rows.filter((r) => !r.isHeaderRow && !r.isSectionHeader);
    const named = dataRows.filter((r) => r.cells.some((c) => NAMED_RESULT.test(c.text.trim())));
    if (named.length * 2 < dataRows.length) {
        return false;
    }
    let found = 0;
    for (const row of table.rows) {
        for (const cell of row.cells) {
            const groups = NAMED_RESULT.exec(cell.text.trim())?.groups;
            const resultName = groups?.["name"];
            const resultEffect = groups?.["effect"];
            if (resultName === undefined || resultEffect === undefined) {
                continue;
            }
            const name = cleanName(resultName);
            const effect = toHtml(resultEffect);
            out.add(
                "Item",
                itemSegment(type),
                buildItem({
                    type,
                    name,
                    line: out.line,
                    book: out.book,
                    page: out.page(table.pageIndex),
                    description: effect,
                    system: {},
                    variantized: { effect },
                }),
                table.pageIndex,
                `result:${type}`,
            );
            found += 1;
        }
    }
    return found > 0;
}

function extractTables(
    ir: IR,
    out: EntityCollector,
    log: Logger,
): { tables: number; unclassified: number; tableRuns: Set<IRTextRun> } {
    const titled = detectTitledTables(ir);
    const titledPages = new Set(titled.map((t) => t.pageIndex));
    const tables = [...titled, ...detectTables(ir).filter((t) => !titledPages.has(t.pageIndex))];
    let unclassified = 0;
    for (const table of tables) {
        // A caption naming a creation step ("Random Home World", "Divinations")
        // lists origins of that step.
        const originStep = originStepNamedBy(table.tableTitle ?? "", out.target.originSteps);
        if (originStep !== null) {
            const rows = table.rows
                .filter((r) => !r.isHeaderRow && !r.isSectionHeader)
                .map((r) => rowTexts(r, table.headers.length));
            const origins = readOriginTable(originStep, rows, table.pageIndex);
            if (origins.length > 0) {
                for (const o of origins) {
                    addOrigin(out, o);
                }
                continue;
            }
        }
        // A caption naming a catalogue type ("… Force Fields") outranks what
        // the headers alone suggest; a captioned roll table of `Name: effect`
        // results is a list of such items.
        const captionType = typeNamedBy(table.tableTitle ?? "");
        if (captionType === "criticalInjury") {
            extractTableItem(table, captionType, out);
            continue;
        }
        if (captionType !== null && extractResultTable(table, captionType, out)) {
            continue;
        }
        const type =
            captionType ?? nameHeaderType(table) ?? TABLE_ITEM_TYPE[classifyTable(table).contentType];
        if (type === undefined) {
            unclassified += 1;
            continue;
        }
        const roles = columnRoles(table);
        // A table with an Advance column anywhere (a banner word can take the
        // first header slot) lists purchases, not a catalogue.
        if (isAttributeScale(roles[0]) || isAdvanceList(roles.flatMap((r) => r ?? []))) {
            unclassified += 1;
            continue;
        }
        const nameCol = nameColumn(table, roles);
        // A caption naming a tier ("… Tier 2 …") gives every row that tier.
        const captionTier = /\btier\s*(\d)\b/iu.exec(table.tableTitle ?? "")?.[1];
        for (const row of table.rows) {
            if (row.isHeaderRow || row.isSectionHeader) {
                continue;
            }
            const rawName = row.cells.find((c) => c.colIndex === nameCol)?.text ?? "";
            const name = cleanName(rawName);
            // A name starts like a name (capital or digit, perhaps after an
            // opening quote) and reads like one; a lowercase start or a sentence
            // is prose that strayed into the column.
            if (
                !startsLikeName(name) ||
                name.length > MAX_NAME_LENGTH ||
                readsAsProse(name) ||
                endsMidSentence(name) ||
                row.cells.filter((c) => c.text.trim()).length < 2
            ) {
                continue;
            }
            const cells = rowCells(row, roles);
            if (captionTier !== undefined && cells.tier === undefined) {
                cells.tier = captionTier;
            }
            const itemType = rowType(type, cells);
            if (itemType === null) {
                continue;
            }
            const mapped = mapRow(itemType, cells);
            for (const u of mapped.unparsed) {
                out.warnings.push(`p${out.page(table.pageIndex)} ${name}: unparsed ${u}`);
            }
            out.add(
                "Item",
                itemSegment(itemType),
                buildItem({
                    type: itemType,
                    name,
                    line: out.line,
                    book: out.book,
                    page: out.page(table.pageIndex),
                    description: "",
                    system: mapped.system,
                    variantized: mapped.variantized,
                }),
                table.pageIndex,
                `${TABLE_READING}${itemType}`,
            );
        }
    }
    log.info(`tables: ${tables.length} detected, ${unclassified} unclassified`);
    return { tables: tables.length, unclassified, tableRuns: new Set(titled.flatMap((t) => t.runs)) };
}

/** Heading-size difference (points) that sets a sub-heading apart from its siblings. */
const SUBHEADING_STEP = 0.4;

/**
 * The heading size a type's entries are usually set in. A field-less heading
 * set smaller than that sits inside an entry — a component that entry
 * describes — rather than being one of the catalogue's own entries.
 */
export function modalHeadingSizes(typed: readonly { entry: Entry; type: string }[]): Map<string, number> {
    const counts = new Map<string, Map<number, number>>();
    for (const { entry, type } of typed) {
        const sizes = counts.get(type) ?? new Map<number, number>();
        sizes.set(entry.heading.size, (sizes.get(entry.heading.size) ?? 0) + 1);
        counts.set(type, sizes);
    }
    const modal = new Map<string, number>();
    for (const [type, sizes] of counts) {
        const [size] = [...sizes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0];
        modal.set(type, size);
    }
    return modal;
}

/**
 * A one-word sub-heading directly under an item entry of the same type names a
 * kind of that item ("SPIKED" under "LANTERN" → "SPIKED LANTERN"). Longer
 * sub-headings name parts of their parent, not items of their own.
 */
export function kindEntry(entry: Entry, parentType: string | undefined, type: string): Entry | null {
    const parent = entry.sections.at(-1);
    const word = entry.heading.text.trim();
    // A hyphenated compound ("CYBER-MANTLE") is a name of its own, not a qualifier.
    if (parent === undefined || parentType !== type || !/^\p{L}+$/u.test(word)) {
        return null;
    }
    return { ...entry, heading: { ...entry.heading, text: `${word} ${parent.trim()}` } };
}

/** An entry's printed text — its `Label: value` lines, then its body — one line per field. */
function entryText(entry: Entry): string {
    return [...entry.fields.map(([label, value]) => `${label}: ${value}`), entry.body].join("\n");
}

/**
 * An entry carrying a vehicle profile is a land craft: its profile panel gives
 * the stat block, its prose the description, its other labelled rules the
 * special rules. Returns false when the entry is no vehicle.
 */
function addVehicle(out: EntityCollector, entry: Entry): boolean {
    const pairs = panelPairs(entryText(entry));
    if (!isVehicleProfile(pairs)) {
        return false;
    }
    const name = cleanName(entry.heading.text);
    // A profile under a prose fragment (an errata line quoting a rule) names no vehicle.
    if (!startsLikeName(name) || readsAsProse(name) || endsMidSentence(name)) {
        return false;
    }
    const { kind, system, unparsed } = parseVehicle(pairs);
    for (const u of unparsed) {
        out.warnings.push(`p${out.page(entry.heading.pageIndex)} ${name}: unparsed ${u}`);
    }
    const prose = entry.body
        .split(PARAGRAPH_SPLIT)
        .filter((p) => /\p{Ll}/u.test(p) && panelPairs(p).size === 0)
        .join("\n\n");
    const rules = entry.fields.filter(([label]) => /\p{Ll}/u.test(label));
    const isWeapons = ([label]: [string, string]): boolean => /^weapons?$/iu.test(label);
    out.add(
        "Actor",
        CRAFT_SEGMENT[kind],
        buildVehicle({
            actorType: out.target.actorTypes[kind],
            name,
            line: out.line,
            book: out.book,
            page: out.page(entry.heading.pageIndex),
            description: toHtml(prose),
            system,
            weapons: rules
                .filter(isWeapons)
                .map(([, value]) => toHtml(value))
                .join(""),
            specialRules: rules
                .filter((r) => !isWeapons(r))
                .map(([label, value]) => toHtml(`${label}: ${value}`))
                .join(""),
        }),
        entry.heading.pageIndex,
        "entry:vehicle",
    );
    return true;
}

/** Blank lines between paragraphs of an entry body. */
const PARAGRAPH_SPLIT = /\n{2,}/u;

/** Fewest siblings typed by their own fields that establish a run of catalogue entries. */
const MIN_TYPED_SIBLINGS = 3;
/** Share of those siblings that must agree on one kind. */
const SIBLING_AGREEMENT = 2 / 3;

/**
 * Entries under one section in one heading style are one run of catalogue
 * entries. When most of them are typed by their own fields, a sibling printed
 * with nothing to identify it (a talent with no prerequisites) is of that
 * kind too — unless it is not a catalogue entry at all: it stands before the
 * first typed entry (the section's preamble), heads entries
 * of its own (a section among the entries), carries fields none of the typed
 * siblings use, or is set as a question (a sidebar title).
 */
export function siblingKinds(
    entries: readonly Entry[],
    typeOf: (entry: Entry) => ItemType | null,
): Map<Entry, ItemType> {
    const heads = new Set(
        entries.flatMap((entry, i) => {
            const next = entries[i + 1];
            const depth = entry.sections.length;
            return next !== undefined &&
                next.sections[depth] === entry.heading.text &&
                entry.sections.every((s, j) => next.sections[j] === s)
                ? [entry]
                : [];
        }),
    );
    const labelsOf = (entry: Entry): string[] => entry.fields.map(([label]) => label.toLowerCase());
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
        const key = `${entry.sections.join("\u0000")}\u0001${entry.heading.style}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const out = new Map<Entry, ItemType>();
    for (const members of groups.values()) {
        const kinds = members.map(typeOf);
        const typed = kinds.filter((k): k is ItemType => k !== null);
        const counts = new Map<ItemType, number>();
        for (const k of typed) {
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const [kind, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
        const agreed =
            kind !== null && typed.length >= MIN_TYPED_SIBLINGS && count >= SIBLING_AGREEMENT * typed.length;
        const siblingLabels = new Set(members.filter((_, i) => kinds[i] === kind).flatMap(labelsOf));
        const firstTyped = kinds.findIndex((k) => k === kind);
        const alike = (entry: Entry, i: number): boolean =>
            i > firstTyped &&
            !heads.has(entry) &&
            !/\?\s*$/u.test(entry.heading.text) &&
            (entry.fields.length === 0 || labelsOf(entry).some((label) => siblingLabels.has(label)));
        members.forEach((entry, i) => {
            const own = kinds[i];
            if (own !== null && own !== undefined) {
                out.set(entry, own);
            } else if (agreed && alike(entry, i)) {
                out.set(entry, kind);
            }
        });
    }
    return out;
}

function extractEntries(
    entries: readonly Entry[],
    out: EntityCollector,
    descriptions: Map<string, string>,
): number {
    const vehicles = new Set(entries.filter((entry) => addVehicle(out, entry)));
    const kinds = siblingKinds(
        entries.filter((entry) => !vehicles.has(entry)),
        entryType,
    );
    const typed = entries.flatMap((entry) => {
        const type = kinds.get(entry);
        return type === undefined ? [] : [{ entry, type }];
    });
    const modal = modalHeadingSizes(typed);
    const headingTypes = new Map<string, string>(typed.map(({ entry, type }) => [entry.heading.text, type]));
    let count = 0;
    for (const typedEntry of typed) {
        const { type } = typedEntry;
        let { entry } = typedEntry;
        const component =
            entry.fields.length === 0 && entry.heading.size < (modal.get(type) ?? 0) - SUBHEADING_STEP;
        if (component) {
            const kind = kindEntry(entry, headingTypes.get(entry.sections.at(-1) ?? ""), type);
            if (kind === null) {
                continue;
            }
            entry = kind;
        }
        const item = entryItem(entry, type);
        if (item.name.length === 0) {
            continue;
        }
        if (item.description.length > 0) {
            descriptions.set(nameKey(item.name), item.description);
        }
        out.add(
            "Item",
            itemSegment(type),
            buildItem({
                type,
                name: item.name,
                line: out.line,
                book: out.book,
                page: out.page(entry.heading.pageIndex),
                description: item.description,
                system: item.system,
                variantized: item.variantized,
            }),
            entry.heading.pageIndex,
            `${ENTRY_READING}${type}`,
        );
        count += 1;
    }
    return count;
}

function addOrigin(out: EntityCollector, origin: OriginPathReading): void {
    out.add(
        "Item",
        origin.step.segment,
        buildOriginPath({
            name: cleanName(origin.name),
            step: origin.step,
            line: out.line,
            book: out.book,
            page: out.page(origin.pageIndex),
            description: toHtml(origin.description),
            grants: origin.grants,
            characteristics: origin.modifiers,
            ...(origin.effect === undefined ? {} : { effectText: toHtml(origin.effect) }),
            ...(origin.xpCost === undefined ? {} : { xpCost: origin.xpCost }),
            ...(origin.requirements === undefined ? {} : { requirements: origin.requirements }),
        }),
        origin.pageIndex,
        origin.fromTable === true ? `table:origin:${origin.step.key}` : `origin:${origin.step.key}`,
    );
}

function extractOriginPaths(entries: readonly Entry[], out: EntityCollector): void {
    for (const origin of readOriginPaths(entries, out.target.originSteps)) {
        addOrigin(out, origin);
    }
}

/** A table row's cell texts in column order ("" for an empty cell). */
function rowTexts(row: TableRow, columns: number): string[] {
    return Array.from({ length: columns }, (_, col) => row.cells.find((c) => c.colIndex === col)?.text ?? "");
}

/** How many pages before its statblock a creature's own heading and prose may begin. */
const STATBLOCK_PROSE_REACH = 1;

/**
 * The prose entry introducing a statblock: the nearest heading of the same
 * name on the statblock's page or just before it. A same-named statblock with
 * no such heading (an illustration elsewhere in the book) gets none.
 */
export function introducingEntry(entries: readonly Entry[], name: string, pageIndex: number): Entry | null {
    const key = nameKey(name);
    let best: Entry | null = null;
    for (const e of entries) {
        const p = e.heading.pageIndex;
        if (nameKey(e.heading.text) === key && p <= pageIndex && p >= pageIndex - STATBLOCK_PROSE_REACH) {
            best = e;
        }
    }
    return best;
}

/** The words, in order, of the entries within a statblock's prose reach. */
function nearbyWords(entries: readonly Entry[], pageIndex: number): string[] {
    const near = entries.filter(
        (e) => e.heading.pageIndex <= pageIndex && e.heading.pageIndex >= pageIndex - STATBLOCK_PROSE_REACH,
    );
    return wordsOf(near.map((e) => `${e.heading.text} ${e.body}`).join(" "));
}

function extractActors(ir: IR, entries: readonly Entry[], out: EntityCollector): number {
    const grids = detectNumericGrids(ir);
    for (const grid of grids) {
        const npc = parseNpc(grid);
        for (const u of npc.unparsed) {
            out.warnings.push(`p${out.page(grid.pageIndex)} ${npc.name}: unparsed ${u}`);
        }
        const name = rejoinSplitWords(npc.name, nearbyWords(entries, grid.pageIndex));
        const intro = introducingEntry(entries, name, grid.pageIndex);
        out.add(
            "Actor",
            ACTOR_SEGMENT,
            buildNpc({
                name,
                actorType: out.target.actorTypes.npc,
                line: out.line,
                book: out.book,
                // Cited where its statblock is printed; its introduction may
                // begin a page earlier.
                page: out.page(grid.pageIndex),
                description: intro === null ? "" : toHtml(intro.body),
                system: npc.system,
            }),
            grid.pageIndex,
            "grid:npc",
        );
        // A statblock's named rules are traits of their own.
        for (const ability of npc.abilities) {
            out.add(
                "Item",
                itemSegment("trait"),
                buildItem({
                    type: "trait",
                    name: cleanName(ability.name),
                    line: out.line,
                    book: out.book,
                    page: out.page(ability.pageIndex),
                    description: toHtml(ability.text),
                    system: { benefit: toHtml(ability.text) },
                }),
                ability.pageIndex,
                "grid:trait",
            );
        }
    }
    return grids.length;
}

function isJsonObject(v: JsonValue | undefined): v is JsonObject {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A value that carries no authored information: null, "", [], or an object of only such values. */
export function isBlank(v: JsonValue | undefined): boolean {
    if (v === undefined || v === null || v === "") {
        return true;
    }
    if (Array.isArray(v)) {
        return v.length === 0;
    }
    return isJsonObject(v) && Object.values(v).every(isBlank);
}

/**
 * Field-wise union of two readings of the same entity: `base` wins wherever it
 * has authored content; `other` fills what `base` leaves blank, recursively.
 */
export function mergeInto(base: JsonObject, other: JsonObject): void {
    for (const [key, value] of Object.entries(other)) {
        const held = base[key];
        if (isBlank(held)) {
            base[key] = value;
        } else if (isJsonObject(held) && isJsonObject(value)) {
            mergeInto(held, value);
        }
    }
}

/** `system.source.<line>` of an entity, when it carries one. */
function sourceOf(e: Entity, line: Line): JsonObject | null {
    const system = e.fields["system"];
    const sources = isJsonObject(system) ? system["source"] : undefined;
    const own = isJsonObject(sources) ? sources[line] : undefined;
    return isJsonObject(own) ? own : null;
}

const TABLE_READING = "table:";
const ENTRY_READING = "entry:";

/** An entity's modification type, when it is one. */
function modificationType(e: Entity): ItemType | null {
    const type = e.fields["type"];
    return type === "weaponModification" || type === "armourModification" ? type : null;
}

/**
 * One table may list armour and weapon upgrades together. Each upgrade's own
 * entry says what it is used with, so a table row takes the modification type
 * of its same-named entry and joins it in that pack.
 */
export function fitModifications(entities: readonly Entity[], line: Line, book: string): void {
    const nameOf = (e: Entity): string => nameKey(String(e.fields["name"]));
    const entryTypes = new Map<string, ItemType>();
    for (const e of entities) {
        const type = modificationType(e);
        if (e.blockId.startsWith(ENTRY_READING) && type !== null) {
            entryTypes.set(nameOf(e), type);
        }
    }
    for (const e of entities) {
        const own = modificationType(e);
        const type = entryTypes.get(nameOf(e));
        if (e.blockId.startsWith(TABLE_READING) && own !== null && type !== undefined && type !== own) {
            e.fields["type"] = type;
            e.blockId = `${TABLE_READING}${type}`;
            e.pack = packName(line, book, itemSegment(type));
        }
    }
}

/**
 * An entity printed in several places is cited where it is catalogued: the
 * page of its summary-table row when it has one (a table lists the entity as
 * such, wherever its rules prose falls), otherwise the page its span starts on.
 */
export function citeFirstPage(head: Entity, readings: readonly Entity[], line: Line): void {
    const rows = readings.filter((e) => e.blockId.startsWith(TABLE_READING));
    const pool = rows.length > 0 ? rows : readings;
    const first = pool.reduce((a, b) => (b.provenance.pageIndex < a.provenance.pageIndex ? b : a));
    const target = sourceOf(head, line);
    const page = sourceOf(first, line)?.["page"];
    if (target !== null && page !== undefined) {
        target["page"] = page;
    }
}

/**
 * One document per (pack, name). A book often prints an entity twice — its
 * stat line in a table, its rules prose in an entry block — so same-named
 * readings are merged field-wise, the richest reading taking precedence.
 * Catalogue-entry prose is also attached to a same-named item in any pack
 * that has no description of its own.
 */
function consolidate(
    entities: readonly Entity[],
    descriptions: ReadonlyMap<string, string>,
    line: Line,
): Entity[] {
    const richness = (e: Entity): number => JSON.stringify(e.fields).length;
    const groups = new Map<string, Entity[]>();
    for (const e of entities) {
        const key = `${e.pack}\u0000${nameKey(String(e.fields["name"]))}`;
        groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const merged: Entity[] = [];
    for (const group of groups.values()) {
        const [head, ...rest] = [...group].sort((a, b) => richness(b) - richness(a) || a.ordinal - b.ordinal);
        if (head === undefined) {
            continue;
        }
        for (const e of rest) {
            mergeInto(head.fields, e.fields);
        }
        // A statblock is cited by its own entry; a same-named one elsewhere
        // (an illustration) does not move it.
        if (head.documentType === "Item") {
            citeFirstPage(head, group, line);
        }
        merged.push(head);
    }

    for (const e of merged) {
        const system = e.fields["system"];
        const html = descriptions.get(nameKey(String(e.fields["name"])));
        if (html !== undefined && isJsonObject(system) && isBlank(system["description"])) {
            system["description"] = { [line]: { value: html, chat: "", summary: "" } };
        }
    }
    return merged.sort((a, b) => a.ordinal - b.ordinal || byteCompare(a.blockId, b.blockId));
}

/**
 * Infer the document's compendium entities, written in `target`'s structure.
 * The engine never works out which game line a document belongs to: the
 * target is the user's choice of output schema.
 */
export function infer(ir: IR, log: Logger, target: TargetSchema): InferResult {
    const line = target.line;
    const book = inferBookSlug(ir);
    const numbering = inferPageNumbering(ir);
    log.info(`book "${book}", page offset ${numbering.offset}, target ${line}`);

    const out = new EntityCollector(target, book, numbering);
    const descriptions = new Map<string, string>();
    const { tables, unclassified, tableRuns } = extractTables(ir, out, log);
    const detected = detectEntries(ir, tableRuns);
    const entries = extractEntries(detected, out, descriptions);
    const grids = extractActors(ir, detected, out);
    extractOriginPaths(detected, out);
    fitModifications(out.entities, line, book);
    const entities = consolidate(out.entities, descriptions, line);
    log.info(
        `entities: ${entities.length} (${out.entities.length - entities.length} duplicates merged), ${out.warnings.length} unparsed cells`,
    );

    return {
        graph: { entities, warnings: out.warnings },
        line,
        book,
        pageNumbering: numbering,
        diagnostics: { tables, unclassifiedTables: unclassified, grids, entries, entities: entities.length },
    };
}
