// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from "../logger.ts";
import type { Entity, EntityGraph, FoundryDocumentType, JsonObject, JsonValue } from "../types/entity.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { byteCompare } from "../util/ordered.ts";
import { escapeHtml, NOTE_MARKERS } from "../util/text.ts";
import { inferBookSlug } from "./book.ts";
import { classifyTable } from "./classify.ts";
import {
    headerRole,
    isAdvanceList,
    isAttributeScale,
    mergedHeaderRoles,
    normalizeHeader,
    type Role,
    shipTableRoles,
} from "./columns.ts";
import { detectEntries, type Entry, runningHeads } from "./detect-entries.ts";
import { detectNumericGrids } from "./detect-grids.ts";
import { captionNames, detectStatRows } from "./detect-stat-rows.ts";
import { detectTables } from "./detect-tables.ts";
import { detectTitledTables } from "./detect-titled-tables.ts";
import { entryItem, entryType, joinSkillCharacteristics, typeNamedBy } from "./entry-types.ts";
import { inlineWeapons } from "./inline-weapons.ts";
import {
    cleanName,
    endsMidSentence,
    headingLabels,
    readsAsProse,
    rejoinSplitWords,
    splitTier,
    startsLikeName,
    stripHeadingLabel,
    wordsOf,
} from "./names.ts";
import { captionWeaponClass } from "./notation.ts";
import { parseNpc } from "./npc.ts";
import {
    type OriginPathReading,
    originStepNamedBy,
    readFieldedOrigins,
    readOriginPaths,
    readOriginTable,
} from "./origin-paths.ts";
import { inferPageNumbering, printedPage, type PageNumbering } from "./page-numbers.ts";
import { buildRollTable, rollResults } from "./roll-tables.ts";
import { mapRow, NO_DAMAGE, type RowCells, type RowMapping, rowType } from "./rows.ts";
import {
    ACTOR_SEGMENT,
    buildActor,
    buildItem,
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
import {
    hasShipHeader,
    headingHullType,
    isShipLabel,
    isShipProfile,
    parseShip,
    shipPairs,
} from "./voidcraft.ts";

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
    "ship-component": "shipComponent",
    "ship-weapon": "shipWeapon",
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
/** A name's key with a closing plural "s" dropped, so singular and plural forms share it. */
export function singularKey(name: string): string {
    return nameKey(name).replace(/(?<=[^s])s$/u, "");
}

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
    return shipTableRoles(
        table.headers.map((h) => {
            const role = headerRole(h);
            return role === null ? mergedHeaderRoles(h) : [role];
        }),
        table.headers,
    );
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
            continue;
        }
        const split = splitNumberFromText(text, cellRoles);
        if (split !== null) {
            cells[split.numberRole] = split.number;
            cells[split.textRole] = split.text;
        }
    }
    return cells;
}

/** Roles whose values are a bare count or rating. */
const NUMBER_ROLES: ReadonlySet<Role> = new Set([
    "armourPoints",
    "maxAgility",
    "penetration",
    "clip",
    "protection",
]);

/**
 * A merged cell of one counted role and one worded role ("Location(s) AP"),
 * whose wrapped text set the number among the words ("Head, Arms, 8 Body,
 * Legs"): its one bare number is the count, the rest the words. Null when the
 * roles are not one of each or the text holds no single bare number.
 */
export function splitNumberFromText(
    text: string,
    roles: readonly Role[],
): { numberRole: Role; number: string; textRole: Role; text: string } | null {
    const [first, second] = roles;
    if (roles.length !== 2 || first === undefined || second === undefined) {
        return null;
    }
    const numberRole = NUMBER_ROLES.has(first) ? first : NUMBER_ROLES.has(second) ? second : null;
    const textRole = numberRole === first ? second : first;
    if (numberRole === null || NUMBER_ROLES.has(textRole)) {
        return null;
    }
    const words = text.split(/\s+/u);
    const numbers = words.filter((w) => /^\d+$/u.test(w));
    if (numbers.length !== 1 || numbers[0] === undefined) {
        return null;
    }
    return {
        numberRole,
        number: numbers[0],
        textRole,
        text: words.filter((w) => w !== numbers[0]).join(" "),
    };
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
        // A captioned roll table is a RollTable, whatever items its rows also define.
        addRollTable(table, out);
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
        if (keyedByBands(table, nameCol)) {
            unclassified += 1;
            continue;
        }
        // A caption naming a tier ("… Tier 2 …") gives every row that tier.
        const captionTier = /\btier\s*(\d)\b/iu.exec(table.tableTitle ?? "")?.[1];
        // A weapon table with no class column takes the one class its caption names ("Melee Weapons").
        const captionClass = type === "weapon" ? captionWeaponClass(table.tableTitle ?? "") : null;
        // A section row groups the records under it; in a ship weapon table it
        // names their weapon type ("Lances").
        let section: string | null = null;
        const records: TableRecord[] = [];
        for (const row of table.rows) {
            if (row.isSectionHeader) {
                section = row.sectionName;
                continue;
            }
            if (row.isHeaderRow) {
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
            if (captionClass !== null && cells.class === undefined) {
                cells.class = captionClass;
            }
            const itemType = rowType(type, cells);
            if (itemType === null) {
                continue;
            }
            if (itemType === "shipWeapon" && cells.type === undefined && section !== null) {
                cells.type = section;
            }
            const mapped = mapRow(itemType, cells);
            for (const u of mapped.unparsed) {
                out.warnings.push(`p${out.page(table.pageIndex)} ${name}: unparsed ${u}`);
            }
            records.push({ name, itemType, cells, mapped });
        }
        for (const { name, itemType, mapped } of withSubProfiles(records)) {
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

/** One table row read as an item. */
export interface TableRecord {
    name: string;
    itemType: ItemType;
    cells: RowCells;
    mapped: RowMapping;
}

/** A sub-row's name: its weapon's name, then the profile's label in brackets. */
const SUB_ROW_NAME = /^(?<base>.+?)\s*\((?<label>[^()]+)\)$/u;

/** Whether a cell prints only a note marker ("†"): its value lies elsewhere. */
function defers(text: string | undefined): boolean {
    return text !== undefined && text.trim().length > 0 && text.replace(NOTE_MARKERS, "").trim() === "";
}

/** A weapon mode (the system's `modes[]` entry) from a sub-row's reading; blank fields inherit the weapon's. */
function modeOf(label: string, system: JsonObject): JsonObject {
    const damage = isJsonObject(system["damage"]) ? system["damage"] : {};
    const clip = isJsonObject(system["clip"]) ? system["clip"] : {};
    const attack = isJsonObject(system["attack"]) ? system["attack"] : {};
    const special = Array.isArray(system["special"]) ? system["special"] : [];
    return {
        label,
        damage:
            typeof damage["formula"] === "string" && damage["formula"] !== NO_DAMAGE ? damage["formula"] : "",
        damageType: typeof damage["type"] === "string" ? damage["type"] : "",
        damageBonus: typeof damage["bonus"] === "number" ? damage["bonus"] : null,
        penetration: typeof damage["penetration"] === "number" ? damage["penetration"] : null,
        range: null,
        addedQualities: special,
        removedQualities: [],
        weaponClass: "",
        attackType: "",
        characteristic: "",
        rateOfFire: isJsonObject(attack["rateOfFire"]) ? attack["rateOfFire"] : null,
        singleUse: false,
        clipMax: typeof clip["max"] === "number" ? clip["max"] : 0,
        reload: typeof system["reload"] === "string" && system["reload"] !== "-" ? system["reload"] : "",
    };
}

/**
 * A table's rows with each weapon's printed sub-profiles folded into it. A
 * weapon whose row defers its profile to the rows under it (its damage
 * cell prints only a note marker) takes those rows, named for it with a
 * label in brackets ("Lamp Rifle (Ember Round)"), as its modes; the first of
 * them is its own profile. Other rows pass through unchanged.
 */
export function withSubProfiles(records: readonly TableRecord[]): TableRecord[] {
    const out: TableRecord[] = [];
    for (const record of records) {
        const sub = SUB_ROW_NAME.exec(record.name)?.groups;
        const base = sub === undefined ? undefined : out.find((r) => r.name === sub["base"]);
        if (
            sub === undefined ||
            base === undefined ||
            base.itemType !== "weapon" ||
            record.itemType !== "weapon" ||
            !defers(base.cells.damage)
        ) {
            out.push(record);
            continue;
        }
        const system = base.mapped.system;
        const modes = Array.isArray(system["modes"]) ? system["modes"] : [];
        const mode = modeOf(sub["label"] ?? "", record.mapped.system);
        if (modes.length === 0) {
            // The first printed profile is the weapon's own.
            for (const field of ["damage", "clip", "reload"] as const) {
                const value = record.mapped.system[field];
                if (value !== undefined) {
                    system[field] = value;
                }
            }
            const attack = system["attack"];
            const rof = isJsonObject(record.mapped.system["attack"])
                ? record.mapped.system["attack"]["rateOfFire"]
                : undefined;
            if (isJsonObject(attack) && rof !== undefined) {
                attack["rateOfFire"] = rof;
            }
        }
        system["modes"] = [...modes, mode];
    }
    return out;
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

/** A heading or label naming a craft's weapons. */
const WEAPONS_LABEL = /^weapons?$/iu;
/** Pages after a vehicle's heading its parts may be printed on. */
const PART_PAGE_REACH = 1;

/**
 * The entries printed as parts of the entry at `index`: those after it, all in
 * one heading style other than its own, within a page — up to the next heading
 * in its style, the next profile, an entry typed as an item by its own fields,
 * or a heading in another style.
 */
function vehicleParts(entries: readonly Entry[], index: number, claimed: ReadonlySet<Entry>): Entry[] {
    const head = entries[index];
    if (head === undefined) {
        return [];
    }
    const parts: Entry[] = [];
    for (const entry of entries.slice(index + 1)) {
        const style = parts[0]?.heading.style;
        if (
            claimed.has(entry) ||
            entry.heading.style === head.heading.style ||
            (style !== undefined && entry.heading.style !== style) ||
            entry.heading.pageIndex - head.heading.pageIndex > PART_PAGE_REACH ||
            entryType(entry) !== null ||
            isVehicleProfile(panelPairs(entryText(entry)))
        ) {
            break;
        }
        parts.push(entry);
    }
    return parts;
}

/**
 * An entry carrying a vehicle profile is a land craft: its profile panel gives
 * the stat block, its prose the description, its other labelled rules the
 * special rules. `parts` are entries printed under it with headings of their
 * own (its weapons, its special rules): their labelled lines add the profile
 * fields its panel lacks, and their text joins its weapons and rules. Returns
 * false when the entry is no vehicle.
 */
function addVehicle(out: EntityCollector, entry: Entry, parts: readonly Entry[]): boolean {
    const pairs = panelPairs(entryText(entry));
    if (!isVehicleProfile(pairs)) {
        return false;
    }
    const headsWeapons = (part: Entry): boolean => WEAPONS_LABEL.test(part.heading.text.trim());
    for (const part of parts.filter((p) => !headsWeapons(p))) {
        for (const [label, value] of panelPairs(entryText(part))) {
            if (!pairs.has(label)) {
                pairs.set(label, value);
            }
        }
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
    const isProse = (text: string): boolean => /\p{Ll}/u.test(text);
    const rules: [string, string][] = [
        ...entry.fields,
        ...parts.flatMap((part): [string, string][] =>
            headsWeapons(part)
                ? [[part.heading.text.trim(), part.body.trim()]]
                : [
                      ...part.fields,
                      // A rule broken across columns runs on in the part's body.
                      ...part.body
                          .split(PARAGRAPH_SPLIT)
                          .filter(isProse)
                          .map((p): [string, string] => [part.heading.text.trim(), p.trim()]),
                  ],
        ),
    ].filter(([label]) => isProse(label));
    const isWeapons = ([label]: [string, string]): boolean => WEAPONS_LABEL.test(label);
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

/**
 * An entry carrying a ship profile is a voidcraft: its profile gives the stat
 * block, its prose and its other labelled rules the description. `hullHint`
 * is the hull type a heading above it names. Returns false when the entry is
 * no ship.
 */
function addShip(
    out: EntityCollector,
    entry: Entry,
    pairs: ReadonlyMap<string, string>,
    rules: readonly (readonly [string, string])[],
    hullHint: string | null,
): boolean {
    if (!isShipProfile(pairs)) {
        return false;
    }
    const name = cleanName(entry.heading.text);
    if (!startsLikeName(name) || readsAsProse(name) || endsMidSentence(name)) {
        return false;
    }
    const { system, unparsed } = parseShip(pairs, hullHint);
    for (const u of unparsed) {
        out.warnings.push(`p${out.page(entry.heading.pageIndex)} ${name}: unparsed ${u}`);
    }
    out.add(
        "Actor",
        CRAFT_SEGMENT.voidcraft,
        buildActor({
            actorType: out.target.actorTypes.voidcraft,
            name,
            line: out.line,
            book: out.book,
            page: out.page(entry.heading.pageIndex),
            description: toHtml(
                [entry.body, ...rules.map(([label, value]) => `${label}: ${value}`)].join("\n\n"),
            ),
            system,
        }),
        entry.heading.pageIndex,
        "entry:voidcraft",
    );
    return true;
}

/**
 * Ship entries, each added as a voidcraft. A section heading naming a hull
 * type ("Cruiser Hulls") gives the hull type of the ships in it; a smaller
 * heading naming one ("Frigates") gives it to the ships after it, until
 * another does or a larger heading that is no ship opens a new section.
 *
 * A ship's header printed with no profile waits for one: the next entry
 * printing a profile but no header, within a page, is its profile — sidebars
 * and boxed text set between the two in reading order head it otherwise.
 */
const PROFILE_PAGE_REACH = 1;
function addShips(out: EntityCollector, entries: readonly Entry[]): Set<Entry> {
    const ships = new Set<Entry>();
    const pairs = entries.map((e) => shipPairs(e.fields, e.body));
    const rules = (e: Entry): [string, string][] => e.fields.filter(([label]) => !isShipLabel(label));
    let hull: { type: string; size: number } | null = null;
    let waiting: { entry: Entry; pairs: Map<string, string>; hint: string | null } | null = null;
    entries.forEach((entry, i) => {
        const named = headingHullType(entry.heading.text);
        if (named !== null) {
            hull = { type: named, size: entry.heading.size };
            return;
        }
        // The nearest enclosing section naming a hull type gives it outright.
        const section = entry.sections.map(headingHullType).findLast((t) => t !== null) ?? null;
        const hint = section ?? hull?.type ?? null;
        const own = pairs[i] ?? new Map<string, string>();
        if (
            waiting !== null &&
            isShipProfile(own) &&
            !hasShipHeader(own) &&
            entry.heading.pageIndex - waiting.entry.heading.pageIndex <= PROFILE_PAGE_REACH
        ) {
            const profile = new Map([...own, ...waiting.pairs]);
            const printedRules = [...rules(waiting.entry), ...rules(entry)];
            if (addShip(out, waiting.entry, profile, printedRules, waiting.hint)) {
                ships.add(waiting.entry).add(entry);
                waiting = null;
                return;
            }
        }
        if (hasShipHeader(own) && !isShipProfile(own)) {
            waiting = { entry, pairs: own, hint };
            return;
        }
        if (addShip(out, entry, own, rules(entry), hint)) {
            ships.add(entry);
            waiting = null;
        } else if (hull !== null && entry.heading.size > hull.size) {
            hull = null;
        }
    });
    return ships;
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
    const ships = addShips(out, entries);
    const vehicles = new Set<Entry>();
    entries.forEach((entry, i) => {
        if (ships.has(entry) || vehicles.has(entry)) {
            return;
        }
        const parts = vehicleParts(entries, i, ships);
        if (addVehicle(out, entry, parts)) {
            vehicles.add(entry);
            for (const part of parts) {
                vehicles.add(part);
            }
        }
    });
    const kinds = siblingKinds(
        entries.filter((entry) => !vehicles.has(entry) && !ships.has(entry)),
        entryType,
    );
    const typed = entries.flatMap((entry) => {
        const type = kinds.get(entry);
        return type === undefined ? [] : [{ entry, type }];
    });
    const modal = modalHeadingSizes(typed);
    const headingTypes = new Map<string, string>(typed.map(({ entry, type }) => [entry.heading.text, type]));
    const labels = headingLabels(typed.map(({ entry }) => entry.heading.text));
    let count = 0;
    for (const typedEntry of typed) {
        const { type } = typedEntry;
        let { entry } = typedEntry;
        entry = {
            ...entry,
            heading: { ...entry.heading, text: stripHeadingLabel(entry.heading.text, labels) },
        };
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

/** The reading that names an item from a profile printed inline (see `inline-weapons.ts`). */
const INLINE_READING = "inline:";
/** A parenthesized qualifier closing a name ("Hammer (heavy)"). */
const QUALIFIER = /\s*\([^()]*\)\s*$/u;

/** Name keys of items already read: each name, and each without a closing qualifier. */
export function givenNames(names: readonly string[]): Set<string> {
    return new Set(names.flatMap((name) => [nameKey(name), nameKey(name.replace(QUALIFIER, ""))]));
}

/**
 * Weapons whose profile is printed only inline — in a statblock's weapon
 * list or running text — and that no table or entry gives: each is read from
 * its bracketed profile, cited at the entry printing it. A weapon some other
 * reading gives keeps that reading and its citation — and so does one some
 * other reading gives only as qualified variants ("Hammer (light)",
 * "Hammer (heavy)"): a statblock's "hammer" is one of those, not another.
 */
function extractInlineWeapons(entries: readonly Entry[], out: EntityCollector): number {
    const named = givenNames(
        out.entities.filter((e) => e.documentType === "Item").map((e) => String(e.fields["name"])),
    );
    let count = 0;
    for (const entry of entries) {
        const text = [entry.body, ...entry.fields.map(([label, value]) => `${label}: ${value}`)].join("\n");
        for (const weapon of inlineWeapons(text)) {
            const key = nameKey(weapon.name);
            if (named.has(key)) {
                continue;
            }
            named.add(key);
            const mapped = mapRow("weapon", weapon.cells);
            out.add(
                "Item",
                itemSegment("weapon"),
                buildItem({
                    type: "weapon",
                    name: weapon.name,
                    line: out.line,
                    book: out.book,
                    page: out.page(entry.heading.pageIndex),
                    description: "",
                    system: mapped.system,
                    variantized: mapped.variantized,
                }),
                entry.heading.pageIndex,
                `${INLINE_READING}weapon`,
            );
            count += 1;
        }
    }
    return count;
}

function extractOriginPaths(
    entries: readonly Entry[],
    heads: ReadonlyMap<number, readonly string[]>,
    out: EntityCollector,
): void {
    for (const origin of [
        ...readOriginPaths(entries, out.target.originSteps, heads),
        ...readFieldedOrigins(entries, out.target.originSteps),
    ]) {
        addOrigin(out, origin);
    }
}

/** A table row's cell texts in column order ("" for an empty cell). */
/** Share of a table's rows whose name cell opens with a number band for it to list results. */
const BANDED_SHARE = 2 / 3;
/** A cell opening with a number or band ("01–30", "1-2 Degrees …", "5+ …"): a result key. */
const BAND_LEAD = /^\d+(?:\s*[-–]\s*\d+)?\+?(?!\d)(?:\s|$)/u;

/**
 * A table whose name column mostly opens with number bands keys results by a
 * roll or a margin ("1-2 Degrees of Success"); its rows are outcomes, not
 * catalogue items.
 */
export function keyedByBands(table: DetectedTable, nameCol: number): boolean {
    const names = table.rows
        .filter((r) => !r.isHeaderRow && !r.isSectionHeader)
        .map((r) => r.cells.find((c) => c.colIndex === nameCol)?.text.trim() ?? "")
        .filter((t) => t.length > 0);
    return names.length > 0 && names.filter((t) => BAND_LEAD.test(t)).length >= BANDED_SHARE * names.length;
}

/** Pack segment roll tables are emitted into. */
const ROLL_TABLE_SEGMENT = "rolltables";

/** Emit a captioned table whose rows are die results as a RollTable. */
function addRollTable(table: DetectedTable, out: EntityCollector): void {
    if (table.tableTitle === null) {
        return;
    }
    const rows = table.rows
        .filter((r) => !r.isHeaderRow && !r.isSectionHeader)
        .map((r) => rowTexts(r, table.headers.length));
    const roll = rollResults(rows);
    if (roll === null) {
        return;
    }
    out.add(
        "RollTable",
        ROLL_TABLE_SEGMENT,
        buildRollTable({
            name: cleanName(table.tableTitle),
            line: out.line,
            book: out.book,
            page: out.page(table.pageIndex),
            die: roll.die,
            results: roll.results,
        }),
        table.pageIndex,
        "table:roll",
    );
}

function rowTexts(row: TableRow, columns: number): string[] {
    return Array.from({ length: columns }, (_, col) => row.cells.find((c) => c.colIndex === col)?.text ?? "");
}

/** How many pages before its statblock a creature's own heading and prose may begin. */
const STATBLOCK_PROSE_REACH = 1;
/**
 * Share of grid banners ending in one word for it to be their label. Banners
 * carry real names, which may share a last word by chance, so nearly all must.
 */
const GRID_BANNER_WORD_SHARE = 0.8;

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

/** A name's words, lower-cased, a possessive ending dropped. */
const nameWords = (name: string): string[] =>
    name
        .toLowerCase()
        .replace(/['’]s\b/gu, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0);

/**
 * The prose entry whose heading a statblock's caption shortens: the nearest
 * heading within reach holding every word of the caption and more ("Repair
 * Servitor" under "Industrial or Heavy Repair Servitor"). Its heading is the
 * fuller printed name.
 */
export function namingEntry(
    entries: readonly Entry[],
    caption: string,
    captionLine: string,
    pageIndex: number,
): Entry | null {
    const words = nameWords(caption);
    let best: Entry | null = null;
    for (const e of entries) {
        const p = e.heading.pageIndex;
        const heading = new Set(nameWords(e.heading.text));
        if (
            // The caption line itself may read as a heading; it names nothing more.
            nameKey(e.heading.text) !== nameKey(captionLine) &&
            p <= pageIndex &&
            p >= pageIndex - STATBLOCK_PROSE_REACH &&
            words.length > 0 &&
            heading.size > words.length &&
            words.every((w) => heading.has(w))
        ) {
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
    // Statblocks print their characteristics as a grid or as a row. A label
    // nearly every grid's banner carries ("… Profile") is no part of a name;
    // row captions already drop theirs.
    const numeric = detectNumericGrids(ir);
    const grids = [...numeric, ...detectStatRows(ir)];
    const npcs = grids.map(parseNpc);
    const bannerNames = captionNames(
        npcs.slice(0, numeric.length).map((n) => n.name),
        GRID_BANNER_WORD_SHARE,
    );
    for (const [i, grid] of grids.entries()) {
        const parsed = npcs[i];
        if (parsed === undefined) {
            continue;
        }
        const npc = { ...parsed, name: bannerNames[i] ?? parsed.name };
        for (const u of npc.unparsed) {
            out.warnings.push(`p${out.page(grid.pageIndex)} ${npc.name}: unparsed ${u}`);
        }
        const caption = rejoinSplitWords(npc.name, nearbyWords(entries, grid.pageIndex));
        const exact = introducingEntry(entries, caption, grid.pageIndex);
        // A grid's banner prints the full name; a row's caption may shorten its heading.
        const naming =
            exact === null && grid.caption !== null
                ? namingEntry(entries, caption, grid.caption, grid.pageIndex)
                : null;
        const intro = exact ?? naming;
        // A naming heading may carry the tier the statblock itself does not print.
        const fromHeading = naming === null ? null : splitTier(naming.heading.text);
        const name = fromHeading?.name ?? caption;
        const system =
            fromHeading !== null && fromHeading.tier !== null && npc.system["tier"] === undefined
                ? { ...npc.system, tier: fromHeading.tier }
                : npc.system;
        out.add(
            "Actor",
            ACTOR_SEGMENT,
            buildActor({
                name,
                actorType: out.target.actorTypes.npc,
                line: out.line,
                book: out.book,
                // Cited where its statblock is printed; its introduction may
                // begin a page earlier.
                page: out.page(grid.pageIndex),
                description: intro === null ? "" : toHtml(intro.body),
                system,
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
 * A name printed singular in one reading and plural in another (a table row
 * "Wick Rocket", its entry "Wick Rockets") is the same name. Catalogue-entry
 * prose is also attached to a same-named item in any pack that has no
 * description of its own.
 */
function consolidate(
    entities: readonly Entity[],
    descriptions: ReadonlyMap<string, string>,
    line: Line,
): Entity[] {
    const richness = (e: Entity): number => JSON.stringify(e.fields).length;
    const groups = new Map<string, Entity[]>();
    for (const e of entities) {
        const key = `${e.pack}\u0000${singularKey(String(e.fields["name"]))}`;
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
    const entries = extractEntries(joinSkillCharacteristics(detected), out, descriptions);
    const grids = extractActors(ir, detected, out);
    extractOriginPaths(detected, runningHeads(ir), out);
    const inline = extractInlineWeapons(detected, out);
    log.info(`inline weapon profiles: ${inline}`);
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
