// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject, JsonValue } from "../types/entity.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { groupByBaseline } from "../util/baselines.ts";
import { CHARACTERISTICS } from "./entry-types.ts";
import { titleCase } from "./names.ts";

/**
 * A career's advancement tables, as the schema's `careerAdvancement` holds
 * them: what each characteristic advance costs at each tier, and every
 * rank's skill and talent advances with their costs and prerequisites. Read
 * from the tables printed under the career, each identified by the heading
 * set over it: a rank's number ("Rank 2 <Career> Advances"), or its title
 * ("<Title> Advances") found in the career's table of ranks, which gives the
 * XP each rank starts at.
 */

const nameKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The schema's characteristic advance tiers, in order. */
export const TIERS = ["simple", "intermediate", "trained", "expert"] as const;

/** Type sizes above a table its heading may sit. */
const HEADING_REACH = 4;

/** A table read for a career's advancement, with the heading over it. */
export interface AdvancementTable {
    kind: "advances" | "characteristics" | "ranks";
    pageIndex: number;
    /** Reading order on the page: the table's text column, then its top. */
    column: number;
    top: number;
    heading: string;
    /** Each row's cells by column, in printed order. */
    rows: string[][];
    headers: string[];
    /** The heading over each header row repeated inside the table, in order: where a following rank's table begins. */
    innerHeadings?: string[][];
    /** A heading set beside the table's header line, to its left. */
    sideHeading?: string;
}

/**
 * The runs of each header line repeated inside a table, top first: a line
 * opening on "Advance" below the table's own header line, with "Cost" beside it.
 */
export function innerHeaderLines(runs: readonly IRTextRun[]): IRTextRun[][] {
    const top = Math.max(...runs.map((r) => r.y));
    const starts = runs.filter((r) => /^\s*advances?\b/iu.test(r.text) && r.y < top - r.size);
    return starts
        .map((start) => runs.filter((r) => Math.abs(r.y - start.y) < start.size / 2))
        .filter((line) => line.some((r) => /\bcost\b/iu.test(r.text)))
        .sort((a, b) => (b[0]?.y ?? 0) - (a[0]?.y ?? 0));
}

/** Type sizes to the left of a header line a side heading may stand. */
const SIDE_REACH = 8;

/** The runs of a table's own header line: its top line. */
export function topLine(runs: readonly IRTextRun[]): IRTextRun[] {
    const top = runs.reduce((a, b) => (b.y > a.y ? b : a), runs[0] as IRTextRun);
    return runs.filter((r) => Math.abs(r.y - top.y) < top.size / 2);
}

/**
 * A heading set to the left of a header line, level with it (a title in a
 * margin beside the table): lines in a face the table does not use, from a
 * type size below the line to two above it, top first.
 */
export function headingBeside(ir: IR, tableRuns: readonly IRTextRun[], line: readonly IRTextRun[]): string {
    const first = line[0];
    if (first === undefined) {
        return "";
    }
    // The line starts at its "Advance" cell: a label set before it on the line is beside the table.
    const start = line.find((r) => /^\s*advances?\b/iu.test(r.text));
    const left = start?.x ?? Math.min(...line.map((r) => r.x));
    const size = Math.max(...line.map((r) => r.size));
    // The faces of the table's own columns: a label the table took in from its margin is not one.
    const faces = new Set(tableRuns.filter((r) => r.x >= left - size).map((r) => r.font));
    return ir.runs
        .filter(
            (r) =>
                r.pageIndex === first.pageIndex &&
                !faces.has(r.font) &&
                !r.italic &&
                /\p{L}/u.test(r.text) &&
                r.x + r.width <= left &&
                r.x + r.width >= left - SIDE_REACH * size &&
                r.y >= first.y - size &&
                r.y <= first.y + 2 * size,
        )
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((r) => r.text.trim())
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
}

/** A header row repeated inside a table: an "Advance" cell, "Cost" after it, no figures. */
export function isAdvanceHeaderRow(row: readonly string[]): boolean {
    const at = row.findIndex((c) => /^\s*advances?\b/iu.test(c));
    return at >= 0 && /\bcost\b/iu.test(row.slice(at).join(" ")) && !/\d/u.test(row.join(" "));
}

/** The text a header row holds before its "Advance" cell: a title set on its line. */
function beforeAdvance(row: readonly string[]): string {
    const at = row.findIndex((c) => /^\s*advances?\b/iu.test(c));
    return row.slice(0, Math.max(at, 0)).join(" ").replace(/\s+/gu, " ").trim();
}

/** The line set just above a table's runs, in the table's text column: the heading over it. */
export function headingAbove(ir: IR, runs: readonly IRTextRun[]): string {
    const page = runs[0]?.pageIndex;
    if (page === undefined) {
        return "";
    }
    // Baselines rise up the page: the table's top is its highest baseline (its header row).
    const own = new Set(runs);
    const top = Math.max(...runs.map((r) => r.y));
    const size = Math.max(...runs.map((r) => r.size));
    const columns = new Set(runs.map((r) => r.column));
    const above = ir.runs.filter(
        (r) =>
            r.pageIndex === page &&
            !own.has(r) &&
            columns.has(r.column) &&
            r.y > top + size / 4 &&
            r.y < top + HEADING_REACH * size &&
            /\p{L}/u.test(r.text),
    );
    const lines = groupByBaseline(
        [...above].sort((a, b) => a.y - b.y),
        size / 2,
    ).sort((a, b) => a.y - b.y);
    const nearest = lines[0];
    return nearest === undefined
        ? ""
        : [...nearest.runs]
              .sort((a, b) => a.x - b.x)
              .map((r) => r.text)
              .join(" ")
              .replace(/\s+/gu, " ")
              .trim();
}

/** The rank a heading names ("Rank 1 … Advances"), or null. */
export function rankOf(heading: string): number | null {
    const m = /\brank\s*(\d+)\b/iu.exec(heading);
    return m?.[1] === undefined ? null : Number(m[1]);
}

/** A table of a career's ranks: a rank column and an XP column. */
export function isRankTable(headers: readonly string[]): boolean {
    return /^ranks?$/iu.test(headers[0]?.trim() ?? "") && headers.slice(1).some((h) => /\bxp\b/iu.test(h));
}

/** A rank as its career's table of ranks prints it: its title and the XP it starts at. */
export interface PrintedRank {
    title: string;
    minXp: number;
}

/** Each row of a table of ranks with a title and an XP figure: the first figure is where the rank starts. */
export function printedRanks(
    headers: readonly string[],
    rows: readonly (readonly string[])[],
): PrintedRank[] {
    const xpCol = headers.findIndex((h, i) => i > 0 && /\bxp\b/iu.test(h));
    const out: PrintedRank[] = [];
    for (const row of rows) {
        const title = titleCase((row[0] ?? "").replace(/\s+/gu, " ").trim());
        const xp = /\d[\d,]*/u.exec(row[xpCol] ?? "")?.[0];
        if (title.length > 0 && /\p{L}/u.test(title) && xp !== undefined) {
            out.push({ title, minXp: Number(xp.replace(/,/gu, "")) });
        }
    }
    return out;
}

/** A rank's XP line in a chart of ranks: "XP Level: 1,000–1,999", "XP: 500+". */
const XP_LINE = /^\s*XP(?:\s+level)?\s*:?\s*(\d[\d,]*)\s*(?:[-–—]|\+|to\b)/iu;

/** Type sizes above its XP line a rank's title may reach (a title may take two lines). */
const TITLE_REACH = 4;

/**
 * The ranks a chart of ranks prints, page by page: boxes holding a title
 * over the XP the rank starts at. A title is the text set just above an XP
 * line, across the line's width, in a face other than the XP line's.
 */
export function rankCharts(ir: IR): AdvancementTable[] {
    const byPage = new Map<number, IRTextRun[]>();
    for (const r of ir.runs) {
        byPage.set(r.pageIndex, [...(byPage.get(r.pageIndex) ?? []), r]);
    }
    const charts: AdvancementTable[] = [];
    for (const [pageIndex, runs] of byPage) {
        const xpLines = runs.filter((r) => XP_LINE.test(r.text));
        if (xpLines.length === 0) {
            continue;
        }
        const rows: string[][] = [];
        for (const xp of xpLines) {
            const reach = TITLE_REACH * xp.size;
            const title = runs
                .filter(
                    (r) =>
                        r !== xp &&
                        r.font !== xp.font &&
                        !XP_LINE.test(r.text) &&
                        /\p{L}/u.test(r.text) &&
                        r.y > xp.y &&
                        r.y <= xp.y + reach &&
                        r.x + r.width / 2 >= xp.x &&
                        r.x + r.width / 2 <= xp.x + xp.width,
                )
                .sort((a, b) => b.y - a.y || a.x - b.x)
                .map((r) => r.text.trim())
                .join(" ")
                .replace(/\s+/gu, " ")
                .trim();
            const start = XP_LINE.exec(xp.text)?.[1];
            if (title.length > 0 && start !== undefined) {
                rows.push([title, start]);
            }
        }
        if (rows.length > 1) {
            charts.push({
                kind: "ranks",
                pageIndex,
                column: Math.min(...xpLines.map((r) => r.column)),
                top: Math.max(...xpLines.map((r) => r.y)),
                heading: "",
                headers: ["Rank", "XP"],
                rows,
            });
        }
    }
    return charts;
}

/**
 * Each printed rank's number: ranks starting at the same XP are branches of
 * one rank, numbered in rising order of the XP they start at.
 */
export function numberRanks(ranks: readonly PrintedRank[]): Map<PrintedRank, number> {
    const levels = [...new Set(ranks.map((r) => r.minXp))].sort((a, b) => a - b);
    return new Map(ranks.map((r) => [r, levels.indexOf(r.minXp) + 1]));
}

/** The words of a heading that may name a rank: all but "advances" and any table label before a colon. */
const titleWords = (heading: string): string[] =>
    heading
        .replace(/^.*:/u, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0 && w !== "advances" && w !== "advance");

/**
 * The printed rank a heading's title names: the rank whose title has every
 * word of the heading's, an exact title first; of several, the earliest
 * not yet claimed by another table.
 */
export function rankNamed(
    heading: string,
    ranks: readonly PrintedRank[],
    claimed: ReadonlySet<PrintedRank>,
): PrintedRank | undefined {
    const words = titleWords(heading);
    if (words.length === 0) {
        return undefined;
    }
    const wordsOf = (r: PrintedRank): string[] => titleWords(r.title);
    const exact = ranks.find((r) => wordsOf(r).join(" ") === words.join(" "));
    if (exact !== undefined) {
        return exact;
    }
    const holding = ranks.filter((r) => words.every((w) => wordsOf(r).includes(w)));
    return [...holding].sort((a, b) => a.minXp - b.minXp).find((r) => !claimed.has(r)) ?? holding[0];
}

/** A table of characteristic advance costs: a characteristic column and the schema's tier words over the rest. */
export function isCharacteristicCostTable(headers: readonly string[]): boolean {
    const text = headers.join(" ").toLowerCase();
    return /^characteristics?$/iu.test(headers[0]?.trim() ?? "") && TIERS.every((t) => text.includes(t));
}

/** Each characteristic's cost at each tier, read from the figures of its row in tier order. */
export function characteristicCosts(rows: readonly (readonly string[])[]): JsonObject {
    const costs: JsonObject = {};
    for (const row of rows) {
        const key = CHARACTERISTICS[(row[0] ?? "").trim().toLowerCase()];
        const figures = row
            .slice(1)
            .join(" ")
            .replace(/(\d),(\d{3})/gu, "$1$2")
            .match(/\d+/gu);
        if (key === undefined || figures?.length !== TIERS.length) {
            continue;
        }
        costs[key] = Object.fromEntries(TIERS.map((t, i) => [t, Number(figures[i])]));
    }
    return costs;
}

/** What the document defines each name as, for typing a prerequisite: its talents, traits and skills. */
export type KindOf = (name: string) => "talent" | "trait" | "skill" | null;

/** Characteristic names a prerequisite may print, longest first. */
const PREREQUISITE_CHARACTERISTICS = Object.keys(CHARACTERISTICS)
    .filter((name) => name.length > 1)
    .sort((a, b) => b.length - a.length);

/**
 * A printed prerequisite as the schema's `{type, key, value?}`: a
 * characteristic minimum ("Ag 30"), or a talent, trait or skill the document
 * defines. A name the document defines as none of them is not typed.
 */
export function advancePrerequisites(printed: string, kindOf: KindOf): JsonObject[] {
    const out: JsonObject[] = [];
    for (const part of printed.split(/[,;]|\band\b/iu).map((p) => p.trim())) {
        if (part.length === 0 || /^[-–—]$/u.test(part)) {
            continue;
        }
        const characteristic = PREREQUISITE_CHARACTERISTICS.map((name) => ({
            name,
            m: new RegExp(`^${name}\\s*(\\d{2,3})\\s*\\+?$`, "iu").exec(part),
        })).find((c) => c.m !== null);
        const key = characteristic === undefined ? undefined : CHARACTERISTICS[characteristic.name];
        if (characteristic?.m?.[1] !== undefined && key !== undefined) {
            out.push({ type: "characteristic", key, value: Number(characteristic.m[1]) });
            continue;
        }
        const kind = kindOf(part);
        if (kind !== null) {
            out.push({ type: kind, key: part });
        }
    }
    return out;
}

/** A cost: a whole number, thousands perhaps grouped. */
const COST = /^\d[\d,]*$/u;

/** A type cell: the type's word, or its initial ("S", "T"), then any prerequisites. */
const TYPE = /^(skill|talent|S|T)(?=\s|$)\s*(.*)$/isu;

/** A name and its cost read as one cell ("Awareness 100"), perhaps with running text after. */
const NAME_COST = /^(.*?\S)\s+(\d[\d,]*)(?:\s+\p{Ll}.*)?$/u;

/** A cost and a type in one cell. */
const COST_TYPE = /^(\d[\d,]*)\s+((?:skill|talent|S|T)(?=\s|$).*)$/isu;

/** A row whose name and cost share a cell, with them parted; any other row as it is. */
function splitNameCost(row: readonly string[]): string[] {
    if (row.some((c, i) => i > 0 && COST.test(c))) {
        return [...row];
    }
    // A cost and the type after it read as one cell ("100 S -", "100 T Ag 30").
    const joined = row.findIndex((c, i) => i > 0 && COST_TYPE.test(c));
    const ct = COST_TYPE.exec(row[joined] ?? "");
    if (ct?.[1] !== undefined && ct[2] !== undefined) {
        return [...row.slice(0, joined), ct[1], ct[2], ...row.slice(joined + 1)];
    }
    const at = row.findIndex((c) => NAME_COST.test(c));
    const m = NAME_COST.exec(row[at] ?? "");
    return m?.[1] === undefined || m[2] === undefined
        ? [...row]
        : [...row.slice(0, at), m[1], m[2], ...row.slice(at + 1)];
}

/** Lower-case words of running text a name cell took in before the name. */
const LEADING_PROSE = /^(?:\p{Ll}\S*\s+)+(?=[\p{Lu}\p{N}])/u;

/**
 * A rank's advances in the schema's shape: each row's name, its
 * specialisation in brackets ("Lore (Stars)"), a multiplier printed as
 * "(x2)", its cost, and its type (a skill or talent, or their initials;
 * other rows are none). A row is read from its cost: the name is the
 * filled cell before it, the type the filled cell after it, the
 * prerequisites what follows the type, so a stray column of text beside the
 * table (or a header set over two cells) does not move them.
 */
export function rankAdvances(
    _headers: readonly string[],
    rows: readonly (readonly string[])[],
    kindOf: KindOf,
): JsonObject[] {
    const out: JsonObject[] = [];
    for (const raw of rows) {
        const row = splitNameCost(raw.map((c) => c.replace(/\s+/gu, " ").trim()));
        const costAt = row.findIndex(
            (c, i) => i > 0 && COST.test(c) && row.slice(0, i).some((n) => n !== ""),
        );
        const before = row.slice(0, Math.max(costAt, 0)).filter((c) => c !== "");
        const typeAt = row.findIndex((c, i) => i > costAt && c !== "");
        const typed = TYPE.exec(row[typeAt] ?? "");
        const initial = typed?.[1];
        let name = (before.at(-1) ?? "").replace(LEADING_PROSE, "");
        if (costAt < 0 || initial === undefined || name.length === 0) {
            continue;
        }
        const type = /^s/iu.test(initial) ? "skill" : "talent";
        const cost = Number((row[costAt] ?? "").replace(/,/gu, ""));
        const advance: JsonObject = { name, cost, type };
        const times = /\s*\(\s*x\s*(\d+)\s*\)\s*$/iu.exec(name);
        if (times?.[1] !== undefined) {
            advance["multiplier"] = Number(times[1]);
            name = name.slice(0, times.index).trim();
        }
        const special = /^(.*?)\s*\(([^()]+)\)\s*$/u.exec(name);
        if (special?.[1] !== undefined && special[2] !== undefined) {
            name = special[1].trim();
            advance["specialization"] = special[2].trim();
        }
        advance["name"] = name;
        const printed = [typed?.[2] ?? "", ...row.slice(typeAt + 1)].join(" ").trim();
        advance["prerequisites"] = advancePrerequisites(printed, kindOf);
        out.push(advance);
    }
    return out;
}

/**
 * A row's corner: the text before its advance's name, or the whole row
 * when it holds no advance, where a rank's title may sit.
 */
function cornerText(raw: readonly string[]): string {
    const row = raw.map((c) => c.replace(/\s+/gu, " ").trim());
    const costAt = row.findIndex((c, i) => i > 0 && COST.test(c) && row.slice(0, i).some((n) => n !== ""));
    const before = (costAt < 0 ? row : row.slice(0, costAt)).filter((c) => c !== "");
    return (costAt < 0 ? before : before.slice(0, -1)).join(" ");
}

/** One rank's advances as the schema's `ranks` holds them. */
interface RankEntry {
    rank: number;
    title: string;
    minXp: number | null;
    advances: JsonObject[];
}

/**
 * Attach each career's advancement to it. A table of characteristic costs,
 * or of a rank its heading numbers, goes to the career its heading names;
 * any other table goes to the career last named so, unless a career's own
 * entry comes after that. A chart of ranks goes to the next career named.
 * Every rank is kept: one numbered in its heading, or one whose title the
 * career's chart of ranks prints (read from the heading, or a title set in
 * the table's corner); a table with neither (one run on under a stray line)
 * continues the rank before it.
 */
export function attachCareerAdvancement(
    careers: readonly Entity[],
    tables: readonly AdvancementTable[],
    kindOf: KindOf,
): void {
    const ordered = [...tables].sort(
        (a, b) => a.pageIndex - b.pageIndex || a.column - b.column || b.top - a.top,
    );
    const named = (heading: string): Entity | undefined => {
        const key = nameKey(heading);
        if (key.length === 0) {
            return undefined;
        }
        // The longest career name the heading holds ("Lamp-Wright", not a shorter one inside it).
        return [...careers]
            .filter((c) => key.includes(nameKey(String(c.fields["name"]))))
            .sort((a, b) => String(b.fields["name"]).length - String(a.fields["name"]).length)[0];
    };
    const byPage = [...careers].sort((a, b) => a.provenance.pageIndex - b.provenance.pageIndex);
    const enteredBefore = (pageIndex: number): Entity | undefined =>
        byPage.filter((c) => c.provenance.pageIndex <= pageIndex).at(-1);
    let current = null as { career: Entity; pageIndex: number } | null;
    /** The career a table names no career for: the last one named, unless one is entered after it. */
    const following = (pageIndex: number): Entity | undefined => {
        const entered = enteredBefore(pageIndex);
        return current !== null &&
            (entered === undefined || entered.provenance.pageIndex <= current.pageIndex)
            ? current.career
            : entered;
    };
    const printed = new Map<Entity, PrintedRank[]>();
    let pendingChart = null as AdvancementTable | null;
    const claimed = new Set<PrintedRank>();
    const found = new Map<Entity, { costs: JsonObject; ranks: RankEntry[] }>();
    let previous = null as { career: Entity; entry: RankEntry } | null;
    for (const table of ordered) {
        if (table.kind === "ranks") {
            // A chart its heading names a career for is that career's; any
            // other waits for the next career named (only the nearest is its own).
            const chartOf = named(table.heading);
            if (chartOf === undefined) {
                pendingChart = table;
            } else {
                printed.set(chartOf, [
                    ...(printed.get(chartOf) ?? []),
                    ...printedRanks(table.headers, table.rows),
                ]);
            }
            continue;
        }
        const number = table.kind === "advances" ? rankOf(table.heading) : null;
        const naming = table.kind === "characteristics" || number !== null ? named(table.heading) : undefined;
        const owner = naming ?? following(table.pageIndex);
        if (owner === undefined) {
            previous = null;
            continue;
        }
        if (naming !== undefined && current?.career !== naming) {
            current = { career: naming, pageIndex: table.pageIndex };
        }
        if (pendingChart !== null && naming !== undefined) {
            printed.set(owner, [
                ...(printed.get(owner) ?? []),
                ...printedRanks(pendingChart.headers, pendingChart.rows),
            ]);
            pendingChart = null;
        }
        const into = found.get(owner) ?? { costs: {}, ranks: [] };
        found.set(owner, into);
        // A table of characteristic costs may run on into a rank's advances
        // under a header row of their own; only those rows are advances.
        const opening = table.rows.findIndex((r) => isAdvanceHeaderRow(r));
        if (table.kind === "characteristics") {
            Object.assign(
                into.costs,
                characteristicCosts(opening < 0 ? table.rows : table.rows.slice(0, opening)),
            );
            if (opening < 0) {
                continue;
            }
        }
        const rows = table.kind === "characteristics" ? table.rows.slice(opening) : table.rows;
        const ranks = printed.get(owner) ?? [];
        // The title may stand over the table, or in its corner (a header cell or the first cell).
        const titled =
            number === null && table.kind === "advances"
                ? [table.heading, table.sideHeading ?? "", table.headers[0] ?? "", table.rows[0]?.[0] ?? ""]
                      .filter((t) => !/^\s*advances?\s*$/iu.test(t))
                      .map((t) => rankNamed(t, ranks, claimed))
                      .find((r) => r !== undefined)
                : undefined;
        // Ranks printed one under another may read as one table: a row whose
        // corner (the text before its advance, or a row of no advance) names
        // another rank starts that rank's rows.
        const segments: { title: PrintedRank | undefined; rows: (readonly string[])[] }[] = [
            { title: titled, rows: [] },
        ];
        let inner = 0;
        for (const row of rows) {
            const last = segments.at(-1);
            if (isAdvanceHeaderRow(row)) {
                // A repeated header row opens the next rank's table, named by the heading over it.
                const headings = [beforeAdvance(row), ...(table.innerHeadings?.[inner] ?? [])];
                inner += 1;
                segments.push({
                    title: headings
                        .map((h) => (ranks.length > 0 ? rankNamed(h, ranks, claimed) : undefined))
                        .find((r) => r !== undefined),
                    rows: [],
                });
                continue;
            }
            const corner = cornerText(row);
            const starts =
                ranks.length > 0 && corner.length > 0 ? rankNamed(corner, ranks, claimed) : undefined;
            if (last !== undefined && starts !== undefined && starts !== last.title) {
                segments.push({ title: starts, rows: [row] });
            } else {
                last?.rows.push(row);
            }
        }
        for (const [i, segment] of segments.entries()) {
            const advances = rankAdvances(table.headers, segment.rows, kindOf);
            let entry: RankEntry | undefined;
            const title = segment.title;
            if (title !== undefined) {
                claimed.add(title);
                entry = into.ranks.find((r) => r.title === title.title && r.minXp === title.minXp);
                if (entry === undefined) {
                    entry = {
                        rank: numberRanks(ranks).get(title) ?? 1,
                        title: title.title,
                        minXp: title.minXp,
                        advances: [],
                    };
                    into.ranks.push(entry);
                }
            } else if (i === 0 && number !== null && number >= 1) {
                entry = into.ranks.find((r) => r.rank === number && r.title === "");
                if (entry === undefined) {
                    entry = { rank: number, title: "", minXp: null, advances: [] };
                    into.ranks.push(entry);
                }
            } else if (previous?.career === owner) {
                entry = previous.entry;
            }
            if (entry === undefined) {
                previous = null;
                continue;
            }
            entry.advances.push(...advances);
            previous = { career: owner, entry };
        }
    }
    for (const [career, { costs, ranks }] of found) {
        const system = career.fields["system"];
        if (system === null || typeof system !== "object" || Array.isArray(system)) {
            continue;
        }
        const kept = ranks.filter((r) => r.advances.length > 0).sort((a, b) => a.rank - b.rank);
        if (Object.keys(costs).length === 0 && kept.length === 0) {
            continue;
        }
        system["careerAdvancement"] = {
            characteristicCosts: costs,
            rank1Advances: [],
            ranks: kept.map((r) => ({ ...r, advances: r.advances as JsonValue[] })),
        };
    }
}
