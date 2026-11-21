// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject, JsonValue } from "../types/entity.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { groupByBaseline } from "../util/baselines.ts";
import { CHARACTERISTICS } from "./entry-types.ts";
import { titleCase } from "./names.ts";
import { loreKindFirst } from "./npc-skills.ts";

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
    // A table whose header row the reader left out starts a line below it.
    const lostHeader =
        start === undefined &&
        ir.runs.some(
            (r) =>
                r.pageIndex === first.pageIndex &&
                /^\s*advances?\b/iu.test(r.text) &&
                r.x >= left - size &&
                r.y > first.y &&
                r.y <= first.y + LOST_HEADER_LINES * size,
        );
    const label = (r: IRTextRun): boolean =>
        r.pageIndex === first.pageIndex &&
        !faces.has(r.font) &&
        !r.italic &&
        /\p{L}/u.test(r.text) &&
        r.x + r.width <= left &&
        // A title stacked over lines beside the table ("Scholar" /
        // "Materium" / "Advances") reaches below the header row.
        // Upward too where the table lost its header row.
        r.y >= first.y - SIDE_TITLE_LINES * size &&
        r.y <= first.y + (lostHeader ? LOST_HEADER_LINES : 2) * size;
    const near = ir.runs.filter((r) => label(r) && r.x + r.width >= left - SIDE_REACH * size);
    // A word set a word space before a near word, on its line and in its
    // face, opens the same title ("Lord" of "Lord Marshal").
    const words = [...near];
    for (let grew = true; grew;) {
        grew = false;
        for (const r of ir.runs) {
            if (
                !words.includes(r) &&
                label(r) &&
                words.some(
                    (w) =>
                        w.font === r.font &&
                        Math.abs(w.y - r.y) < size / 4 &&
                        w.x > r.x &&
                        w.x - (r.x + r.width) < size,
                )
            ) {
                words.push(r);
                grew = true;
            }
        }
    }
    return words
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((r) => r.text.trim())
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
}

/** A header row repeated inside a table: an "Advance" cell, "Cost" after it, no figures. */
/** A cell opening a header row's "Advance" column: the word itself, or ending a note merged into it. */
const ADVANCE_CELL = /^\s*advances?\b|\sadvances?\s*$/iu;

/** The index of a header row's "Advance" cell: one opening with the word first, else one a note ends with it. */
function advanceCell(row: readonly string[]): number {
    const opening = row.findIndex((c) => /^\s*advances?\b/iu.test(c));
    return opening >= 0 ? opening : row.findIndex((c) => ADVANCE_CELL.test(c));
}

export function isAdvanceHeaderRow(row: readonly string[]): boolean {
    const at = advanceCell(row);
    return at >= 0 && /\bcost\b/iu.test(row.slice(at).join(" ")) && !/\d/u.test(row.join(" "));
}

/** The text a header row holds before its "Advance" cell: a title set on its line. */
function beforeAdvance(row: readonly string[]): string {
    const at = advanceCell(row);
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
    // A heading the text layer misread one letter of ("Cank 4") still names its rank.
    const m =
        /\brank\s*(\d+)\b/iu.exec(heading) ??
        /^\s*(?:\p{L}ank|r\p{L}nk|ra\p{L}k|ran\p{L})\s*(\d+)\b/iu.exec(heading);
    return m?.[1] === undefined ? null : Number(m[1]);
}

/** Lines below a table's header row a title set beside the table may reach. */
const SIDE_TITLE_LINES = 3;

/** Lines above a table's first line its left-out header row, and the title beside it, may stand. */
const LOST_HEADER_LINES = 4;

/** A table of a career's ranks: a rank column and an XP column. */
export function isRankTable(headers: readonly string[]): boolean {
    return /^ranks?$/iu.test(headers[0]?.trim() ?? "") && headers.slice(1).some((h) => /\bxp\b/iu.test(h));
}

/** A rank as its career's table of ranks prints it: its title and the XP it starts at. */
export interface PrintedRank {
    title: string;
    minXp: number;
    /** Where a chart sets the rank's box across the page (its XP line's centre), for its branch. */
    x?: number;
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
            const x = Number(row[CHART_X_CELL] ?? Number.NaN);
            out.push({
                title,
                minXp: Number(xp.replace(/,/gu, "")),
                ...(Number.isFinite(x) && row.length > CHART_X_CELL ? { x } : {}),
            });
        }
    }
    return out;
}

/** A rank's XP line in a chart of ranks: "XP Level: 1,000–1,999", "XP: 500+". */
const XP_LINE = /^\s*XP(?:\s+level)?\s*:?\s*(\d[\d,]*)\s*(?:[-–—]|\+|to\b)/iu;

/** A chart box's title run that took the "XP" opening its XP line ("SANCTIONITE XP"). */
const TITLE_THEN_XP = /^(.*\p{L}.*?)\s+XP\s*$/u;

/** An XP line that lost its "XP" to the title above it ("Level: 0-499"). */
const LEVEL_LINE = /^\s*level\s*:?\s*\d/iu;

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
    for (const [pageIndex, pageRuns] of byPage) {
        // A box whose title run swallowed the "XP" its XP line opens with
        // ("<TITLE> XP" over "Level: 0-499") is that title over that XP line.
        const under = (title: IRTextRun, line: IRTextRun): boolean =>
            LEVEL_LINE.test(line.text) &&
            line.y < title.y &&
            title.y - line.y <= TITLE_REACH * line.size &&
            Math.abs(line.x - title.x) <= title.width;
        const swallowed = pageRuns.filter(
            (r) => TITLE_THEN_XP.test(r.text) && pageRuns.some((l) => under(r, l)),
        );
        const runs = pageRuns.map((r): IRTextRun => {
            if (swallowed.includes(r)) {
                return { ...r, text: TITLE_THEN_XP.exec(r.text)?.[1] ?? r.text };
            }
            return swallowed.some((t) => under(t, r)) ? { ...r, text: `XP ${r.text.trim()}` } : r;
        });
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
                // A word after a hyphen whose capital the text layer set apart ("Preceptor-S avant").
                .replace(/(-\p{Lu}) (\p{Ll})/gu, "$1$2")
                .trim();
            const start = XP_LINE.exec(xp.text)?.[1];
            if (title.length > 0 && start !== undefined) {
                rows.push([title, start, String(xp.x + xp.width / 2)]);
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

/**
 * The printed rank a heading names loosely, for when no heading names one
 * exactly (`rankNamed`): a display heading the text layer split inside its words
 * ("m ech -W r I ght"), or spelt one letter off the chart's title
 * ("Enginseer" for "Engineer"), names the one rank whose letters are its
 * letters, or one letter away.
 */
export function rankNamedLoosely(heading: string, ranks: readonly PrintedRank[]): PrintedRank | undefined {
    const letters = (t: string): string => titleWords(t).join("");
    const own = letters(heading);
    const near = ranks.filter(
        (r) => editDistance(letters(r.title), own) <= (own.length >= MIN_FUZZY_TITLE ? 1 : 0),
    );
    return near.length === 1 ? near[0] : undefined;
}

/** Fewest letters a heading needs to be matched to a rank's title one letter off. */
const MIN_FUZZY_TITLE = 6;

/** Edits (insert, delete, replace) between two strings. */
function editDistance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur.push(
                Math.min(
                    (prev[j] ?? 0) + 1,
                    (cur[j - 1] ?? 0) + 1,
                    (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
                ),
            );
        }
        prev = cur;
    }
    return prev[b.length] ?? 0;
}

/** A table of characteristic advance costs: a characteristic column and the schema's tier words over the rest. */
export function isCharacteristicCostTable(
    headers: readonly string[],
    firstCells: readonly string[] = [],
): boolean {
    const text = headers.join(" ").toLowerCase();
    if (!TIERS.every((t) => text.includes(t))) {
        return false;
    }
    // The first column may be headed otherwise ("Level") when its rows are the characteristics.
    const named = firstCells.filter((c) => CHARACTERISTICS[characteristicName(c)] !== undefined);
    return (
        /^characteristics?$/iu.test(headers[0]?.trim() ?? "") ||
        (named.length > 0 && named.length >= firstCells.length / 2)
    );
}

/** A cost row's characteristic: its first cell up to any figure, lower-cased. */
const characteristicName = (cell: string): string => (/^[^\d]*/u.exec(cell)?.[0] ?? "").trim().toLowerCase();

/** Each characteristic's cost at each tier, read from the figures of its row in tier order. */
export function characteristicCosts(rows: readonly (readonly string[])[]): JsonObject {
    const costs: JsonObject = {};
    for (const cells of rows) {
        // A row may open with empty cells where a column holds nothing.
        const row = cells.slice(
            Math.max(
                0,
                cells.findIndex((c) => c.trim() !== ""),
            ),
        );
        const key = CHARACTERISTICS[characteristicName(row[0] ?? "")];
        // Columns may merge, a figure sharing the characteristic's cell ("Strength 500").
        const figures = [(row[0] ?? "").replace(/^[^\d]*/u, ""), ...row.slice(1)]
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
const PREREQUISITE_CHARACTERISTICS = Object.keys(CHARACTERISTICS).sort((a, b) => b.length - a.length);

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
        // A psy rating is a number on the actor, not a talent: any ("Psy Rating") is at least 1.
        const psy = PSY_RATING.exec(part);
        if (psy !== null) {
            out.push({ type: "psyRating", key: "", value: Number(psy[1] ?? 1) });
            continue;
        }
        // A skill's rank ("Pilot (Personal) +10") or a talent's number ("<Talent> 4")
        // is the prerequisite's value.
        const ranked = /^(.*?\S)\s*\+\s*(\d+)$/u.exec(part) ?? /^(.*?\S)\s+(\d+)$/u.exec(part);
        const whole = kindOf(part);
        const named = whole === null ? (ranked?.[1] ?? part) : part;
        const kind = whole ?? kindOf(named);
        if (kind !== null) {
            const key = kind === "skill" ? loreKindFirst(named) : named;
            out.push(
                named !== part && ranked?.[2] !== undefined
                    ? { type: kind, key, value: Number(ranked[2]) }
                    : { type: kind, key },
            );
        }
    }
    return out;
}

/** A psy rating minimum, the schema's `psyRating` prerequisite: "Psy Rating 3", or any rating. */
const PSY_RATING = /^psy\s*rating\s*(\d+)?\s*\+?$/iu;

/** A heading naming a table of advances ("<Name> Advances"): a table of its own, never a run-on. */
const ADVANCES_HEADING = /\badvances?\s*$/iu;

/** A cost: a whole number, thousands perhaps grouped. */
/** A cost: a figure, perhaps a negative one (an advance that pays back, "–100"). */
const COST = /^[-–−]?\d[\d,]*$/u;

/** Marks a table sets after a name to refer to a note (dagger, double dagger, asterisk, section). */
const REFERENCE_MARKS = /[\u2020\u2021*\u00a7\u00b6]+/gu;

/**
 * A name then a sentence of its own: a capitalised word and a lowercase one
 * opening words that end on a full stop (a name is set in title case).
 */
const NAME_THEN_NOTE = /^(.*?[^\s.])\s+(\p{Lu}\p{Ll}*\s+\p{Ll}[^.()]*\.)$/u;

/** A name ending in a capitalised word, a figure or a bracket, then lowercase words only. */
const NAME_THEN_PROSE = /^(.*(?:\)|\+\s*\d+|\b\p{Lu}[\p{L}’'-]*))(?:\s+\p{Ll}[\p{L}’'-]*[!.,;:]?)+$/u;

/** Fewest words a sentence after an advance's name needs to read as a note, not part of it. */
const MIN_NOTE_WORDS = 5;

/** The figure each skill rank above trained adds ("+10" is one rank up). */
const SKILL_RANK_STEP = 10;

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
        // A figure the text layer split ("1 00") is one figure.
        const row = splitNameCost(
            raw
                .map((c) => c.replace(/\s+/gu, " ").trim())
                .map((c) => (/^\d[\d, ]*\d$/u.test(c) ? c.replace(/ /gu, "") : c)),
        );
        const costAt = row.findIndex(
            (c, i) => i > 0 && COST.test(c) && row.slice(0, i).some((n) => n !== ""),
        );
        const before = row.slice(0, Math.max(costAt, 0)).filter((c) => c !== "");
        const typeAt = row.findIndex((c, i) => i > costAt && c !== "");
        // A kind of skill or talent ("Paragon Talent", "Mastered Skill") is a skill or talent.
        const typed = TYPE.exec((row[typeAt] ?? "").replace(/^\p{Lu}\p{Ll}+\s+(?=(?:skill|talent)\b)/iu, ""));
        const initial = typed?.[1];
        let name = (before.at(-1) ?? "").replace(LEADING_PROSE, "");
        if (costAt < 0 || initial === undefined || name.length === 0) {
            continue;
        }
        const type = /^s/iu.test(initial) ? "skill" : "talent";
        const cost = Number((row[costAt] ?? "").replace(/,/gu, "").replace(/^[–−]/u, "-"));
        // A note set after a name (a sentence of its own, "Each may be
        // taken twice at this rank.") is no part of it.
        const note = NAME_THEN_NOTE.exec(name);
        if (
            note?.[1] !== undefined &&
            note[2] !== undefined &&
            note[2].split(/\s+/u).length >= MIN_NOTE_WORDS
        ) {
            name = note[1];
        }
        // Lowercase words of prose beside the table, run on after a name that
        // ends in a capital word, a figure or a bracket, are no part of it.
        // A name the document prints in its own right keeps them ("… shot").
        const runOn = NAME_THEN_PROSE.exec(name);
        if (runOn?.[1] !== undefined && kindOf(name) === null) {
            name = runOn[1];
        }
        // Reference marks set after a name are no part of it, nor a mark the
        // text layer misread as a currency sign hard after a letter.
        name = name
            .replace(REFERENCE_MARKS, "")
            .replace(/(?<=\p{L})\p{Sc}+$/u, "")
            .trim();
        const advance: JsonObject = { name, cost, type };
        const times = /\s*\(\s*x\s*(\d+)\s*\)\s*$/iu.exec(name);
        if (times?.[1] !== undefined) {
            advance["multiplier"] = Number(times[1]);
            name = name.slice(0, times.index).trim();
        }
        // A skill's printed rank ("+10", "+20") is the level it buys: one above trained per +10.
        const rank = /\s*\+\s*(\d+)\s*$/u.exec(name);
        if (rank?.[1] !== undefined) {
            advance["level"] = Number(rank[1]) / SKILL_RANK_STEP + 1;
            name = name.slice(0, rank.index).trim();
        }
        const special = /^(.*?)\s*\(([^()]+)\)\s*$/u.exec(name);
        if (special?.[1] !== undefined && special[2] !== undefined) {
            name = special[1].trim();
            advance["specialization"] = special[2].trim();
        }
        advance["name"] = type === "skill" ? loreKindFirst(name) : name;
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
    /** The path a branched rank belongs to: the kebab title of its path's first branched rank. */
    branch?: string;
    title: string;
    minXp: number | null;
    advances: JsonObject[];
}

/** The cell of a chart's row that holds where the rank's box stands across the page. */
const CHART_X_CELL = 2;

/**
 * Each branched rank's path: a rank is branched when its chart prints
 * several at its XP level; it follows the box at the level before it nearest
 * across the page while that level branches too, and the path is named by
 * the first branched rank on it ("lieutenant" for Lieutenant, Captain,
 * Commander). A rank set apart from no chart position has none.
 */
export function branchPaths(ranks: readonly PrintedRank[]): Map<PrintedRank, string> {
    const levels = [...new Set(ranks.map((r) => r.minXp))].sort((a, b) => a - b);
    const at = (level: number | undefined): PrintedRank[] => ranks.filter((r) => r.minXp === level);
    const out = new Map<PrintedRank, string>();
    for (const rank of ranks) {
        if (rank.x === undefined || at(rank.minXp).length < 2) {
            continue;
        }
        let first = rank;
        for (let i = levels.indexOf(rank.minXp) - 1; i >= 0; i--) {
            const before = at(levels[i]);
            if (before.length < 2) {
                break;
            }
            const x = first.x ?? 0;
            const nearest = [...before]
                .filter((r) => r.x !== undefined)
                .sort((a, b) => Math.abs((a.x ?? 0) - x) - Math.abs((b.x ?? 0) - x))[0];
            if (nearest === undefined) {
                break;
            }
            first = nearest;
        }
        out.set(
            rank,
            first.title
                .toLowerCase()
                .split(/[^\p{L}\p{N}]+/u)
                .filter((w) => w.length > 0)
                .join("-"),
        );
    }
    return out;
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
    defined: KindOf,
    others: readonly Entity[] = [],
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
    // The advance tables say what each name is (their Type column): a
    // prerequisite naming one is typed by it, by its name without a
    // specialisation or rank when the document defines no document for it.
    const listed = new Map<string, "skill" | "talent">();
    for (const t of tables) {
        if (t.kind !== "advances") {
            continue;
        }
        for (const a of rankAdvances(t.headers, t.rows, () => null)) {
            listed.set(nameKey(String(a["name"])), a["type"] === "skill" ? "skill" : "talent");
        }
    }
    const typed: KindOf = (name) => {
        const base = loreKindFirst(name).replace(/\s*\([^()]*\)\s*$/u, "");
        return (
            defined(name) ??
            defined(base) ??
            listed.get(nameKey(loreKindFirst(name))) ??
            listed.get(nameKey(base)) ??
            null
        );
    };
    const kindOf = typed;
    const printed = new Map<Entity, PrintedRank[]>();
    let pendingChart = null as AdvancementTable | null;
    const claimed = new Set<PrintedRank>();
    const found = new Map<Entity, { costs: JsonObject; ranks: RankEntry[] }>();
    let previous = null as { career: Entity; entry: RankEntry } | null;
    // Careers some table's heading names: only these have tables of their own.
    const namedByTable = new Set(
        tables.map((t) => named(t.heading)).filter((c): c is Entity => c !== undefined),
    );
    const shared = new Map<number, JsonObject[]>();
    let lastShared = null as number | null;
    // Careers with a table naming its rank by number.
    const numberedOwners = new Set<Entity>();
    // A table of ranks printed as numbers ("1", "2", …) gives where each numbered rank starts, for every career.
    const numberedXp = new Map<number, number>();
    for (const table of ordered) {
        if (table.kind === "ranks") {
            const xpCol = table.headers.findIndex((h, i) => i > 0 && /\bxp\b/iu.test(h));
            const numbered = table.rows.flatMap((row) => {
                const rank = /^\s*(\d+)\s*$/u.exec(row[0] ?? "")?.[1];
                const xp = /\d[\d,]*/u.exec(row[xpCol] ?? "")?.[0];
                return rank === undefined || xp === undefined
                    ? []
                    : [[Number(rank), Number(xp.replace(/,/gu, ""))]];
            });
            if (
                numbered.length > 0 &&
                numbered.length === table.rows.filter((r) => r.some((c) => c.trim() !== "")).length
            ) {
                for (const [rank, xp] of numbered) {
                    numberedXp.set(rank as number, xp as number);
                }
                continue;
            }
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
        // A table naming no rank and no career but an origin of another step
        // ("<Origin> Advances") is that origin's own advances, open from rank 1.
        const otherOrigin =
            number === null && naming === undefined && table.kind === "advances"
                ? [...others]
                      .filter((o) => {
                          const key = nameKey(String(o.fields["name"]));
                          return key.length > 0 && nameKey(table.heading).includes(key);
                      })
                      .sort((a, b) => String(b.fields["name"]).length - String(a.fields["name"]).length)[0]
                : undefined;
        if (otherOrigin !== undefined) {
            const into = found.get(otherOrigin) ?? { costs: {}, ranks: [] };
            found.set(otherOrigin, into);
            let entry = into.ranks.find((r) => r.rank === 1 && r.title === "");
            if (entry === undefined) {
                entry = { rank: 1, title: "", minXp: null, advances: [] };
                into.ranks.push(entry);
            }
            entry.advances.push(...rankAdvances(table.headers, table.rows, kindOf));
            previous = null;
            lastShared = null;
            continue;
        }
        const owner = naming ?? following(table.pageIndex);
        // A rank's table naming no career, read before any career is entered,
        // is offered to every career at that rank.
        // One run on under a stray line, naming no rank, continues the shared table before it.
        const sharedRank =
            number ??
            (naming === undefined && owner === undefined && !ADVANCES_HEADING.test(table.heading)
                ? lastShared
                : null);
        if (sharedRank !== null && naming === undefined && owner === undefined) {
            shared.set(sharedRank, [
                ...(shared.get(sharedRank) ?? []),
                ...rankAdvances(table.headers, table.rows, kindOf),
            ]);
            lastShared = sharedRank;
            previous = null;
            continue;
        }
        lastShared = null;
        // A career whose tables each name their rank ("Rank 3 <Career>
        // Advances") owns no table headed "<Name> Advances" naming none: that
        // is another entry's own table (an alternate rank set after it).
        if (
            owner !== undefined &&
            number === null &&
            naming === undefined &&
            table.kind === "advances" &&
            ADVANCES_HEADING.test(table.heading) &&
            numberedOwners.has(owner)
        ) {
            previous = null;
            continue;
        }
        if (owner === undefined) {
            previous = null;
            continue;
        }
        if (number !== null) {
            numberedOwners.add(owner);
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
        const candidates =
            number === null && table.kind === "advances"
                ? [
                      table.heading,
                      table.sideHeading ?? "",
                      table.headers[0] ?? "",
                      table.rows[0]?.[0] ?? "",
                  ].filter((t) => !/^\s*advances?\s*$/iu.test(t))
                : [];
        const titleWords = (t: string): string[] =>
            t
                .toLowerCase()
                .split(/[^\p{L}]+/u)
                .filter((w) => w.length > 0 && !/^advances?$/u.test(w));
        // A table named by part of a rank's title, all of it words of the rank
        // before it ("Loremaster" after "Loremaster Lexographer"), is that
        // rank's table run on, not the other rank sharing the word.
        const runsOn = (t: string, rank: PrintedRank | undefined): boolean => {
            if (rank === undefined || previous?.career !== owner) {
                return false;
            }
            const words = titleWords(t);
            const before = new Set(titleWords(previous.entry.title));
            return (
                words.length > 0 &&
                words.length < titleWords(rank.title).length &&
                words.every((w) => before.has(w))
            );
        };
        const continued = candidates.some((t) => runsOn(t, rankNamed(t, ranks, claimed)));
        const titled =
            number === null && table.kind === "advances" && !continued
                ? candidates.reduce<PrintedRank | undefined>(
                      (found, t, _i, all) =>
                          found ??
                          rankNamed(t, ranks, claimed) ??
                          // Loosely only once no candidate names a rank exactly.
                          (all.every((c) => rankNamed(c, ranks, claimed) === undefined)
                              ? rankNamedLoosely(t, ranks)
                              : undefined),
                      undefined,
                  )
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
                // Only a header set as its own line is one of the table's inner
                // header lines; one merged into a note is read by its own cells.
                const ownLine = row.some((c) => /^\s*advances?\b/iu.test(c));
                const headings = [
                    beforeAdvance(row),
                    ...(ownLine ? (table.innerHeadings?.[inner] ?? []) : []),
                ];
                if (ownLine) {
                    inner += 1;
                }
                const title =
                    headings
                        .map((h) => (ranks.length > 0 ? rankNamed(h, ranks, claimed) : undefined))
                        .find((r) => r !== undefined) ??
                    headings
                        .map((h) => (ranks.length > 0 ? rankNamedLoosely(h, ranks) : undefined))
                        .find((r) => r !== undefined);
                // Where the career prints its ranks, a header row naming none of
                // them (a note merged into it) opens no rank: its rows stay put.
                if (title === undefined && ranks.length > 0) {
                    continue;
                }
                segments.push({ title, rows: [] });
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
                    const branch = branchPaths(ranks).get(title);
                    entry = {
                        rank: numberRanks(ranks).get(title) ?? 1,
                        ...(branch === undefined ? {} : { branch }),
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
    for (const [career, into] of found) {
        if (!namedByTable.has(career)) {
            continue;
        }
        for (const [number, advances] of shared) {
            let entry = into.ranks.find((r) => r.rank === number && r.title === "");
            if (entry === undefined) {
                entry = { rank: number, title: "", minXp: null, advances: [] };
                into.ranks.push(entry);
            }
            entry.advances.push(...advances);
        }
    }
    for (const [career, { costs, ranks }] of found) {
        const system = career.fields["system"];
        if (system === null || typeof system !== "object" || Array.isArray(system)) {
            continue;
        }
        const kept = ranks
            .filter((r) => r.advances.length > 0)
            .map((r) => (r.minXp === null ? { ...r, minXp: numberedXp.get(r.rank) ?? null } : r))
            .sort((a, b) => a.rank - b.rank);
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
