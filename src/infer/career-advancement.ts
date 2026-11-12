// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject, JsonValue } from "../types/entity.ts";
import type { IR, IRTextRun } from "../types/ir.ts";
import { groupByBaseline } from "../util/baselines.ts";
import { CHARACTERISTICS } from "./entry-types.ts";

/**
 * A career's advancement tables, as the schema's `careerAdvancement` holds
 * them: what each characteristic advance costs at each tier, and the rank 1
 * skill and talent advances with their costs and prerequisites. Read from
 * the tables printed under the career, each identified by the heading set
 * over it ("Rank 1 <Career> Advances", "<Career> Characteristic Advances").
 */

const nameKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The schema's characteristic advance tiers, in order. */
export const TIERS = ["simple", "intermediate", "trained", "expert"] as const;

/** Type sizes above a table its heading may sit. */
const HEADING_REACH = 4;

/** A table read for a career's advancement, with the heading over it. */
export interface AdvancementTable {
    kind: "advances" | "characteristics";
    pageIndex: number;
    /** Reading order on the page: the table's text column, then its top. */
    column: number;
    top: number;
    heading: string;
    /** Each row's cells by column, in printed order. */
    rows: string[][];
    headers: string[];
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

/**
 * A rank's advances in the schema's shape: each row's name, its
 * specialisation in brackets ("Lore (Stars)"), a multiplier printed as
 * "(x2)", its cost, and its type (a skill or talent; other rows are none).
 */
export function rankAdvances(
    headers: readonly string[],
    rows: readonly (readonly string[])[],
    kindOf: KindOf,
): JsonObject[] {
    const costCol = headers.findIndex((h) => /\bcost\b/iu.test(h));
    const out: JsonObject[] = [];
    for (const row of rows) {
        // The type is the first cell after the cost to open on a type word
        // (a merged "Type Prerequisites" header may sit over two cells, or
        // one cell holding both); the prerequisites follow it.
        const typeAt = row.findIndex((c, i) => i > costCol && /^\s*(skill|talent)\b/iu.test(c));
        const typed = (row[typeAt] ?? "").trim();
        const type = /^(skill|talent)\b/iu.exec(typed)?.[1]?.toLowerCase();
        const cost = Number(/\d+/u.exec((row[costCol] ?? "").replace(/,/gu, ""))?.[0] ?? Number.NaN);
        let name = (row[0] ?? "").replace(/\s+/gu, " ").trim();
        if (type === undefined || !Number.isFinite(cost) || name.length === 0) {
            continue;
        }
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
        const printed = [typed.replace(/^(skill|talent)\b/iu, ""), ...row.slice(typeAt + 1)].join(" ").trim();
        advance["prerequisites"] = advancePrerequisites(printed, kindOf);
        out.push(advance);
    }
    return out;
}

/**
 * Attach each career's advancement to it: a table goes to the career its
 * heading names, else to the career entered last before it. Only rank 1
 * advances are kept, as the schema holds.
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
        // The longest career name the heading holds ("Lamp-Wright", not a shorter one inside it).
        return [...careers]
            .filter((c) => key.includes(nameKey(String(c.fields["name"]))))
            .sort((a, b) => String(b.fields["name"]).length - String(a.fields["name"]).length)[0];
    };
    const found = new Map<Entity, { costs: JsonObject; advances: JsonObject[] }>();
    // A career's tables follow its entry: one whose heading names no career
    // (or misreads its name) belongs to the career entered last before it.
    const byPage = [...careers].sort((a, b) => a.provenance.pageIndex - b.provenance.pageIndex);
    const enteredBefore = (pageIndex: number): Entity | undefined =>
        byPage.filter((c) => c.provenance.pageIndex <= pageIndex).at(-1);
    let previous = null as { career: Entity; rank: number | null } | null;
    for (const table of ordered) {
        const owner = named(table.heading) ?? enteredBefore(table.pageIndex);
        if (owner === undefined) {
            previous = null;
            continue;
        }
        // A heading with no rank (a table run on under a stray line) keeps the rank before it.
        const rank =
            rankOf(table.heading) ??
            (table.kind === "advances" && previous?.career === owner ? previous.rank : null);
        if (table.kind === "advances") {
            previous = { career: owner, rank };
        }
        const into = found.get(owner) ?? { costs: {}, advances: [] };
        if (table.kind === "characteristics") {
            Object.assign(into.costs, characteristicCosts(table.rows));
        } else if (rank === 1) {
            into.advances.push(...rankAdvances(table.headers, table.rows, kindOf));
        }
        found.set(owner, into);
    }
    for (const [career, { costs, advances }] of found) {
        const system = career.fields["system"];
        if (system === null || typeof system !== "object" || Array.isArray(system)) {
            continue;
        }
        if (Object.keys(costs).length === 0 && advances.length === 0) {
            continue;
        }
        system["careerAdvancement"] = { characteristicCosts: costs, rank1Advances: advances as JsonValue[] };
    }
}
