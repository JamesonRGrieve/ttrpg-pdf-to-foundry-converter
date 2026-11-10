// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from "../logger.ts";
import type { Entity, EntityGraph, FoundryDocumentType, JsonObject, JsonValue } from "../types/entity.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { id16 } from "../util/hash.ts";
import { byteCompare } from "../util/ordered.ts";
import { escapeHtml, NOTE_MARKERS } from "../util/text.ts";
import { applyAmmunitionEffects, applyAmmunitionWeaponTypes, usedWithArmourTypes } from "./ammunition.ts";
import { inferBookSlug, inferBookTitle } from "./book.ts";
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
import { applyCuePresets } from "./cue-presets.ts";
import { applyCyberneticTypes } from "./cybernetic-types.ts";
import { detectEntries, type Entry, runningHeads } from "./detect-entries.ts";
import { detectNumericGrids } from "./detect-grids.ts";
import { captionNames, detectStatRows } from "./detect-stat-rows.ts";
import { detectTables } from "./detect-tables.ts";
import { detectTitledTables } from "./detect-titled-tables.ts";
import {
    applyFocusSkillCharacteristics,
    CHARACTERISTICS,
    entryItem,
    entryType,
    joinPactGroups,
    joinSkillCharacteristics,
    namesGearCategory,
    splitModificationLists,
    splitTalentLists,
    typeNamedBy,
    withDisciplines,
} from "./entry-types.ts";
import { applyDefaultIcons } from "./icons.ts";
import { applyIdentifiers } from "./identifiers.ts";
import { inlineWeapons } from "./inline-weapons.ts";
import { withLigaturesJoined, withLostLettersRestored } from "./ligatures.ts";
import {
    cleanName,
    endsMidSentence,
    headingLabels,
    readsAsProse,
    rejoinSplitWords,
    splitTier,
    startsLikeName,
    stripHeadingLabel,
    titleCase,
    wordsOf,
} from "./names.ts";
import {
    captionWeaponClass,
    parseArmourType,
    parseGearCategory,
    parseShipComponentType,
    parseWeaponType,
    splitTrailingClass,
} from "./notation.ts";
import {
    listedBase,
    type NpcItem,
    type ParsedNpc,
    parseNpc,
    reinforcementTerms,
    rejoinSmallCaps,
} from "./npc.ts";
import { applyOrderTests } from "./order-tests.ts";
import {
    type OriginPathReading,
    type OriginRule,
    originStepNamedBy,
    readFieldedOrigins,
    readInlineOrigins,
    readOriginAbilities,
    readOriginPaths,
    namesOriginStep,
    pairsSteps,
    readEffectOrigins,
    withCitedOrigins,
    readOriginTable,
    sameOrigin,
    withSkillLevelBase,
} from "./origin-paths.ts";
import { applyOriginPrerequisites } from "./origin-prerequisites.ts";
import { inferPageNumbering, printedPage, type PageNumbering } from "./page-numbers.ts";
import { isWeaponNameLine, panelWeapons } from "./panel-weapons.ts";
import { variantGrid } from "./profile-variants.ts";
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
    sourceBookLabel,
    toHtml,
    type ItemType,
    type Line,
} from "./schema.ts";
import { baseSkillLevel, type TargetSchema } from "./targets.ts";
import { applyTwoHandedClasses, twoHandedClasses } from "./two-handed.ts";
import type { ContentType, DetectedNumericGrid, DetectedTable, TableRow } from "./types.ts";
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
    /** Each ammunition's printed `Used With` line, by its name key (see `applyAmmunitionWeaponTypes`). */
    readonly usedWith = new Map<string, string>();
    readonly line: Line;

    constructor(
        readonly target: TargetSchema,
        /** The book's slug: names the packs. */
        readonly book: string,
        readonly numbering: PageNumbering,
        /** The book as its documents' source records cite it ("DH2: <title>"). */
        readonly sourceBook: string,
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
    const graded = type === "criticalInjury" ? criticalEffects(table) : null;
    out.add(
        "Item",
        itemSegment(type),
        buildItem({
            type,
            name,
            line: out.line,
            book: out.sourceBook,
            page: out.page(table.pageIndex),
            // A critical injury keeps its graded effects in the schema's own
            // fields; the printed table is its description.
            description: graded === null ? "" : effect,
            system: graded ?? {},
            variantized: graded === null ? { effect } : {},
        }),
        table.pageIndex,
        `table-item:${type}`,
    );
}

/** The system's critical injury damage types and body parts (its `damageType` / `bodyPart` choices). */
const CRITICAL_DAMAGE_TYPES = ["impact", "rending", "explosive", "energy"] as const;
const CRITICAL_BODY_PARTS = ["head", "arm", "body", "leg"] as const;
/** Fewest graded rows a severity table keeps for its effects to be read. */
const MIN_GRADES = 3;

/**
 * A severity table read into the schema's critical injury: the damage type
 * and body part its caption names, and each row's effect under its damage
 * figure (`effects.<n>.text`), permanent where the effect says so. Null when
 * its rows are not keyed by single damage figures.
 */
export function criticalEffects(table: DetectedTable): JsonObject | null {
    const words = (table.tableTitle ?? "").toLowerCase().split(/[^a-z]+/u);
    const pick = <T extends string>(choices: readonly T[]): T | undefined =>
        choices.find((c) => words.includes(c) || words.includes(`${c}s`));
    const effects: JsonObject = {};
    for (const row of table.rows.filter((r) => !r.isHeaderRow && !r.isSectionHeader)) {
        const cells = [...row.cells].sort((a, b) => a.colIndex - b.colIndex).map((c) => c.text.trim());
        const grade = /^(\d{1,2})\+?$/u.exec(cells[0] ?? "")?.[1];
        const text = cells.slice(1).join(" ").trim();
        if (grade === undefined || text.length === 0) {
            continue;
        }
        effects[String(Number(grade))] = { text: toHtml(text), permanent: /\bpermanent/iu.test(text) };
    }
    if (Object.keys(effects).length < MIN_GRADES) {
        return null;
    }
    const damageType = pick(CRITICAL_DAMAGE_TYPES);
    const bodyPart = pick(CRITICAL_BODY_PARTS);
    return {
        ...(damageType === undefined ? {} : { damageType }),
        ...(bodyPart === undefined ? {} : { bodyPart }),
        severity: 1,
        effects,
    };
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
                    book: out.sourceBook,
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

/** A column header citing pages ("Page", "Pg."): its rows point to where each entry is printed. */
const PAGE_HEADER = /^(?:pages?|pgs?\.?)$/iu;

function extractTables(
    ir: IR,
    out: EntityCollector,
    log: Logger,
): { tables: number; unclassified: number; tableRuns: Set<IRTextRun> } {
    const titled = detectTitledTables(ir);
    const titledPages = new Set(titled.map((t) => t.pageIndex));
    const tables = continuedTables([
        ...titled,
        ...detectTables(ir).filter((t) => !titledPages.has(t.pageIndex)),
    ]);
    let unclassified = 0;
    const carried = carriedSections(tables);
    // The document's running text, lower-cased, read once when a row needs it.
    let text: string | undefined;
    const documentText = (): string => {
        text ??= ir.runs
            .map((r) => r.text)
            .join(" ")
            .replace(/\s+/gu, " ")
            .toLowerCase();
        return text;
    };
    for (const table of tables) {
        // A captioned roll table is a RollTable, whatever items its rows also define.
        addRollTable(table, out);
        // A caption naming a creation step ("Random Home World", "Divinations")
        // lists origins of that step — unless a page column makes it an index
        // of origins described elsewhere, each read where it is printed.
        const originStep = originStepNamedBy(table.tableTitle ?? "", out.target.originSteps);
        // So does a table pairing the caption's step with another.
        const index =
            table.headers.some((h) => PAGE_HEADER.test(h.trim())) ||
            pairsSteps(originStep, table.headers, out.target.originSteps);
        if (originStep !== null && index) {
            unclassified += 1;
            continue;
        }
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
        // A name column headed by a creation step ("Home World or Origin")
        // lists that step's origins (their costs, say), not catalogue items.
        if (namesOriginStep(table.headers[0] ?? "", out.target.originSteps)) {
            unclassified += 1;
            continue;
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
        const sectionQualified = qualifiedBySection(table, nameCol);
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
        let section: string | null = carried.get(table) ?? null;
        const records: TableRecord[] = [];
        for (const row of table.rows) {
            if (row.isSectionHeader) {
                section = row.sectionName;
                continue;
            }
            if (row.isHeaderRow) {
                continue;
            }
            if (type === "weapon" && isUnmarkedSectionRow(row, table.headers.length)) {
                section = row.cells
                    .map((c) => c.text.trim())
                    .filter((t) => t !== "")
                    .join(" ");
                continue;
            }
            const rawName = row.cells.find((c) => c.colIndex === nameCol)?.text ?? "";
            const cleaned = cleanName(rawName);
            // A weapon table set without a class column's header leaves each
            // class in the name cell ("Bonesword Melee").
            const hasClassColumn = roles.some((r) => r?.includes("class") === true);
            const classInName = type === "weapon" && !hasClassColumn ? splitTrailingClass(cleaned) : null;
            const name = sectionQualified.get(row) ?? classInName?.name ?? cleaned;
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
            let fullName = name;
            if (captionTier !== undefined && cells.tier === undefined) {
                cells.tier = captionTier;
            }
            if (classInName !== null) {
                cells.class = classInName.cls;
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
            // A weapon's technology type is named by the section row it sits
            // under ("Las Weapons"), else by the table's caption.
            if (itemType === "weapon" && mapped.system["type"] === undefined) {
                const weaponType =
                    (section === null ? null : parseWeaponType(section)) ??
                    parseWeaponType(table.tableTitle ?? "");
                if (weaponType !== null) {
                    mapped.system["type"] = weaponType;
                }
            }
            // A row naming only its kind's variety ("Frag" under "Grenades")
            // takes the full name the document prints for it.
            if (itemType === "weapon") {
                fullName = kindNamed(name, mapped.system["type"], documentText());
            }
            // An armour's type is named by its section row ("Carapace Armour"),
            // else the caption, else its own name ("Flak Cloak").
            if (itemType === "armour" && mapped.system["type"] === undefined) {
                const armourType =
                    (section === null ? null : parseArmourType(section)) ??
                    parseArmourType(table.tableTitle ?? "") ??
                    parseArmourType(name);
                if (armourType !== null) {
                    mapped.system["type"] = armourType;
                }
            }
            // A ship component's type is named by its section row ("Plasma
            // Drives"), else by the caption ("Supplemental Components").
            if (itemType === "shipComponent" && mapped.system["componentType"] === undefined) {
                const componentType =
                    (section === null ? null : parseShipComponentType(section)) ??
                    parseShipComponentType(table.tableTitle ?? "");
                if (componentType !== null) {
                    mapped.system["componentType"] = componentType;
                }
            }
            // A caption naming its components essential ("Essential
            // Components") says each is one a ship must carry: the schema's flag.
            if (
                itemType === "shipComponent" &&
                parseShipComponentType(table.tableTitle ?? "") === "essential"
            ) {
                mapped.system["essential"] = true;
            }
            // A gear table's caption names its items' category ("Tools").
            if (itemType === "gear" && mapped.system["category"] === undefined) {
                const category = parseGearCategory(table.tableTitle ?? "");
                if (category !== null) {
                    mapped.system["category"] = category;
                }
            }
            for (const u of mapped.unparsed) {
                out.warnings.push(`p${out.page(table.pageIndex)} ${name}: unparsed ${u}`);
            }
            records.push({ name: fullName, itemType, cells, mapped });
            // An ammunition's Used With cell is read as its printed `Used With` line.
            const usedWith = cells.usedWith?.trim();
            if (itemType === "ammunition" && usedWith !== undefined && /\p{L}/u.test(usedWith)) {
                out.usedWith.set(nameKey(fullName), usedWith);
            }
        }
        // A row keyed by a roll is a result the table points to, not where the item is catalogued.
        const rolled = roles.some((r) => r?.includes("roll") === true);
        for (const { name, itemType, mapped } of withSubProfiles(distinguishRepeats(records))) {
            out.add(
                "Item",
                itemSegment(itemType),
                buildItem({
                    type: itemType,
                    name,
                    line: out.line,
                    book: out.sourceBook,
                    page: out.page(table.pageIndex),
                    description: "",
                    system: mapped.system,
                    variantized: mapped.variantized,
                }),
                table.pageIndex,
                `${TABLE_READING}${itemType}${rolled ? ROLLED_ROW : ""}`,
            );
        }
    }
    log.info(`tables: ${tables.length} detected, ${unclassified} unclassified`);
    return { tables: tables.length, unclassified, tableRuns: new Set(titled.flatMap((t) => t.runs)) };
}

/**
 * The schema's weapon types that name a kind of object rather than a
 * technology: a row under them may print only its variety ("Frag" under
 * "Grenades").
 */
const KIND_WEAPON_TYPES: ReadonlySet<string> = new Set(["grenade"]);

/**
 * A weapon row naming only its variety under a section of a kind (`type`
 * "grenade"): its name with the kind's noun, when the document prints that
 * full name ("frag grenade(s)") — a variety whose own name ends on another
 * noun ("Fire Bomb") is never printed so, and keeps its name.
 */
export function kindNamed(name: string, type: JsonValue | undefined, text: string): string {
    if (typeof type !== "string" || !KIND_WEAPON_TYPES.has(type)) {
        return name;
    }
    const words = name.toLowerCase().split(/[^\p{L}]+/u);
    if (words.includes(type) || words.includes(`${type}s`)) {
        return name;
    }
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const printed = new RegExp(`(?:^|[^\\p{L}])${escaped}\\s+${type}s?(?![\\p{L}])`, "u");
    return printed.test(text) ? `${name} ${type.charAt(0).toUpperCase()}${type.slice(1)}` : name;
}

/** One table row read as an item. */
export interface TableRecord {
    name: string;
    itemType: ItemType;
    cells: RowCells;
    mapped: RowMapping;
}

/**
 * A record a table repeats under the same name with other values (a
 * component's figures for each hull size, a row per size) is another record
 * of that thing: each repeat is named by the first cell that differs from the
 * name's first row ("Wick Lamp (Large)"), so it is not merged into the first.
 * A weapon's repeated rows are its profiles (`withSubProfiles`) and keep their
 * name; an identical repeat stays a duplicate.
 */
export function distinguishRepeats(records: readonly TableRecord[]): TableRecord[] {
    const first = new Map<string, TableRecord>();
    return records.map((record) => {
        const key = nameKey(record.name);
        const base = first.get(key);
        if (base === undefined) {
            first.set(key, record);
            return record;
        }
        if (record.itemType === "weapon") {
            return record;
        }
        const differing = (Object.keys(record.cells) as (keyof RowCells)[]).find(
            (role) =>
                role !== "name" &&
                (record.cells[role] ?? "").trim() !== "" &&
                record.cells[role]?.trim() !== base.cells[role]?.trim(),
        );
        const value = differing === undefined ? undefined : record.cells[differing]?.trim();
        return value === undefined ? record : { ...record, name: `${record.name} (${value})` };
    });
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

/**
 * Whether a field-less entry set smaller than its type's usual heading
 * (`modalSize`) is a part of the entry of that type it sits under rather
 * than an item of its own (or, under no entry of its type, furniture, unless
 * it is set like its own section's run of such entries). A
 * list's run-in entry is set as the list sets it, never a part; nor is one
 * set in the style its parent's own siblings are set in — a parent printed
 * larger than its siblings only seems to hold the siblings after it.
 */
export function isComponent(
    entry: Entry,
    entries: readonly Entry[],
    type: string,
    headingTypes: ReadonlyMap<string, string>,
    modalSize: number,
): boolean {
    if (
        entry.listedAs !== undefined ||
        entry.fields.length > 0 ||
        entry.heading.size >= modalSize - SUBHEADING_STEP
    ) {
        return false;
    }
    const parent = enclosingEntry(entries, entry);
    if (parent === null || headingTypes.get(parent.heading.text) !== type) {
        return !inSectionStyle(entry, entries, type, headingTypes);
    }
    const sameSections = (e: Entry): boolean =>
        e.sections.length === parent.sections.length && e.sections.every((s, i) => s === parent.sections[i]);
    return !entries
        .slice(0, entries.indexOf(parent))
        .some((e) => sameSections(e) && e.heading.style === entry.heading.style);
}

/**
 * Whether an entry is set in the heading style its type's entries are usually
 * set in within its own section (the entries under the same sections, nested
 * ones included): a catalogue printed smaller than the type's entries elsewhere
 * in the document ("Conditions" in a chapter whose larger ones are vehicle
 * damage) is still that section's run of entries, not furniture. The style must
 * be shared by a few of them and by more than any other style there, and each
 * must describe itself in running text (an index's lines, set alike, hold page
 * numbers).
 */
function inSectionStyle(
    entry: Entry,
    entries: readonly Entry[],
    type: string,
    headingTypes: ReadonlyMap<string, string>,
): boolean {
    const described = (e: Entry): boolean => {
        const words = e.body.match(/\p{L}{2,}/gu)?.length ?? 0;
        const numbers = e.body.match(/\p{N}+/gu)?.length ?? 0;
        return words >= DESCRIBED_WORDS && numbers * PAGE_NUMBER_SHARE <= words;
    };
    if (!described(entry)) {
        return false;
    }
    const scope = entry.sections;
    const counts = new Map<string, number>();
    for (const e of entries) {
        if (
            e.sections.length >= scope.length &&
            scope.every((s, i) => e.sections[i] === s) &&
            headingTypes.get(e.heading.text) === type &&
            described(e)
        ) {
            counts.set(e.heading.style, (counts.get(e.heading.style) ?? 0) + 1);
        }
    }
    const own = counts.get(entry.heading.style) ?? 0;
    return (
        own >= MIN_TYPED_SIBLINGS &&
        [...counts].every(([style, n]) => style === entry.heading.style || n < own)
    );
}

/** The words of running text from which an entry's body describes it. */
const DESCRIBED_WORDS = 8;
/** Running text holds at most one number to this many words; an index's lines hold a page number to every few. */
const PAGE_NUMBER_SHARE = 4;

/** An entry's printed text — its `Label: value` lines, then its body — one line per field. */
function entryText(entry: Entry): string {
    return [...entry.fields.map(([label, value]) => `${label}: ${value}`), entry.body].join("\n");
}

/** A heading or label naming a craft's weapons. */
const WEAPONS_LABEL = /^weapons?$/iu;
/** Pages after a vehicle's heading its parts may be printed on. */
const PART_PAGE_REACH = 1;
/** The label a craft's weapons are kept under among its rules. */
const WEAPONS_RULE = "Weapons";
/** A weapon profile's qualities line. */
const QUALITIES_LABEL = /^special$/iu;

const headsWeapons = (part: Entry): boolean => WEAPONS_LABEL.test(part.heading.text.trim());

/** An entry's heading and body lines, small capitals rejoined. */
const profileLines = (entry: Entry): string[] =>
    [entry.heading.text, ...entry.body.split(/\n+/u)].map(rejoinSmallCaps);

/** An entry headed by a weapon's name line ("NAME  CLASS HEAVY"), its profile beneath. */
function isWeaponProfile(entry: Entry): boolean {
    return (
        isWeaponNameLine(rejoinSmallCaps(entry.heading.text)) && panelWeapons(profileLines(entry)).length > 0
    );
}

/** A boxed weapon profile printed in a craft's own text, under no weapons heading: its lines from the first name line on. */
export function ownProfileText(entry: Entry): string | null {
    const lines = entry.body.split(/\n+/u);
    const first = lines.findIndex((line) => isWeaponNameLine(rejoinSmallCaps(line)));
    return first < 0 ? null : lines.slice(first).join("\n");
}

/**
 * A boxed weapon profile entry as panel lines: each weapon's name line and
 * profile lines, then its qualities. The entry's qualities fields are dealt
 * out in order, one before each later weapon's name line, the rest at the end.
 */
export function weaponProfileText(entry: Entry): string {
    const specials = entry.fields.filter(([label]) => QUALITIES_LABEL.test(label.trim()));
    const lines: string[] = [];
    let named = 0;
    for (const line of profileLines(entry)) {
        if (isWeaponNameLine(line)) {
            const special = named > 0 ? specials.shift() : undefined;
            if (special !== undefined) {
                lines.push(`${special[0]}: ${special[1]}`);
            }
            named += 1;
        }
        lines.push(line);
    }
    return [...lines, ...specials.map(([label, value]) => `${label}: ${value}`)].join("\n");
}

/**
 * A craft's weapons heading as rules: its text under the heading's label, the
 * `Special` lines of the boxed profiles it prints dealt to them in order (as
 * `weaponProfileText` does), and its other fields as the craft's own rules.
 */
export function weaponsPartRules(part: Entry): [string, string][] {
    const special = ([label]: readonly [string, string]): boolean => QUALITIES_LABEL.test(label.trim());
    const text = part.fields.some(special)
        ? weaponProfileText({ ...part, heading: { ...part.heading, text: "" } }).trim()
        : part.body.trim();
    return [[part.heading.text.trim(), text], ...part.fields.filter((f) => !special(f))];
}

/**
 * The entries printed as parts of the entry at `index`: those after it, all in
 * one heading style other than its own, within a page — up to the next heading
 * in its style, the next profile, an entry typed as an item by its own fields,
 * or a heading in another style.
 */
export function vehicleParts(entries: readonly Entry[], index: number, claimed: ReadonlySet<Entry>): Entry[] {
    const head = entries[index];
    if (head === undefined) {
        return [];
    }
    const parts: Entry[] = [];
    for (const entry of entries.slice(index + 1)) {
        const style = parts[0]?.heading.style;
        // A weapon's boxed profile under the craft's weapons heading carries
        // its list on, whatever its heading's style.
        if (
            parts.some(headsWeapons) &&
            !claimed.has(entry) &&
            entry.heading.pageIndex - head.heading.pageIndex <= PART_PAGE_REACH &&
            isWeaponProfile(entry)
        ) {
            parts.push(entry);
            continue;
        }
        // Its weapons heading may be set like its own name; no craft is named "Weapons".
        const ownWeapons = parts.length === 0 && headsWeapons(entry);
        if (
            claimed.has(entry) ||
            (entry.heading.style === head.heading.style && !ownWeapons) ||
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
    // A boxed weapon profile under the weapons heading is part of the craft's weapons.
    const profiles = new Set(parts.filter((p) => !headsWeapons(p) && isWeaponProfile(p)));
    for (const part of parts.filter((p) => !headsWeapons(p) && !profiles.has(p))) {
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
        ...parts.flatMap((part): [string, string][] => {
            if (headsWeapons(part)) {
                return weaponsPartRules(part);
            }
            if (profiles.has(part)) {
                return [
                    [WEAPONS_RULE, weaponProfileText(part)],
                    ...part.fields.filter(([label]) => !QUALITIES_LABEL.test(label.trim())),
                ];
            }
            return [
                ...part.fields,
                // A rule broken across columns runs on in the part's body.
                ...part.body
                    .split(PARAGRAPH_SPLIT)
                    .filter(isProse)
                    .map((p): [string, string] => [part.heading.text.trim(), p.trim()]),
            ];
        }),
    ].filter(([label]) => isProse(label) || WEAPONS_LABEL.test(label));
    const isWeapons = ([label]: [string, string]): boolean => WEAPONS_LABEL.test(label);
    const own = ownProfileText(entry);
    if (own !== null) {
        rules.push([WEAPONS_RULE, own]);
    }
    const carried = mountedWeapons(
        out,
        name,
        rules
            .filter(isWeapons)
            .map(([, value]) => value)
            .join("\n"),
        entry.heading.pageIndex,
    );
    const vehicle = buildVehicle({
        actorType: out.target.actorTypes[kind],
        name,
        line: out.line,
        book: out.sourceBook,
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
    });
    vehicle["items"] = carried;
    out.add("Actor", CRAFT_SEGMENT[kind], vehicle, entry.heading.pageIndex, "entry:vehicle");
    return true;
}

/** A weapon profile's figures that tell one printing of a weapon from another. */
function profileKey(system: JsonObject): string {
    const damage = system["damage"];
    const attack = system["attack"];
    return JSON.stringify([
        isJsonObject(damage) ? [damage["formula"], damage["bonus"], damage["penetration"]] : null,
        isJsonObject(attack) && isJsonObject(attack["range"]) ? attack["range"]["value"] : null,
    ]);
}

/**
 * The weapons a craft's weapon list prints with their profiles, as bare items
 * for the craft to carry. A weapon no other reading gives becomes an item of
 * its own under its printed name; one the catalogue gives with the same
 * profile is that item; one it gives with another profile (the mounted
 * version) becomes an item qualified by the craft printing it, "Heavy Gun
 * (Crawler)" — once per profile, so crafts sharing a mount share the item.
 */
function mountedWeapons(out: EntityCollector, craft: string, text: string, pageIndex: number): JsonObject[] {
    const items: JsonObject[] = [];
    // Profiles printed inline, or boxed as a name line and `LABEL value` lines.
    const printed = [...inlineWeapons(text, true), ...panelWeapons(text.split(/\n+/u).map(rejoinSmallCaps))];
    for (const found of printed) {
        // A name line may close a sentence introducing it ("One hull-mounted
        // gun with a forward arc: Spark Gun"); small capitals may lose case.
        const weapon = { ...found, name: titleCase(found.name.replace(/^.*:\s*/su, "").trim()) };
        if (!startsLikeName(weapon.name)) {
            continue;
        }
        const mapped = mapRow("weapon", weapon.cells);
        const key = profileKey(mapped.system);
        const same = (e: Entity): boolean =>
            e.fields["type"] === "weapon" &&
            isJsonObject(e.fields["system"]) &&
            profileKey(e.fields["system"]) === key;
        const named = out.entities.filter(
            (e) =>
                e.fields["type"] === "weapon" &&
                nameKey(String(e.fields["name"]).replace(QUALIFIER, "")) === nameKey(weapon.name),
        );
        const existing = named.find(same);
        const name =
            existing !== undefined
                ? String(existing.fields["name"])
                : named.length === 0
                  ? weapon.name
                  : `${weapon.name} (${craft})`;
        if (existing === undefined) {
            out.add(
                "Item",
                itemSegment("weapon"),
                buildItem({
                    type: "weapon",
                    name,
                    line: out.line,
                    book: out.sourceBook,
                    page: out.page(pageIndex),
                    description: "",
                    system: mapped.system,
                    variantized: mapped.variantized,
                }),
                pageIndex,
                `${MOUNTED_READING}weapon`,
            );
        }
        if (!items.some((i) => i["name"] === name)) {
            items.push({ name, type: "weapon", system: {} });
        }
    }
    return items;
}

/** The reading that gives a weapon from a craft's weapon list. */
const MOUNTED_READING = "mounted:";

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
            book: out.sourceBook,
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

/**
 * A section naming a gear category ("Lamp Drugs") catalogues one unbroken
 * run of entries set alike under it. A heading after the run is broken — by
 * an entry of no type, or one set otherwise — is the text that follows the
 * catalogue under a section the page never closed, not more gear. A heading
 * about the category itself ("Too Many Drugs") is rules: no gear, and no
 * break. Returns `kinds` without such headings.
 */
export function gearRuns(
    entries: readonly Entry[],
    kinds: ReadonlyMap<Entry, ItemType>,
): Map<Entry, ItemType> {
    const out = new Map(kinds);
    const runs = new Map<string, { style: string; broken: boolean }>();
    for (const entry of entries) {
        const key = entry.sections.join("\u0000");
        const run = runs.get(key);
        const kind = kinds.get(entry);
        const gear = kind === "gear";
        if (namesGearCategory(entry.heading.text)) {
            if (gear) {
                out.delete(entry);
            }
            continue;
        }
        if (run === undefined) {
            if (gear) {
                runs.set(key, { style: entry.heading.style, broken: false });
            }
            continue;
        }
        if (run.broken || kind === undefined || (gear && entry.heading.style !== run.style)) {
            run.broken = true;
            if (gear) {
                out.delete(entry);
            }
        }
    }
    return out;
}

/** Fewest entries that establish a catalogue by the headings each repeats. */
const MIN_CATALOGUE_ENTRIES = 3;

/** Lower-case words of a heading, its case and spacing as the text layer left them aside. */
const headingWords = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter(Boolean);

/**
 * A section whose name closes on a plural noun ("Profane Objects") and whose
 * every direct entry — three or more, set alike, with no fields and no kind
 * of their own — heads the same heading naming that noun in the singular
 * ("Using the Object") catalogues things of that kind, one to an entry: the
 * book refers to each as "the object". A thing a book catalogues in prose
 * with no stats is gear. Returns `kinds` with those entries added.
 */
export function catalogueGear(
    entries: readonly Entry[],
    kinds: ReadonlyMap<Entry, ItemType>,
): Map<Entry, ItemType> {
    const out = new Map(kinds);
    const pathOf = (entry: Entry): string[] => [...entry.sections, entry.heading.text];
    const within = (inner: readonly string[], outer: readonly string[]): boolean =>
        inner.length > outer.length && outer.every((s, i) => inner[i] === s);
    /** Each entry's own headings: those that follow it nested inside it. */
    const ownHeadings = (i: number): Set<string> => {
        const path = pathOf(entries[i] as Entry);
        const own = new Set<string>();
        for (let j = i + 1; j < entries.length; j += 1) {
            const next = entries[j] as Entry;
            if (!within(pathOf(next), path)) {
                break;
            }
            own.add(headingWords(next.heading.text).join(" "));
        }
        return own;
    };
    const sections = new Map<string, number[]>();
    entries.forEach((entry, i) => {
        const key = entry.sections.join("\u0000");
        sections.set(key, [...(sections.get(key) ?? []), i]);
    });
    for (const members of sections.values()) {
        const [first] = members;
        const head = first === undefined ? undefined : entries[first];
        const noun = head === undefined ? undefined : headingWords(head.sections.at(-1) ?? "").at(-1);
        if (head === undefined || noun === undefined || !/^\p{L}{3,}s$/u.test(noun) || noun.endsWith("ss")) {
            continue;
        }
        const singular = noun.slice(0, -1);
        // Set at one size (a title within may be set in italics), and none
        // naming the kind itself ("Chapter Advances" under "Advances"): such
        // a heading is about the kind, not one of it.
        const plain = members.every((i) => {
            const entry = entries[i] as Entry;
            const words = headingWords(entry.heading.text);
            return (
                !kinds.has(entry) &&
                entry.fields.length === 0 &&
                entry.heading.size === head.heading.size &&
                !words.includes(noun) &&
                !words.includes(singular)
            );
        });
        if (!plain || members.length < MIN_CATALOGUE_ENTRIES) {
            continue;
        }
        const owns = members.map(ownHeadings);
        const shared = [...(owns[0] ?? [])].filter(
            (text) => text.split(" ").includes(singular) && owns.every((own) => own.has(text)),
        );
        if (shared.length === 0) {
            continue;
        }
        for (const i of members) {
            out.set(entries[i] as Entry, "gear");
        }
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
    const unclaimed = entries.filter((entry) => !vehicles.has(entry) && !ships.has(entry));
    const kinds = catalogueGear(unclaimed, gearRuns(unclaimed, siblingKinds(unclaimed, entryType)));
    const typed = entries.flatMap((entry) => {
        const type = kinds.get(entry);
        return type === undefined ? [] : [{ entry, type }];
    });
    const modal = modalHeadingSizes(typed);
    const headingTypes = new Map<string, string>(typed.map(({ entry, type }) => [entry.heading.text, type]));
    const labels = headingLabels(typed.map(({ entry }) => entry.heading.text));
    const honourGroups = honourGroupsOf(entries);
    const actionGroups = actionGroupsOf(entries);
    let count = 0;
    for (const typedEntry of typed) {
        const { type } = typedEntry;
        let { entry } = typedEntry;
        entry = {
            ...entry,
            heading: { ...entry.heading, text: stripHeadingLabel(entry.heading.text, labels) },
        };
        if (isComponent(typedEntry.entry, entries, type, headingTypes, modal.get(type) ?? 0)) {
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
        // A medal's honour type may be named by a group heading set beside, not above, it.
        const grouped = honourGroups.get(typedEntry.entry);
        if (type === "medal" && item.system["honourType"] === undefined && grouped !== undefined) {
            item.system["honourType"] = grouped;
        }
        // So may an order's action type ("Manoeuvre Actions").
        const action = actionGroups.get(typedEntry.entry);
        if (type === "order" && item.system["actionType"] === undefined && action !== undefined) {
            item.system["actionType"] = action;
        }
        if (item.description.length > 0) {
            descriptions.set(nameKey(item.name), item.description);
        }
        const usedWith = entry.fields.find(([label]) => /^used with$/iu.test(label.trim()))?.[1];
        if (type === "ammunition" && usedWith !== undefined) {
            out.usedWith.set(nameKey(item.name), usedWith);
        }
        // An armour modification's `Used With` names the armour types it fits.
        const fits = usedWith === undefined ? [] : usedWithArmourTypes(usedWith);
        if (type === "armourModification" && fits.length > 0 && item.system["restrictions"] === undefined) {
            item.system["restrictions"] = { armourTypes: fits };
        }
        out.add(
            "Item",
            itemSegment(type),
            buildItem({
                type,
                name: item.name,
                line: out.line,
                book: out.sourceBook,
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

/** The schema's medal honour types, each named by its own word. */
const HONOUR_TYPES: readonly (readonly [string, string])[] = [
    ["imperial", "imperial"],
    ["campaign", "campaign"],
    ["regimental", "regimental"],
];
/** The schema's order action types, by the word a group heading names each with. */
const ORDER_ACTION_GROUPS: readonly (readonly [string, string])[] = [
    ["manoeuvre", "maneuver-action"],
    ["maneuver", "maneuver-action"],
    ["extended", "extended-action"],
    ["shooting", "shooting-action"],
];
/** Most words a heading naming a group ("Manoeuvre Actions") runs to. */
const MAX_GROUP_WORDS = 3;

/** The medals' honour groups ("Imperial Honours"). */
export function honourGroupsOf(entries: readonly Entry[]): Map<Entry, string> {
    return choiceGroupsOf(entries, HONOUR_TYPES, /^honours?$/u);
}

/** The orders' action groups ("Manoeuvre Actions"). */
export function actionGroupsOf(entries: readonly Entry[]): Map<Entry, string> {
    return choiceGroupsOf(entries, ORDER_ACTION_GROUPS, /^actions?$/u);
}

/**
 * The schema choice each entry is grouped under by the nearest earlier short
 * heading naming the choice's word and the group noun ("Imperial Honours",
 * "Manoeuvre Actions"), while the entries stay in its section: a group
 * heading set smaller than what it groups is not on their section stack.
 */
function choiceGroupsOf(
    entries: readonly Entry[],
    choices: readonly (readonly [string, string])[],
    noun: RegExp,
): Map<Entry, string> {
    const out = new Map<Entry, string>();
    let current: { honour: string; section: string } | null = null;
    for (const entry of entries) {
        const section = entry.sections.join("\u0000");
        const words = entry.heading.text
            .toLowerCase()
            .split(/[^a-z]+/u)
            .filter((w) => w.length > 0);
        const honour = choices.find(([word]) => words.includes(word))?.[1];
        if (honour !== undefined && words.length <= MAX_GROUP_WORDS && words.some((w) => noun.test(w))) {
            current = { honour, section };
            continue;
        }
        // Within the group's section, or the section it sits in when a layout
        // nested the group heading under the entry before it.
        if (
            current !== null &&
            (section.startsWith(current.section) || current.section.startsWith(section))
        ) {
            out.set(entry, current.honour);
        } else {
            current = null;
        }
    }
    return out;
}

function addOrigin(out: EntityCollector, origin: OriginPathReading): void {
    out.add(
        "Item",
        origin.step.segment,
        buildOriginPath({
            name: cleanName(origin.name),
            step: origin.step,
            line: out.line,
            book: out.sourceBook,
            page: out.page(origin.pageIndex),
            description: toHtml(origin.description),
            grants: withSkillLevelBase(origin.grants, baseSkillLevel(out.line)),
            characteristics: origin.modifiers,
            ...(origin.resources === undefined ? {} : { resources: origin.resources }),
            ...(origin.grantsPsychicPowers === true ? { grantsPsychicPowers: true } : {}),
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
                    book: out.sourceBook,
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
    const structured = [
        ...readOriginPaths(entries, out.target.originSteps, heads),
        ...readFieldedOrigins(entries, out.target.originSteps),
    ];
    // A step the document lays out as rules blocks or a table is read from
    // those; inline grant fields elsewhere in it (a sample, a summary of what
    // an origin lists) are not origins of that step.
    const tabled = new Set(out.entities.map((e) => /^(?:table:)?origin:(.+)$/u.exec(e.blockId)?.[1]));
    const read = new Set([...structured.map((o) => o.step.key), ...tabled]);
    const inline = readInlineOrigins(entries, out.target.originSteps).filter((o) => !read.has(o.step.key));
    // Steps read no other way may print each origin as a heading with its
    // rules as fields.
    const readInline = new Set(inline.map((o) => o.step.key));
    const effects = readEffectOrigins(entries, out.target.originSteps).filter(
        (o) => !read.has(o.step.key) && !readInline.has(o.step.key),
    );
    const origins = withCitedOrigins(
        [...structured, ...inline, ...effects],
        entries,
        out.target.originSteps,
        (p) => out.page(p),
        tabled,
    );
    // An origin's own rules are talents of their own, which the origin grants;
    // rules printed apart from it join it when the document reads it.
    const apart = readOriginAbilities(entries, out.target.originSteps);
    const ruled = [
        ...origins.map((o) => ({
            origin: cleanName(o.name),
            pageIndex: o.pageIndex,
            rules: o.rules ?? [],
            owner: o,
        })),
        ...apart.map((group) => ({
            origin: cleanName(group.origin),
            pageIndex: group.pageIndex,
            rules: group.rules,
            owner: origins.find((o) => o.step.key === group.step.key && sameOrigin(o.name, group.origin)),
        })),
    ];
    for (const { origin, pageIndex, rules, owner } of ruled) {
        for (const rule of rules) {
            const name = addOriginRule(out, rule, origin, pageIndex);
            if (owner !== undefined && rule.choice !== undefined) {
                // An option of a choice: the origin offers the talent among the others.
                const choices = Array.isArray(owner.grants["choices"]) ? owner.grants["choices"] : [];
                const label = rule.choice;
                const group = choices.find(
                    (c): c is JsonObject => isJsonObject(c) && c["type"] === "talent" && c["label"] === label,
                );
                const option = { name, label: name, value: name };
                if (group === undefined) {
                    owner.grants["choices"] = [
                        ...choices,
                        { type: "talent", label, count: 1, options: [option] },
                    ];
                } else {
                    group["options"] = [...(Array.isArray(group["options"]) ? group["options"] : []), option];
                }
            } else if (owner !== undefined) {
                const talents = owner.grants["talents"];
                owner.grants["talents"] = [
                    ...(Array.isArray(talents) ? talents : []),
                    { name, specialization: "" },
                ];
            }
        }
    }
    for (const origin of origins) {
        addOrigin(out, origin);
    }
}

/** The talent category the system files an origin's own rules under. */
const ORIGIN_TALENT_CATEGORY = "origin";

/**
 * An origin's own named rule as a talent, named by the rule qualified with
 * its origin ("<Rule> (<Origin>)"): the same rule name recurs across
 * origins. Returns the talent's name.
 */
function addOriginRule(out: EntityCollector, rule: OriginRule, origin: string, pageIndex: number): string {
    const html = toHtml(rule.description);
    const name = `${cleanName(rule.name)} (${origin})`;
    out.add(
        "Item",
        itemSegment("talent"),
        buildItem({
            type: "talent",
            name,
            line: out.line,
            book: out.sourceBook,
            page: out.page(pageIndex),
            description: html,
            system: { category: ORIGIN_TALENT_CATEGORY, benefit: html },
            variantized: {},
        }),
        pageIndex,
        `${ORIGIN_RULE_READING}talent`,
    );
    return name;
}

/** The reading that gives an origin's own rule as a talent. */
const ORIGIN_RULE_READING = "origin-rule:";

/** A table row's cell texts in column order ("" for an empty cell). */
/** Share of a table's rows whose name cell opens with a number band for it to list results. */
const BANDED_SHARE = 2 / 3;
/** A cell opening with a number or band ("01–30", "1-2 Degrees …", "5+ …"): a result key. */
const BAND_LEAD = /^\d+(?:\s*[-–]\s*\d+)?\+?(?!\d)(?:\s|$)/u;

/** A cell closing on a signed test modifier ("Hard –20"): a difficulty key. */
const MODIFIER_CLOSE = /\s[+\-–−]\d+$/u;

/**
 * A table whose name column mostly opens with number bands keys results by a
 * roll or a margin ("1-2 Degrees of Success"), and one whose names close on a
 * test modifier keys them by difficulty; its rows are outcomes, not catalogue
 * items.
 */
/** Most filled cells a section row the detector did not mark may spread over. */
const SECTION_ROW_MAX_CELLS = 2;
/** Fewest columns a table must have for a row filling so few to be a section row, not a record. */
const SECTION_ROW_MIN_COLUMNS = 4;

/**
 * A row of a many-column table that fills one or two cells with words and no
 * figures is a section row ("Las Weapons", or "Solid Projectile | Weapons"
 * when its words straddle a column), not a record.
 */
export function isUnmarkedSectionRow(row: TableRow, columns: number): boolean {
    const filled = row.cells.map((c) => c.text.trim()).filter((t) => t !== "");
    return (
        columns >= SECTION_ROW_MIN_COLUMNS &&
        filled.length > 0 &&
        filled.length <= SECTION_ROW_MAX_CELLS &&
        filled.every((t) => /^[\p{L}][\p{L}\s/&,'’-]*$/u.test(t))
    );
}

export function keyedByBands(table: DetectedTable, nameCol: number): boolean {
    const names = table.rows
        .filter((r) => !r.isHeaderRow && !r.isSectionHeader)
        .map((r) => r.cells.find((c) => c.colIndex === nameCol)?.text.trim() ?? "")
        .filter((t) => t.length > 0);
    const keyed = names.filter((t) => BAND_LEAD.test(t) || MODIFIER_CLOSE.test(t));
    return names.length > 0 && keyed.length >= BANDED_SHARE * names.length;
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
            book: out.sourceBook,
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
    const singular = singularWordsKey(name);
    let best: Entry | null = null;
    let near: Entry | null = null;
    for (const e of entries) {
        const p = e.heading.pageIndex;
        if (p > pageIndex || p < pageIndex - STATBLOCK_PROSE_REACH) {
            continue;
        }
        if (nameKey(e.heading.text) === key) {
            best = e;
        } else if (singularWordsKey(e.heading.text) === singular) {
            near = e;
        }
    }
    // A heading may set a word of the name in the plural ("Wardens Lamp Keeper").
    return best ?? near;
}

/** The entry an entry sits under: the nearest earlier one headed by its innermost section, within reach. */
export function enclosingEntry(entries: readonly Entry[], entry: Entry): Entry | null {
    const parent = entry.sections.at(-1);
    const at = entries.indexOf(entry);
    if (parent === undefined || at < 0) {
        return null;
    }
    return (
        entries
            .slice(0, at)
            .findLast(
                (e) =>
                    e.heading.text === parent &&
                    e.heading.pageIndex >= entry.heading.pageIndex - STATBLOCK_PROSE_REACH,
            ) ?? null
    );
}

/** A name's words, each without a plural ending, run together: plural-blind matching. */
const singularWordsKey = (name: string): string => nameWords(name).map(singularKey).join("");

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

/** Words joining two names a heading lists together. */
const LIST_JOIN = /\s+(?:and|&)\s+/iu;

/**
 * Whether a heading lists several names joined by "and" ("X and Y"), one of
 * them holding every word of the caption (its closing note aside): the heading
 * introduces the caption's creature among others.
 */
export function listsCaption(heading: string, caption: string): boolean {
    const parts = heading.split(LIST_JOIN);
    // A closing note (the statblock's tier) is no part of the name.
    const words = nameWords(caption.replace(/\s*\([^()]*\)\s*$/u, ""));
    return parts.length > 1 && parts.some((part) => words.every((w) => nameWords(part).includes(w)));
}

/** The words, in order, of the entries within a statblock's prose reach. */
function nearbyWords(entries: readonly Entry[], pageIndex: number): string[] {
    const near = entries.filter(
        (e) => e.heading.pageIndex <= pageIndex && e.heading.pageIndex >= pageIndex - STATBLOCK_PROSE_REACH,
    );
    return wordsOf(near.map((e) => `${e.heading.text} ${e.body}`).join(" "));
}

function extractActors(
    ir: IR,
    numeric: readonly DetectedNumericGrid[],
    entries: readonly Entry[],
    out: EntityCollector,
): number {
    // Statblocks print their characteristics as a grid or as a row. A label
    // nearly every grid's banner carries ("… Profile") is no part of a name;
    // row captions already drop theirs.
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
        // One listing several creatures ("X and Y") introduces this one but
        // names it no more fully than its caption.
        const fromHeading =
            naming === null || listsCaption(naming.heading.text, caption)
                ? null
                : splitTier(naming.heading.text);
        const name = fromHeading?.name ?? caption;
        const tiered =
            fromHeading !== null && fromHeading.tier !== null && npc.system["tier"] === undefined
                ? { ...npc.system, tier: fromHeading.tier }
                : npc.system;
        // Its introduction may print the terms it is called in on as a Reinforcement Character.
        // A statblock captioned under its own heading prints them under that one.
        const reinforcement =
            [intro, intro === null ? null : enclosingEntry(entries, intro)]
                .map((e) => (e === null ? null : reinforcementTerms(entryText(e))))
                .find((terms) => terms !== null) ?? null;
        const system = reinforcement === null ? tiered : { ...tiered, isReinforcement: true, reinforcement };
        const actor = buildActor({
            name,
            actorType: out.target.actorTypes.npc,
            line: out.line,
            book: out.sourceBook,
            // Cited where its statblock is printed; its introduction may
            // begin a page earlier.
            page: out.page(grid.pageIndex),
            description: intro === null ? "" : toHtml(intro.body),
            system,
        });
        // Bare until `embedNpcItems` finds the document's own copy of each.
        actor["items"] = npc.items.map(bareItem);
        out.add("Actor", ACTOR_SEGMENT, actor, grid.pageIndex, "grid:npc");
        // A statblock's named rules are traits of their own.
        for (const ability of npc.abilities) {
            out.add(
                "Item",
                itemSegment("trait"),
                buildItem({
                    type: "trait",
                    name: cleanName(ability.name),
                    line: out.line,
                    book: out.sourceBook,
                    page: out.page(ability.pageIndex),
                    description: toHtml(ability.text),
                    system: { benefit: toHtml(ability.text) },
                }),
                ability.pageIndex,
                "grid:trait",
            );
        }
    }
    return grids.length + extractProfileVariants(grids, npcs, entries, out);
}

const bareItem = ({ name, type, specialization, system }: NpcItem): JsonObject => ({
    name: cleanName(name),
    type,
    system: { ...system, ...(specialization === undefined ? {} : { specialization }) },
    effects: [],
    flags: {},
});

/**
 * Statblocks printed as variants of a profile beside them (see
 * `profile-variants.ts`): each is the profile's NPC with the variant's own
 * values, fields and items written over it. Returns how many were read.
 */
function extractProfileVariants(
    grids: readonly DetectedNumericGrid[],
    npcs: readonly ParsedNpc[],
    entries: readonly Entry[],
    out: EntityCollector,
): number {
    const profiles = [...grids].sort((a, b) => a.pageIndex - b.pageIndex);
    let count = 0;
    for (const entry of entries) {
        const variant = variantGrid(entry, profiles);
        const base = variant === null ? undefined : npcs[grids.indexOf(variant.profile)];
        if (variant === null || base === undefined) {
            continue;
        }
        const own = parseNpc(variant.grid);
        const listed = new Set(own.items.map((i) => nameKey(i.name)));
        const heading = entry.heading.text.trim();
        // A name set in small capitals whose case was lost is capitalised.
        const name = /\p{Lu}/u.test(heading)
            ? heading
            : heading.replace(/(^|\s)(\p{Ll})/gu, (_, s, c: string) => `${s}${c.toUpperCase()}`);
        const actor = buildActor({
            name: cleanName(name),
            actorType: out.target.actorTypes.npc,
            line: out.line,
            book: out.sourceBook,
            page: out.page(entry.heading.pageIndex),
            description: toHtml(entry.body),
            system: { ...structuredClone(base.system), ...own.system },
        });
        actor["items"] = [...own.items, ...base.items.filter((i) => !listed.has(nameKey(i.name)))].map(
            bareItem,
        );
        out.add("Actor", ACTOR_SEGMENT, actor, entry.heading.pageIndex, "variant:npc");
        count += 1;
    }
    return count;
}

/** The Item types a statblock's gear list may name: physical items other than weapons. */
const GEAR_TYPES: ReadonlySet<string> = new Set(["armour", "gear", "ammunition", "forceField", "cybernetic"]);

/** Whether an Item of `type` can be what a statblock lists as `listed`. */
const listedAs = (listed: JsonValue | undefined, type: JsonValue | undefined): boolean =>
    listed === "gear" ? typeof type === "string" && GEAR_TYPES.has(type) : listed === type;

/** The closing word of a name, lower case: the noun a compound name heads on. */
const headNoun = (name: string): string => singularKey(name.trim().split(/\s+/u).at(-1) ?? "");

/**
 * The nouns the document's own armour names close on ("Vest", "Carapace")
 * and none of its gear names do: what a worn piece of armour is called.
 */
export function armourHeads(items: readonly Entity[]): Set<string> {
    const heads = (type: string): Set<string> =>
        new Set(
            items
                .filter((e) => e.fields["type"] === type)
                .map((e) => headNoun(String(e.fields["name"])))
                .filter((h) => h.length > 0),
        );
    const gear = heads("gear");
    return new Set([...heads("armour")].filter((h) => !gear.has(h)));
}

/**
 * A listed piece of gear the document defines nowhere, named on a noun only
 * its armour names close on ("Light Carapace" beside a catalogue "… Carapace"),
 * is armour the creature wears.
 */
export function isWorn(listed: JsonValue | undefined, printed: string, heads: ReadonlySet<string>): boolean {
    return listed === "gear" && heads.has(headNoun(printed));
}

/** The schema's word for a characteristic in an item named for any one of them ("… Characteristic (X)"). */
const CHARACTERISTIC_CLASS = "characteristic";

/**
 * A listed item naming one characteristic ("Unnatural Strength") that the
 * document defines only for any characteristic ("Unnatural Characteristic
 * (X)"): that item, its name without the placeholder, and the characteristic
 * as printed for its specialisation. Null when the name ends on no
 * characteristic or the document defines no such item.
 */
export function characteristicClassItem(
    printed: string,
    items: readonly Entity[],
): { item: Entity; name: string; specialization: string } | null {
    const words = printed.trim().split(/\s+/u);
    for (const size of [2, 1]) {
        const tail = words.slice(-size).join(" ");
        const prefix = words.slice(0, -size).join(" ");
        if (prefix.length === 0 || tail.length <= 3 || CHARACTERISTICS[tail.toLowerCase()] === undefined) {
            continue;
        }
        const key = nameKey(`${prefix} ${CHARACTERISTIC_CLASS}`);
        const item = items.find((e) => nameKey(listedBase(String(e.fields["name"]))) === key);
        if (item !== undefined) {
            return { item, name: listedBase(String(item.fields["name"])), specialization: tail };
        }
    }
    return null;
}

/**
 * Resolve each NPC's listed Items against the document's own: a listed name
 * whose full name, or name without its parenthetical, is an Item of its kind
 * becomes a copy of that Item (the actor stands alone, whatever pack the Item
 * is homologated into), keeping a talent's printed specialisation. A name the
 * document defines nowhere stays a bare Item of its kind. Every embedded Item
 * gets a content-derived id; an NPC carrying weapons as Items shows them so.
 */
export function embedNpcItems(entities: readonly Entity[]): void {
    const items = entities.filter((e) => e.documentType === "Item");
    const find = (key: string, listed: JsonValue | undefined): Entity | undefined =>
        items.find((e) => listedAs(listed, e.fields["type"]) && nameKey(String(e.fields["name"])) === key);
    const heads = armourHeads(items);
    for (const actor of entities) {
        const embedded = actor.fields["items"];
        if (actor.documentType !== "Actor" || !Array.isArray(embedded) || embedded.length === 0) {
            continue;
        }
        const actorName = String(actor.fields["name"]);
        const resolved = embedded.filter(isJsonObject).map((bare, i) => {
            const printed = String(bare["name"]);
            const exact = find(nameKey(printed), bare["type"]);
            // A statblock may print a plural for what it carries several of ("Frag Grenades").
            const plural = items.find(
                (e) =>
                    listedAs(bare["type"], e.fields["type"]) &&
                    singularKey(String(e.fields["name"])) === singularKey(printed),
            );
            const byClass =
                exact === undefined && plural === undefined
                    ? characteristicClassItem(
                          printed,
                          items.filter((e) => listedAs(bare["type"], e.fields["type"])),
                      )
                    : null;
            const own = exact ?? find(nameKey(listedBase(printed)), bare["type"]) ?? plural ?? byClass?.item;
            // The Item's own spelling where the whole name is its; a listed
            // specialisation or rating stays as printed.
            const whole = exact ?? plural;
            const name =
                byClass !== null
                    ? byClass.name
                    : whole === undefined
                      ? printed
                      : String(whole.fields["name"]);
            const doc: JsonObject =
                own === undefined
                    ? { ...bare, ...(isWorn(bare["type"], printed, heads) ? { type: "armour" } : {}) }
                    : {
                          ...structuredClone(own.fields),
                          name,
                          system: {
                              ...(isJsonObject(own.fields["system"])
                                  ? structuredClone(own.fields["system"])
                                  : {}),
                              ...(isJsonObject(bare["system"]) ? bare["system"] : {}),
                              ...(byClass === null ? {} : { specialization: byClass.specialization }),
                          },
                      };
            doc["_id"] = id16(`${actorName}\x00${i}\x00${name}`);
            return doc;
        });
        actor.fields["items"] = resolved;
        // A craft's `weapons` is its printed weapon list, kept as it is.
        if (
            resolved.some((d) => d["type"] === "weapon") &&
            isJsonObject(actor.fields["system"]) &&
            typeof actor.fields["system"]["weapons"] !== "string"
        ) {
            actor.fields["system"]["weapons"] = { mode: "embedded", simple: [] };
        }
    }
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

/**
 * A heading read as gear under a gear category's section that names a
 * creature whose statblock the document prints ("Lamp Beasts" over the
 * "Lamp Beast" profile) introduces that creature, not an item: it is dropped.
 */
export function dropCreatureGear(entities: Entity[]): void {
    const nameOf = (e: Entity): string => String(e.fields["name"] ?? "");
    const creatures = new Set(
        entities.filter((e) => e.documentType === "Actor").map((e) => singularWordsKey(nameOf(e))),
    );
    for (let i = entities.length - 1; i >= 0; i -= 1) {
        const e = entities[i];
        if (e?.blockId === `${ENTRY_READING}gear` && creatures.has(singularWordsKey(nameOf(e)))) {
            entities.splice(i, 1);
        }
    }
}
/** Marks a table reading from a row keyed by a roll. */
export const ROLLED_ROW = ":rolled";

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
 * A table printed over several pages sets its caption and header row once:
 * a part with neither, on the page after the part before it (or the same
 * page) and with as many columns as that part's headers, is the same table
 * and takes its caption and headers. Another shape of row, or a page
 * between, is another table.
 */
export function continuedTables<T extends DetectedTable>(tables: readonly T[]): T[] {
    const byPage = [...tables].sort((a, b) => a.pageIndex - b.pageIndex);
    const widthOf = (t: DetectedTable): number =>
        Math.max(0, ...t.rows.flatMap((r) => r.cells.map((c) => c.colIndex + 1)));
    const inherited = new Map<T, { headers: string[]; tableTitle: string | null }>();
    let previous: { table: T; headers: string[]; tableTitle: string | null } | null = null;
    for (const table of byPage) {
        const own = { headers: table.headers, tableTitle: table.tableTitle };
        if (
            table.headers.length === 0 &&
            table.tableTitle === null &&
            previous !== null &&
            previous.headers.length > 0 &&
            table.pageIndex - previous.table.pageIndex <= CONTINUED_PAGE_REACH &&
            widthOf(table) === previous.headers.length &&
            widthOf(table) === widthOf(previous.table)
        ) {
            inherited.set(table, { headers: previous.headers, tableTitle: previous.tableTitle });
            previous = { table, headers: previous.headers, tableTitle: previous.tableTitle };
            continue;
        }
        previous = { table, ...own };
    }
    return tables.map((t) => {
        const from = inherited.get(t);
        return from === undefined ? t : { ...t, headers: from.headers, tableTitle: from.tableTitle };
    });
}

/** Pages a table may run on past the part before it. */
const CONTINUED_PAGE_REACH = 1;

/**
 * A section row closing one part of a table the layout split into parts
 * heads the part after it (the next table, under the same caption and
 * headers): the section each such part opens under. A captioned table's
 * sub-tables may each set their own columns ("Grenades" closing the part
 * before, its records under fewer headers): the caption alone keys those.
 */
export function carriedSections(tables: readonly DetectedTable[]): Map<DetectedTable, string> {
    const keyOf = (t: DetectedTable): string =>
        t.tableTitle === null ? `\u0000${t.headers.join("\u0000")}` : t.tableTitle;
    const out = new Map<DetectedTable, string>();
    tables.forEach((table, i) => {
        const next = tables[i + 1];
        const last = table.rows.findLast((r) => !r.isHeaderRow);
        if (
            next !== undefined &&
            keyOf(next) === keyOf(table) &&
            last?.isSectionHeader === true &&
            last.sectionName !== null
        ) {
            out.set(next, last.sectionName);
        }
    });
    return out;
}

/** Share of a table's rows whose name recurs under another section for its rows to be grades of each. */
const REPEATED_SHARE = 0.5;
/** A closing parenthetical of examples ("Low Grade (Grox Pen, Bilge Berth)"). */
const EXAMPLES = /\s*\([^()]*\)\s*$/u;

/**
 * A table whose rows repeat one name under different section rows ("Low
 * Grade" under "Accommodation" and again under "Provisions") names each row
 * by its section: "Accommodation: Low Grade" (closing examples dropped).
 * Returns the qualified name of each such row.
 */
export function qualifiedBySection(table: DetectedTable, nameCol: number): Map<TableRow, string> {
    const placed: { row: TableRow; section: string; base: string }[] = [];
    let section: string | null = null;
    for (const row of table.rows) {
        if (row.isSectionHeader) {
            section = row.sectionName;
            continue;
        }
        const raw = row.cells.find((c) => c.colIndex === nameCol)?.text ?? "";
        const base = cleanName(raw).replace(EXAMPLES, "");
        if (!row.isHeaderRow && section !== null && base.length > 0) {
            placed.push({ row, section, base });
        }
    }
    const sectionsOf = new Map<string, Set<string>>();
    for (const { section: s, base } of placed) {
        sectionsOf.set(base.toLowerCase(), (sectionsOf.get(base.toLowerCase()) ?? new Set()).add(s));
    }
    // Grades repeated down a table, not a name or two a catalogue happens to repeat.
    const repeats = placed.filter(({ base }) => (sectionsOf.get(base.toLowerCase())?.size ?? 0) > 1);
    const graded = placed.length > 0 && repeats.length >= REPEATED_SHARE * placed.length;
    return new Map(graded ? placed.map(({ row, section: s, base }) => [row, `${s}: ${base}`]) : []);
}

/**
 * An entity printed in several places is cited where it is catalogued: the
 * page of its summary-table row when it has one (a table lists the entity as
 * such, wherever its rules prose falls), otherwise the page its span starts on.
 * A roll table's row is a result the table points to, not a catalogue: it is
 * cited only when nothing else reads the entity.
 */
export function citeFirstPage(head: Entity, readings: readonly Entity[], line: Line): void {
    const rolled = (e: Entity): boolean => e.blockId.endsWith(ROLLED_ROW);
    const rows = readings.filter((e) => e.blockId.startsWith(TABLE_READING) && !rolled(e));
    const own = readings.filter((e) => !rolled(e));
    const pool = rows.length > 0 ? rows : own.length > 0 ? own : readings;
    const first = pool.reduce((a, b) => (b.provenance.pageIndex < a.provenance.pageIndex ? b : a));
    const target = sourceOf(head, line);
    const page = sourceOf(first, line)?.["page"];
    if (target !== null && page !== undefined) {
        target["page"] = page;
    }
}

/**
 * A summary table's Benefit column states what a talent does in one line;
 * the entry's prose is its description. When both are printed, the table's
 * line is the `benefit`, however much longer the prose is. A trait's prose
 * is its rule (a trait has no other rules field), so its own reading stays:
 * the table abridges it ("Extra damage on a charge").
 */
export function preferTableBenefit(head: Entity, readings: readonly Entity[]): void {
    if (head.fields["type"] === "trait") {
        return;
    }
    const benefitOf = (e: Entity): JsonValue | undefined => {
        const system = e.fields["system"];
        return isJsonObject(system) ? system["benefit"] : undefined;
    };
    const row = readings.find((e) => e.blockId.startsWith(TABLE_READING) && !isBlank(benefitOf(e)));
    const system = head.fields["system"];
    const benefit = row === undefined ? undefined : benefitOf(row);
    if (benefit !== undefined && isJsonObject(system)) {
        system["benefit"] = benefit;
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
/** Fewest words a heading's prose needs to describe an item read elsewhere (a table row). */
const MIN_PROSE_WORDS = 8;

/**
 * Each heading's prose by the heading's name: an item a table lists with no
 * text of its own is described where a heading of its name prints it
 * ("AUSPEX/SCANNER" under the gear chapter). The first heading of a name
 * keeps it.
 */
export function headedProse(entries: readonly Entry[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of entries) {
        const key = nameKey(cleanName(e.heading.text));
        if (key !== "" && !out.has(key) && e.body.split(/\s+/u).length >= MIN_PROSE_WORDS) {
            out.set(key, toHtml(e.body));
        }
    }
    return out;
}

/**
 * Each heading's labelled rules by the heading's name: a ship component a
 * table lists with no text of its own is catalogued under a heading of its
 * name, whose `Name: rule` lines ("Hard to Breach: Add +3 to Hull
 * Integrity") are what the component does. The first heading of a name
 * that prints any keeps it.
 */
export function headedRules(entries: readonly Entry[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of entries) {
        const key = nameKey(cleanName(e.heading.text));
        if (key !== "" && !out.has(key) && e.fields.length > 0) {
            out.set(
                key,
                e.fields.map(([label, value]) => `<p>${escapeHtml(`${label}: ${value}`)}</p>`).join(""),
            );
        }
    }
    return out;
}

/** A trailing bracketed qualifier: a repeat's other cell ("… (Light Cruisers, Cruisers)"). */
const TRAILING_QUALIFIER = /\s*\([^()]*\)\s*$/u;

/**
 * A ship component with no effect takes the rules its catalogue heading
 * prints (`headedRules`); a repeat named by its other cell
 * (`distinguishRepeats`) is the same component, catalogued under its name.
 */
export function applyHeadedRules(
    entities: readonly Entity[],
    rules: ReadonlyMap<string, string>,
    line: Line,
): void {
    for (const e of entities) {
        const system = e.fields["system"];
        if (e.fields["type"] !== "shipComponent" || !isJsonObject(system) || !isBlank(system["effect"])) {
            continue;
        }
        const name = String(e.fields["name"]);
        const html = rules.get(nameKey(name)) ?? rules.get(nameKey(name.replace(TRAILING_QUALIFIER, "")));
        if (html !== undefined) {
            system["effect"] = { [line]: html };
        }
    }
}

function consolidate(
    entities: readonly Entity[],
    descriptions: ReadonlyMap<string, string>,
    prose: ReadonlyMap<string, string>,
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
        preferTableBenefit(head, group);
        // A statblock is cited by its own entry; a same-named one elsewhere
        // (an illustration) does not move it.
        if (head.documentType === "Item") {
            citeFirstPage(head, group, line);
        }
        merged.push(head);
    }

    for (const e of merged) {
        const system = e.fields["system"];
        const key = nameKey(String(e.fields["name"]));
        const html = descriptions.get(key) ?? (e.documentType === "Item" ? prose.get(key) : undefined);
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
export function infer(read: IR, log: Logger, target: TargetSchema): InferResult {
    const ir = withLostLettersRestored(withLigaturesJoined(read));
    const line = target.line;
    const book = inferBookSlug(ir);
    const numbering = inferPageNumbering(ir);
    log.info(`book "${book}", page offset ${numbering.offset}, target ${line}`);

    const out = new EntityCollector(target, book, numbering, sourceBookLabel(line, inferBookTitle(ir)));
    const descriptions = new Map<string, string>();
    const { tables, unclassified, tableRuns } = extractTables(ir, out, log);
    // A statblock's panel is no running prose: its lines join no entry.
    const numeric = detectNumericGrids(ir);
    const detected = detectEntries(ir, new Set([...tableRuns, ...numeric.flatMap((g) => g.panelRuns ?? [])]));
    const entries = extractEntries(
        withDisciplines(
            splitModificationLists(splitTalentLists(joinPactGroups(joinSkillCharacteristics(detected)))),
        ),
        out,
        descriptions,
    );
    const grids = extractActors(ir, numeric, detected, out);
    dropCreatureGear(out.entities);
    extractOriginPaths(detected, runningHeads(ir), out);
    const inline = extractInlineWeapons(detected, out);
    log.info(`inline weapon profiles: ${inline}`);
    fitModifications(out.entities, line, book);
    const entities = consolidate(out.entities, descriptions, headedProse(detected), line);
    applyHeadedRules(entities, headedRules(detected), line);
    embedNpcItems(entities);
    applyDefaultIcons(entities);
    applyIdentifiers(entities);
    applyCuePresets(entities);
    applyCyberneticTypes(entities);
    applyTwoHandedClasses(entities, twoHandedClasses(ir.runs.map((r) => r.text).join(" ")));
    applyAmmunitionWeaponTypes(entities, out.usedWith);
    applyAmmunitionEffects(entities);
    applyFocusSkillCharacteristics(entities);
    applyOriginPrerequisites(entities, target.originSteps);
    applyOrderTests(entities);
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
