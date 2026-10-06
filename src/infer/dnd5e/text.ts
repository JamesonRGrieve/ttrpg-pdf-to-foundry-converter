// SPDX-License-Identifier: AGPL-3.0-or-later
import { escapeHtml } from "../../util/text.ts";
import { type Cell, isSection, type Line, type Section } from "./layout.ts";

/**
 * The typographic devices a rules text uses inside a section, read from the
 * section's lines:
 *
 *  - a field: a bold label ending in a colon, its value after it ("Speed: 30
 *    feet"), or a bold label cell beside a value cell (a two-column traits
 *    table); a value runs on over lines indented under it or aligned with it;
 *  - a trait: a paragraph led by a bold-italic name ending in a full stop;
 *  - a paragraph, a bullet item, a table (lines of several cells).
 *
 * And their rendering as description HTML.
 */

export interface Field {
    label: string;
    value: string;
    lines: Line[];
}

export interface Trait {
    label: string;
    body: string;
    lines: Line[];
}

/** Points a run-on line is indented beyond its field's label. */
const RUN_ON_INDENT = 3;
/** Points a run-on line may stray from its field's value cell. */
const VALUE_ALIGN = 2.5;
/** A vertical gap of more than this many ems between lines ends a paragraph or a field. */
const PARAGRAPH_GAP_EM = 1.8;
/** Points a line is indented to start a paragraph. */
const PARAGRAPH_INDENT = 3;

const BULLET = /^[•◦▪●‣-]\s*/u;

/** Join a line onto text, closing a word hyphenated across the break. */
export function joinText(text: string, next: string): string {
    if (text.length === 0) {
        return next;
    }
    if (/\p{Ll}-$/u.test(text) && /^\p{Ll}/u.test(next)) {
        return `${text.slice(0, -1)}${next}`;
    }
    return `${text} ${next}`;
}

const joinAll = (parts: readonly string[]): string => parts.reduce(joinText, "").trim();

/** The bold prefix of a line's first cell, and the text after it, when the prefix ends in a colon. */
function colonLabel(line: Line): { label: string; rest: string } | null {
    const [first] = line.runs;
    if (first === undefined || first.weight !== "bold" || first.italic) {
        return null;
    }
    let label = "";
    let index = 0;
    for (; index < line.runs.length; index += 1) {
        const run = line.runs[index];
        if (run === undefined || run.weight !== "bold" || run.italic) {
            break;
        }
        label = `${label}${label.length > 0 && run.text.trim().length > 0 ? " " : ""}${run.text.trim()}`;
    }
    label = label.replace(/\s+/gu, " ").trim();
    if (!label.endsWith(":") || index >= line.runs.length) {
        return null;
    }
    const rest = line.runs
        .slice(index)
        .map((r) => r.text.trim())
        .filter((t) => t.length > 0)
        .join(" ");
    return { label: label.slice(0, -1).trim(), rest };
}

/** A label cell beside value cells: a bold first cell and a value that is not. */
function cellLabel(line: Line): { label: string; rest: string; valueX: number } | null {
    const [first, second] = line.cells;
    if (first === undefined || second === undefined || !first.bold || first.italic || second.bold) {
        return null;
    }
    return {
        label: first.text.replace(/:$/u, "").trim(),
        rest: line.cells
            .slice(1)
            .map((c) => c.text)
            .join(" "),
        valueX: second.x,
    };
}

/** A trait's bold-italic lead ("Darkvision.") and the text after it. */
export function traitLead(line: Line): { label: string; rest: string } | null {
    let label = "";
    let index = 0;
    for (; index < line.runs.length; index += 1) {
        const run = line.runs[index];
        if (run === undefined || run.weight !== "bold" || !run.italic) {
            break;
        }
        label = `${label}${run.text}`;
    }
    label = label.replace(/\s+/gu, " ").trim();
    if (index === 0 || !/[.!?]$/u.test(label) || label.length < 2) {
        return null;
    }
    const rest = line.runs
        .slice(index)
        .map((r) => r.text.trim())
        .filter((t) => t.length > 0)
        .join(" ");
    return { label: label.slice(0, -1).trim(), rest };
}

export function startsField(line: Line): boolean {
    return colonLabel(line) !== null || cellLabel(line) !== null;
}

const gapBetween = (prev: Line, next: Line): number =>
    prev.pageIndex === next.pageIndex && prev.region === next.region ? prev.bottom - next.top : 0;

const farApart = (prev: Line, next: Line): boolean => gapBetween(prev, next) > PARAGRAPH_GAP_EM * next.size;

/** The fields set in a run of lines, in printed order. */
export function readFields(lines: readonly Line[]): Field[] {
    const fields: Field[] = [];
    let open: { field: Field; labelX: number; valueX: number | null; last: Line } | null = null;
    for (const line of lines) {
        const colon = colonLabel(line);
        const cell = colon === null ? cellLabel(line) : null;
        if (colon !== null || cell !== null) {
            const field: Field = {
                label: (colon ?? cell)?.label ?? "",
                value: (colon ?? cell)?.rest ?? "",
                lines: [line],
            };
            fields.push(field);
            open = { field, labelX: line.x, valueX: cell?.valueX ?? null, last: line };
            continue;
        }
        if (open === null) {
            continue;
        }
        const continuesLabel =
            line.bold && Math.abs(line.x - open.labelX) <= VALUE_ALIGN && open.valueX !== null;
        const runsOn =
            open.valueX === null
                ? line.x > open.labelX + RUN_ON_INDENT
                : line.cells.some((c) => Math.abs(c.x - (open?.valueX ?? 0)) <= VALUE_ALIGN);
        if (farApart(open.last, line) || traitLead(line) !== null || (!continuesLabel && !runsOn)) {
            open = null;
            continue;
        }
        if (continuesLabel) {
            const [labelCell, ...valueCells] = line.cells;
            open.field.label = `${open.field.label} ${labelCell?.text ?? ""}`.trim();
            open.field.value = joinAll([open.field.value, ...valueCells.map((c) => c.text)]);
        } else {
            open.field.value = joinText(open.field.value, line.text);
        }
        open.field.lines.push(line);
        open.last = line;
    }
    return fields;
}

/** The traits set in a run of lines, in printed order. */
export function readTraits(lines: readonly Line[]): Trait[] {
    const traits: Trait[] = [];
    let open: Trait | null = null;
    let last: Line | null = null;
    for (const line of lines) {
        const lead = traitLead(line);
        if (lead !== null) {
            open = { label: lead.label, body: lead.rest, lines: [line] };
            traits.push(open);
        } else if (open !== null && last !== null && !farApart(last, line) && !startsField(line)) {
            open.body = joinText(open.body, line.text);
            open.lines.push(line);
        } else {
            open = null;
        }
        last = line;
    }
    return traits;
}

type Block =
    | { kind: "p"; text: string; x: number; lead?: { label: string; italic: boolean } }
    | { kind: "li"; text: string; x: number }
    | { kind: "table"; rows: Cell[][] };

/** Append a wrapped line to the table cell it sits under (any cell of the last row), if one. */
function wrapIntoCell(rows: Cell[][], line: Line): boolean {
    const row = rows.at(-1);
    const [only] = line.cells;
    if (row === undefined || only === undefined || line.cells.length !== 1) {
        return false;
    }
    const index = row.findIndex((c) => Math.abs(c.x - only.x) <= VALUE_ALIGN);
    const cell = row[index];
    if (cell === undefined) {
        return false;
    }
    row[index] = { ...cell, text: joinText(cell.text, only.text), right: Math.max(cell.right, only.right) };
    return true;
}

/**
 * Whether a line runs on in the open paragraph. A field's value runs on only
 * over lines indented under its label; other paragraphs run on over lines at
 * the margin, and a paragraph begun indented runs on over lines indented as
 * deep (a new paragraph is a first line indented from the one before).
 */
function continuesParagraph(open: Extract<Block, { kind: "p" }>, prev: Line | null, line: Line): boolean {
    if (open.lead !== undefined && !open.lead.italic) {
        return line.x > open.x + RUN_ON_INDENT;
    }
    return line.indent <= PARAGRAPH_INDENT || (prev?.indent ?? 0) > PARAGRAPH_INDENT;
}

/** Group a section's own lines into paragraphs, bullet items, fields, traits and tables. */
function blocksOf(lines: readonly Line[]): Block[] {
    const blocks: Block[] = [];
    let prev: Line | null = null;
    for (const line of lines) {
        const open = blocks.at(-1);
        const colon = colonLabel(line);
        const lead = traitLead(line);
        const bullet = BULLET.exec(line.text);
        const nearPrev = prev !== null && !farApart(prev, line);
        if (line.cells.length >= 2 && colon === null && lead === null) {
            if (open?.kind === "table" && nearPrev) {
                open.rows.push([...line.cells]);
            } else {
                blocks.push({ kind: "table", rows: [[...line.cells]] });
            }
        } else if (open?.kind === "table" && nearPrev && wrapIntoCell(open.rows, line)) {
            // A wrapped cell: joined into the cell above.
        } else if (colon !== null) {
            blocks.push({
                kind: "p",
                text: colon.rest,
                x: line.x,
                lead: { label: `${colon.label}:`, italic: false },
            });
        } else if (lead !== null) {
            blocks.push({
                kind: "p",
                text: lead.rest,
                x: line.x,
                lead: { label: `${lead.label}.`, italic: true },
            });
        } else if (bullet !== null) {
            blocks.push({ kind: "li", text: line.text.slice(bullet[0].length), x: line.x });
        } else if (
            open !== undefined &&
            open.kind === "li" &&
            prev !== null &&
            !farApart(prev, line) &&
            line.x > open.x
        ) {
            open.text = joinText(open.text, line.text);
        } else if (open?.kind === "p" && nearPrev && continuesParagraph(open, prev, line)) {
            open.text = joinText(open.text, line.text);
        } else if (open?.kind === "table" && nearPrev) {
            open.rows.push([...line.cells]);
        } else {
            blocks.push({ kind: "p", text: line.text, x: line.x });
        }
        prev = line;
    }
    return blocks;
}

function blockHtml(block: Block): string {
    switch (block.kind) {
        case "p": {
            const lead =
                block.lead === undefined
                    ? ""
                    : block.lead.italic
                      ? `<strong><em>${escapeHtml(block.lead.label)}</em></strong> `
                      : `<strong>${escapeHtml(block.lead.label)}</strong> `;
            return `<p>${lead}${escapeHtml(block.text)}</p>`;
        }
        case "li":
            return `<li>${escapeHtml(block.text)}</li>`;
        case "table":
            return `<table>${block.rows
                .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c.text)}</td>`).join("")}</tr>`)
                .join("")}</table>`;
    }
}

/** HTML of a run of lines, bullet items gathered into lists. */
export function linesHtml(lines: readonly Line[]): string {
    let html = "";
    let inList = false;
    for (const block of blocksOf(lines)) {
        if (block.kind === "li" && !inList) {
            html += "<ul>";
            inList = true;
        } else if (block.kind !== "li" && inList) {
            html += "</ul>";
            inList = false;
        }
        html += blockHtml(block);
    }
    return inList ? `${html}</ul>` : html;
}

/** Deepest heading level a description uses. */
const MAX_HEADING_LEVEL = 6;

/**
 * HTML of a section's body: its lines, and its subsections under headings one
 * level down — except the lines and subsections `skip` claims (read into
 * documents of their own).
 */
export function sectionHtml(section: Section, skip: (item: Line | Section) => boolean, level = 3): string {
    let html = "";
    let run: Line[] = [];
    const flush = (): void => {
        html += linesHtml(run);
        run = [];
    };
    for (const item of section.items) {
        if (skip(item)) {
            continue;
        }
        if (isSection(item)) {
            flush();
            const h = Math.min(level, MAX_HEADING_LEVEL);
            html += `<h${h}>${escapeHtml(item.title)}</h${h}>${sectionHtml(item, skip, level + 1)}`;
        } else {
            run.push(item);
        }
    }
    flush();
    return html;
}
