// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import { type Entry, PARAGRAPH_BREAK } from "./detect-entries.ts";
import { CHARACTERISTICS } from "./entry-types.ts";
import { FUNCTION_WORDS, readsAsProse } from "./names.ts";
import type { OriginStepDef } from "./targets.ts";

/**
 * Origin-path rules blocks, found by structure: a heading followed directly
 * by sub-headings that are the origin schema's grant labels ("Characteristic
 * Modifiers", "Fate Threshold", "Wounds", "… Aptitude", "… Bonus", "Starting
 * Skills", …), each carrying its value as body text. The labels also name the
 * creation step ("Home World Bonus", "Background Aptitude", "Role Talent").
 * All vocabulary here is the system's origin-path schema.
 */

/**
 * A step label as a pattern: its words, any spacing between them, an optional
 * plural; when `closing`, the label must end the text (its head noun).
 */
function labelPattern(label: string, plural: boolean, closing: boolean): RegExp {
    const words = label.split(/\s+/u).map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    return new RegExp(`\\b${words.join("\\s*")}${plural ? "s?" : ""}${closing ? "\\W*$" : "\\b"}`, "iu");
}

/** The first of the target's steps one of whose labels `text` names. */
function stepNamedIn(
    text: string,
    steps: readonly OriginStepDef[],
    plural: boolean,
    closing: boolean,
): OriginStepDef | undefined {
    return steps.find((s) => s.labels.some((label) => labelPattern(label, plural, closing).test(text)));
}

type GrantField =
    | "modifiers"
    | "fate"
    | "wounds"
    | "aptitudes"
    | "bonus"
    | "skills"
    | "talents"
    | "equipment"
    | "traits"
    | "xpCost"
    | "prerequisites"
    | "changes";

/** Grant labels → the grant they carry. */
const LABEL_FIELDS: readonly [RegExp, GrantField][] = [
    [/\bexperience cost\b/iu, "xpCost"],
    [/\bprerequisites?\b/iu, "prerequisites"],
    [/\b(?:instant changes|unlocked advances)\b/iu, "changes"],
    [/\bcharacteristic modifiers?\b/iu, "modifiers"],
    [/\bfate threshold\b/iu, "fate"],
    [/\bwounds?\b/iu, "wounds"],
    [/\baptitudes?\b/iu, "aptitudes"],
    [/\bbonus\b/iu, "bonus"],
    [/\bskills?\b/iu, "skills"],
    [/\btalents?\b/iu, "talents"],
    [/\bequipment\b/iu, "equipment"],
    [/\btraits?\b/iu, "traits"],
];

/** Labels carrying prose or conditions rather than a grant. */
const PROSE_FIELDS: ReadonlySet<GrantField> = new Set(["changes", "prerequisites"]);

/** Fewest grant labels that make a heading's sub-headings a rules block. */
const MIN_GRANT_LABELS = 2;
/** Pages before its rules block that the heading naming an origin may sit. */
const NAMING_HEADING_REACH = 1;

/**
 * Characteristic points per sign in a "+ Agility, – Willpower" modifier list
 * (the system's origin-path convention for a single step).
 */
const CHARACTERISTIC_STEP = 5;

/** A skill granted without a stated rank is granted at the scale's first rank. */
const GRANTED_SKILL_LEVEL = "known";

export interface OriginPathReading {
    name: string;
    step: OriginStepDef;
    pageIndex: number;
    /** The origin's introductory prose (plain text). */
    description: string;
    grants: JsonObject;
    modifiers: Record<string, number>;
    /** Rules text of a single-effect origin (a table row's effect), plain text. */
    effect?: string;
    /** Experience cost of taking the step, when it has one. */
    xpCost?: number;
    /** Prerequisites to take the step, as printed. */
    requirements?: string;
    /** Read from a summary table row rather than a rules block. */
    fromTable?: boolean;
}

/**
 * The target's creation step a table caption names ("Random Home World",
 * "Divinations"): the step's label is the caption's head noun, its last word.
 * A caption naming something else of that step ("… Powers") lists no origins.
 */
export function originStepNamedBy(caption: string, steps: readonly OriginStepDef[]): OriginStepDef | null {
    return stepNamedIn(caption, steps, true, true) ?? null;
}

/** A roll-band cell: "01", "02-05", "100". */
const ROLL_BAND = /^\d+(?:\s*[-–]\s*\d+)?$/u;

/**
 * "Increase this character's Perception by 5" / "Reduce … Agility
 * characteristic by 3" → characteristic key → points. A change offered between
 * characteristics ("Agility or Intelligence") is the player's choice, not a
 * fixed modifier.
 */
export function characteristicChanges(effect: string): Record<string, number> {
    const out: Record<string, number> = {};
    const re =
        /\b(?<verb>increase|reduce|decrease)\s+(?:(?:this character['’]s|his|her|their)\s+)?(?<name>[\p{L} ]+?)\s+(?:characteristic\s+)?by\s+(?<points>\d+)/giu;
    for (const m of effect.matchAll(re)) {
        const key = CHARACTERISTICS[m.groups?.["name"]?.trim().toLowerCase() ?? ""];
        if (key !== undefined) {
            const sign = /^increase$/iu.test(m.groups?.["verb"] ?? "") ? 1 : -1;
            out[key] = sign * Number(m.groups?.["points"] ?? "0");
        }
    }
    return out;
}

/** Longest name set before a colon in an origin table's cell ("Feral World: …"). */
const MAX_LEAD_NAME_LENGTH = 40;

/**
 * An origin table cell's name and the text after it: a quotation that opens
 * the cell is its name (the quote is what the origin is called), as is a short
 * capitalised lead before a colon; otherwise the whole cell, when it starts
 * like a name.
 */
export function originCellName(cell: string): { name: string; rest: string } | null {
    const text = cell.trim();
    const quoted = /^(?<quote>[“"](?<inner>[^”"]+)[”"])\s*(?<rest>.*)$/su.exec(text)?.groups;
    if (quoted?.["quote"] !== undefined && /^\p{Lu}/u.test(quoted["inner"] ?? "")) {
        return { name: quoted["quote"], rest: quoted["rest"] ?? "" };
    }
    const led = new RegExp(
        `^(?<name>\\p{Lu}[^:]{0,${MAX_LEAD_NAME_LENGTH - 1}}):\\s*(?<rest>.+)$`,
        "su",
    ).exec(text)?.groups;
    if (led?.["name"] !== undefined) {
        return { name: led["name"].trim(), rest: led["rest"] ?? "" };
    }
    return /^\p{Lu}/u.test(text) ? { name: text, rest: "" } : null;
}

/** Origins listed by a table whose caption names their step: one per row. */
export function readOriginTable(
    step: OriginStepDef,
    rows: readonly (readonly string[])[],
    pageIndex: number,
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    for (const cells of rows) {
        const nameAt = cells.findIndex((c) => c.trim().length > 0 && !ROLL_BAND.test(c.trim()));
        const named = nameAt < 0 ? null : originCellName(cells[nameAt] ?? "");
        if (named === null) {
            continue;
        }
        const name = named.name;
        const effect = [named.rest, ...cells.slice(nameAt + 1)]
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
            .join(" ");
        out.push({
            name,
            step,
            pageIndex,
            description: effect,
            grants: {},
            modifiers: characteristicChanges(effect),
            effect,
            fromTable: true,
        });
    }
    return out;
}

const labelField = (label: string): GrantField | undefined =>
    LABEL_FIELDS.find(([re]) => re.test(label))?.[1];

/** Split `text` on `separator` wherever it is not inside parentheses. */
export function splitTopLevel(text: string, separator: RegExp): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text.charAt(i);
        depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
        if (depth === 0) {
            const m = separator.exec(text.slice(i));
            if (m?.index === 0) {
                out.push(text.slice(start, i));
                start = i + m[0].length;
                i = start - 1;
            }
        }
    }
    out.push(text.slice(start));
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const LIST_SEPARATOR = /^,\s*/u;
const ALTERNATIVE = /^\s+or\s+/iu;

/** Capitalise each word but inner function words ("lho sticks" → "Lho Sticks"). */
function capitalizeWords(text: string): string {
    return text
        .split(/\s+/u)
        .map((w, i) =>
            i > 0 && FUNCTION_WORDS.has(w.toLowerCase())
                ? w.toLowerCase()
                : w.charAt(0).toUpperCase() + w.slice(1),
        )
        .join(" ");
}

/**
 * `Name (A, B)` → the name and its parenthesised specialisations, each held
 * (`A, B`) or to be chosen between (`A or B`).
 */
function withSpecialisations(item: string): { name: string; specialisations: string[]; chooseOne: boolean } {
    const m = /^(?<name>[^(]+?)\s*\((?<inner>[^)]*)\)\s*$/u.exec(item);
    const name = m?.groups?.["name"];
    const inner = m?.groups?.["inner"];
    if (name === undefined || inner === undefined) {
        return { name: item.trim(), specialisations: [], chooseOne: false };
    }
    return {
        name: name.trim(),
        specialisations: inner
            .split(/,|\s+or\s+/iu)
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        chooseOne: /\s+or\s+/iu.test(inner),
    };
}

/** "3 doses of stimm" → 3 × Stimm; "manacles" → 1 × Manacles. */
export function equipmentItem(text: string): { name: string; quantity: number } {
    const m = /^(?<count>\d+)\s+(?:\p{L}+\s+of\s+)?(?<rest>.+)$/iu.exec(text.trim());
    const count = m?.groups?.["count"];
    const rest = m?.groups?.["rest"];
    return count === undefined || rest === undefined
        ? { name: capitalizeWords(text.trim()), quantity: 1 }
        : { name: capitalizeWords(rest), quantity: Number(count) };
}

type ChoiceType = "skill" | "talent" | "aptitude" | "equipment" | "trait";

/**
 * A list grant: plain items are granted; an "A or B" item is a choice between
 * them; "Name (A or B)" is a choice of specialisation.
 */
function listGrants(
    text: string,
    type: ChoiceType,
    label: string,
    grant: (item: string) => JsonObject[],
    option: (item: string) => JsonObject,
): { granted: JsonObject[]; choices: JsonObject[] } {
    const granted: JsonObject[] = [];
    const choices: JsonObject[] = [];
    // A list names things; a sentence under the label is prose, not an item.
    for (const item of splitTopLevel(text, LIST_SEPARATOR).filter((i) => !readsAsProse(i))) {
        const alternatives = splitTopLevel(item, ALTERNATIVE);
        const specialisation = specialisationChoice(item, type, label);
        if (alternatives.length > 1) {
            choices.push({ type, label, count: 1, options: alternatives.map(option) });
        } else if (specialisation !== null) {
            choices.push(specialisation);
        } else {
            granted.push(...grant(item));
        }
    }
    return { granted, choices };
}

/** A named option: `{ name, label, value }` plus any extra fields. */
const namedOption = (name: string, extra: JsonObject = {}): JsonObject => ({
    name,
    label: name,
    value: name,
    ...extra,
});

/** A skill with each listed specialisation (or none) granted outright. */
function skillGrants(item: string): JsonObject[] {
    const { name, specialisations } = withSpecialisations(item);
    const specs = specialisations.length > 0 ? specialisations : [""];
    return specs.map((specialization) => ({ name, specialization, level: GRANTED_SKILL_LEVEL }));
}

/** A talent with each listed specialisation (or none) granted outright. */
function talentGrants(item: string): JsonObject[] {
    const { name, specialisations } = withSpecialisations(item);
    const specs = specialisations.length > 0 ? specialisations : [""];
    return specs.map((specialization) => ({ name, specialization }));
}

/** "Talent (A or B)": one talent whose specialisation the player picks. */
function specialisationChoice(item: string, type: ChoiceType, label: string): JsonObject | null {
    const { name, specialisations, chooseOne } = withSpecialisations(item);
    return chooseOne
        ? { type, label, count: 1, options: [namedOption(name, { specializations: specialisations })] }
        : null;
}

/** "+ Agility, + Perception, – Willpower" → characteristic key → points. */
export function characteristicModifiers(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of text.matchAll(/(?<sign>[+\-–−])\s*(?<name>[\p{L} ]+?)\s*(?=,|$)/gu)) {
        const key = CHARACTERISTICS[m.groups?.["name"]?.trim().toLowerCase() ?? ""];
        if (key !== undefined) {
            const sign = m.groups?.["sign"] === "+" ? 1 : -1;
            out[key] = (out[key] ?? 0) + sign * CHARACTERISTIC_STEP;
        }
    }
    return out;
}

/** "Name: effect" → a named special ability. */
function specialAbility(text: string): JsonObject | null {
    const m = /^(?<name>[^:]{2,60}):\s*(?<description>.+)$/su.exec(text.trim());
    const name = m?.groups?.["name"];
    const description = m?.groups?.["description"];
    return name === undefined || description === undefined
        ? null
        : { name: name.trim(), description: description.trim() };
}

/** Grants of one rules block. */
function grantsOf(labels: readonly Entry[]): {
    grants: JsonObject;
    modifiers: Record<string, number>;
    xpCost?: number;
    requirements?: string;
} {
    let xpCost: number | undefined;
    let requirements: string | undefined;
    const skills: JsonObject[] = [];
    const talents: JsonObject[] = [];
    const traits: JsonObject[] = [];
    const aptitudes: JsonValue[] = [];
    const equipment: JsonObject[] = [];
    const specialAbilities: JsonObject[] = [];
    const choices: JsonObject[] = [];
    let modifiers: Record<string, number> = {};
    let woundsFormula = "";
    let fateThreshold = 0;
    for (const entry of labels) {
        const label = capitalizeWords(entry.heading.text.toLowerCase());
        // A grant's value is the label's first paragraph; later ones are narrative.
        const value = (entry.body.split(PARAGRAPH_BREAK)[0] ?? "").trim();
        switch (labelField(entry.heading.text)) {
            case "xpCost": {
                const digits = /\d[\d,]*/u.exec(value)?.[0].replace(/,/gu, "");
                xpCost = digits === undefined ? undefined : Number(digits);
                break;
            }
            case "prerequisites":
                requirements = value;
                break;
            case "changes":
                // Prose rules of their own, kept whole under their label.
                specialAbilities.push({ name: label, description: entry.body.trim() });
                break;
            case "modifiers":
                modifiers = characteristicModifiers(value);
                break;
            case "fate":
                fateThreshold = Number(/\d+/u.exec(value)?.[0] ?? "0");
                break;
            case "wounds":
                woundsFormula =
                    /\d+\s*\+\s*\d*d\d+|\d*d\d+\s*\+\s*\d+|\d+/iu.exec(value)?.[0].replace(/\s+/gu, "") ?? "";
                break;
            case "aptitudes": {
                const r = listGrants(
                    value,
                    "aptitude",
                    label,
                    (a) => [{ name: a }],
                    (a) => namedOption(a),
                );
                aptitudes.push(...r.granted.map((g) => String(g["name"])));
                choices.push(...r.choices);
                break;
            }
            case "bonus": {
                const ability = specialAbility(value);
                if (ability !== null) {
                    specialAbilities.push(ability);
                }
                break;
            }
            case "skills": {
                const r = listGrants(value, "skill", label, skillGrants, (s) => {
                    const { name, specialisations } = withSpecialisations(s);
                    return namedOption(name, { specialization: specialisations.join(", ") });
                });
                skills.push(...r.granted);
                choices.push(...r.choices);
                break;
            }
            case "talents": {
                const r = listGrants(value, "talent", label, talentGrants, (t) => {
                    const { name, specialisations } = withSpecialisations(t);
                    return namedOption(name, { specialization: specialisations.join(", ") });
                });
                talents.push(...r.granted);
                choices.push(...r.choices);
                break;
            }
            case "traits": {
                const r = listGrants(
                    value,
                    "trait",
                    label,
                    (t) => [{ name: t }],
                    (t) => namedOption(t),
                );
                traits.push(...r.granted);
                choices.push(...r.choices);
                break;
            }
            case "equipment": {
                const r = listGrants(
                    value,
                    "equipment",
                    label,
                    (e) => [equipmentItem(e)],
                    (e) => namedOption(equipmentItem(e).name),
                );
                equipment.push(...r.granted);
                choices.push(...r.choices);
                break;
            }
            default:
                break;
        }
    }
    return {
        ...(xpCost === undefined ? {} : { xpCost }),
        ...(requirements === undefined ? {} : { requirements }),
        grants: {
            woundsFormula,
            fateFormula: fateThreshold > 0 ? String(fateThreshold) : "",
            fateThreshold,
            blessedByEmperor: false,
            skills,
            talents,
            traits,
            aptitudes,
            equipment,
            specialAbilities,
            choices,
        },
        modifiers,
    };
}

/**
 * A step label matched in a section heading with spaces removed (display
 * headings are often letter-spaced: "ELITE ADV ANCES") must be at least this
 * long, so it cannot occur inside another word.
 */
const MIN_SPACELESS_LABEL = 8;

/** The step named by the nearest enclosing section that names one. */
function stepOfSections(
    sections: readonly string[],
    steps: readonly OriginStepDef[],
): OriginStepDef | undefined {
    const squash = (s: string): string => s.replace(/\s+/gu, "").toLowerCase();
    for (const section of [...sections].reverse()) {
        const hit = steps.find((s) =>
            s.labels.some(
                (label) =>
                    squash(label).length >= MIN_SPACELESS_LABEL && squash(section).includes(squash(label)),
            ),
        );
        if (hit !== undefined) {
            return hit;
        }
    }
    return undefined;
}

/** Does `prefix` begin `text` as whole words (case-insensitive)? */
/** A heading's name: the text after a leading "Kind:" label ("New Role: Lamplighter"), else the whole. */
export function headingName(heading: string): string {
    return heading.replace(/^[^:]*:\s*(?=\S)/u, "");
}

const letters = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The leading words of `text` that spell `prefix` (letters only, so a text
 * layer's split letters — "h ere T ek" — still match), when more words follow;
 * else null.
 */
export function wordPrefix(prefix: string, text: string): string | null {
    const want = letters(prefix);
    const words = text.trim().split(/\s+/u);
    for (let k = 1; k < words.length; k++) {
        const head = words.slice(0, k).join(" ");
        if (letters(head) === want && want.length > 0) {
            return head;
        }
    }
    return null;
}

/** Read every origin-path rules block among the document's entries (in order). */
export function readOriginPaths(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    entries.forEach((owner, i) => {
        const labels: Entry[] = [];
        for (const e of entries.slice(i + 1)) {
            if (e.sections.at(-1) !== owner.heading.text) {
                break;
            }
            labels.push(e);
        }
        const fielded = labels.filter((l) => labelField(l.heading.text) !== undefined);
        const step =
            fielded
                .map((l) => stepNamedIn(l.heading.text, steps, false, false))
                .find((s) => s !== undefined) ??
            stepOfSections(owner.sections, steps) ??
            // A rules block with an experience cost is the step bought with experience.
            (fielded.some((l) => labelField(l.heading.text) === "xpCost")
                ? steps.find((s) => s.boughtWithXp === true)
                : undefined);
        // Prose rules and prerequisites alone describe a step in general; a
        // rules block grants something.
        const grantsSomething = fielded.some(
            (l) => !PROSE_FIELDS.has(labelField(l.heading.text) ?? "changes"),
        );
        if (step === undefined || fielded.length < MIN_GRANT_LABELS || !grantsSomething) {
            return;
        }
        // The origin is named by the heading this rules block extends ("Hive
        // World" for "Hive World Rules"), whose prose introduces it — or, when
        // the rules heading broke across lines, by the bodiless heading line
        // directly above it.
        const before = entries
            .slice(0, i)
            .filter((e) => e.heading.pageIndex >= owner.heading.pageIndex - NAMING_HEADING_REACH);
        const prior = before.at(-1);
        const firstLine =
            prior !== undefined && prior.body.length === 0 && prior.fields.length === 0 ? prior : undefined;
        const extended = [...before]
            .reverse()
            .map((e) => ({ e, words: wordPrefix(headingName(e.heading.text), owner.heading.text) }))
            .find(({ words }) => words !== null);
        const head = extended?.e ?? firstLine ?? owner;
        const intro = [...before, head]
            .reverse()
            .find((e) => e.heading.text === head.heading.text && e.body.length > 0);
        out.push({
            // The rules heading's own words spell the name most cleanly.
            name: extended?.words ?? headingName(head.heading.text),
            step,
            pageIndex: (intro ?? head).heading.pageIndex,
            description: intro?.body ?? "",
            ...grantsOf(fielded),
        });
    });
    return out;
}
