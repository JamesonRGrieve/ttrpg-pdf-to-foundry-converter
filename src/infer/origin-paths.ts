// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import { type Entry, PARAGRAPH_BREAK } from "./detect-entries.ts";
import { BULLETED_RULE, CHARACTERISTICS } from "./entry-types.ts";
import { caseLost, FUNCTION_WORDS, readsAsProse, rejoinSplitWords, wordsOf } from "./names.ts";
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
    // A label numbered ("Chapter XIV:", "Section 3") names a division of the
    // book, not the step.
    const unnumbered = "(?!\\s*(?:[IVXLC]+|\\d+)\\b)";
    return new RegExp(
        `\\b${words.join("\\s*")}${plural ? "s?" : ""}${closing ? "\\W*$" : `\\b${unnumbered}`}`,
        "iu",
    );
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
    | "changes"
    | "specialAbilities";

/** Grant labels → the grant they carry. */
const LABEL_FIELDS: readonly [RegExp, GrantField][] = [
    [/\bexperience cost\b|^\s*(?:package\s+)?cost\s*$/iu, "xpCost"],
    [/\bprerequisites?\b/iu, "prerequisites"],
    [/\b(?:instant changes|unlocked advances)\b/iu, "changes"],
    [/\bspecial abilit(?:y|ies)\b/iu, "specialAbilities"],
    [/\bcharacteristic modifiers?\b/iu, "modifiers"],
    [/\bfate\b/iu, "fate"],
    [/\bwounds?\b/iu, "wounds"],
    [/\baptitudes?\b/iu, "aptitudes"],
    [/\bbonus\b/iu, "bonus"],
    [/\bskills?\b/iu, "skills"],
    [/\btalents?\b/iu, "talents"],
    [/\b(?:equipment|gear)\b/iu, "equipment"],
    [/\btraits?\b/iu, "traits"],
];

/** A label's text offering its listed items as a choice of one. */
const CHOOSE_ONE = /\bchoose (?:one|1)\b/iu;

/** Labels pricing or gating what they head: one of each per origin. */
const PRICE_FIELDS: ReadonlySet<GrantField> = new Set(["xpCost", "prerequisites"]);

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
/**
 * A sentence granting skills at a rank of the schema's scale: "… with A and B
 * as Trained … Skills", "… gains A as a Trained … Skill".
 */
const RANKED_SKILLS =
    /\b(?:with|gains?)\s+(?<list>.+?)\s+as\s+(?:an?\s+)?(?<rank>known|trained|experienced|veteran)\b/iu;
/** Items of a prose list: "A, B and C". */
const LIST_AND = /^(?:,\s*(?:and\s+)?|\s+and\s+)/iu;

export interface OriginPathReading {
    name: string;
    step: OriginStepDef;
    pageIndex: number;
    /** The origin's introductory prose (plain text). */
    description: string;
    grants: JsonObject;
    modifiers: Record<string, number>;
    /** Signed changes to the character's resources (`wounds`, `fate`), when printed. */
    resources?: Record<string, number>;
    /** The origin grants a Psy Rating, so it makes the character a psyker. */
    grantsPsychicPowers?: true;
    /** Rules text of a single-effect origin (a table row's effect), plain text. */
    effect?: string;
    /** Experience cost of taking the step, when it has one. */
    xpCost?: number;
    /** Prerequisites to take the step, as printed. */
    requirements?: string;
    /** Read from a summary table row rather than a rules block. */
    fromTable?: boolean;
    /**
     * The origin's own named rules, each printed as a `Name: rules` field
     * beside its grant fields ("Accustomed to Crowds: …"): talents the origin
     * gives, named and described where it prints them.
     */
    rules?: OriginRule[];
}

/** A named rule an origin gives: a `Name: rules` field of its own. */
export interface OriginRule {
    name: string;
    description: string;
    /** The label of the field offering it as one of a choice ("Effect"), when it is an option. */
    choice?: string;
}

/** Most words a field label naming a rule of its own may have. */
const MAX_RULE_NAME_WORDS = 8;

/**
 * Whether a field label that names no grant names a rule of its own: words
 * opening on a capital or a digit-free letter run, short as a name is — not a
 * roll band ("1-2") or a sentence a layout read as a label.
 */
function namesRule(label: string): boolean {
    const words = label.trim().split(/\s+/u);
    return words.length <= MAX_RULE_NAME_WORDS && /^\p{L}/u.test(label.trim()) && !/\d/u.test(label);
}

/**
 * The target's creation step a table caption names ("Random Home World",
 * "Divinations"): the step's label is the caption's head noun, its last word.
 * A caption naming something else of that step ("… Powers") lists no origins.
 */
export function originStepNamedBy(caption: string, steps: readonly OriginStepDef[]): OriginStepDef | null {
    return stepNamedIn(caption, steps, true, true) ?? null;
}

/** Whether `text` names one of the target's creation steps anywhere in it ("Home World or Origin"). */
export function namesOriginStep(text: string, steps: readonly OriginStepDef[]): boolean {
    return stepNamedIn(text, steps, true, false) !== undefined;
}

/**
 * Whether a table whose caption names `captionStep` has its name column
 * headed by another step ("Career" under "Suggested Home Worlds"): its rows
 * pair origins of the two steps, each described where it is printed, rather
 * than being origins of the caption's step.
 */
export function pairsSteps(
    captionStep: OriginStepDef | null,
    headers: readonly string[],
    steps: readonly OriginStepDef[],
): boolean {
    const nameStep = originStepNamedBy(headers[0] ?? "", steps);
    return captionStep !== null && nameStep !== null && nameStep.key !== captionStep.key;
}

/** A roll-band cell: "01", "02-05", "100". */
const ROLL_BAND = /^\d+(?:\s*[-–]\s*\d+)?$/u;

/**
 * "Increase this character's Perception by 5" / "Reduce … Agility
 * characteristic by 3" → characteristic key → points; the amount may carry
 * its sign ("by +2"), and several characteristics may share it ("Weapon Skill
 * and Ballistic Skill each by +2"). A change offered between characteristics
 * ("Agility or Intelligence") is the player's choice, not a fixed modifier.
 */
export function characteristicChanges(effect: string): Record<string, number> {
    const out: Record<string, number> = {};
    const re =
        /\b(?<verb>increase|reduce|decrease)\s+(?:(?:this character['’]s|his|her|their|your)\s+)?(?<name>[\p{L} ]+?)\s+(?:characteristics?\s+)?(?:each\s+)?by\s+[+\-–−]?(?<points>\d+)/giu;
    for (const m of effect.matchAll(re)) {
        const names = (m.groups?.["name"] ?? "").split(/\s+and\s+/iu).map((n) => n.trim().toLowerCase());
        const keys = names.map((n) => CHARACTERISTICS[n]);
        if (keys.every((k) => k !== undefined)) {
            const sign = /^increase$/iu.test(m.groups?.["verb"] ?? "") ? 1 : -1;
            for (const key of keys) {
                out[key] = sign * Number(m.groups?.["points"] ?? "0");
            }
        }
    }
    return out;
}

/** Shortest characteristic name read after a signed value: full names, never abbreviations. */
const MIN_SIGNED_NAME = 4;

/**
 * "+5 Fellowship, –3 Weapon Skill" → characteristic key → points. Signed
 * values naming anything else ("+2 Wounds") are left out.
 */
export function signedCharacteristicChanges(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of text.matchAll(
        /(?<sign>[+\-–−])\s*(?<points>\d+)\s+(?<first>\p{L}+)(?:\s+(?<second>\p{L}+))?/gu,
    )) {
        const first = m.groups?.["first"]?.toLowerCase() ?? "";
        const both = `${first} ${m.groups?.["second"]?.toLowerCase() ?? ""}`;
        const name = [both, first].find(
            (n) => n.length >= MIN_SIGNED_NAME && CHARACTERISTICS[n] !== undefined,
        );
        const key = name === undefined ? undefined : CHARACTERISTICS[name];
        if (key !== undefined) {
            const sign = m.groups?.["sign"] === "+" ? 1 : -1;
            out[key] = (out[key] ?? 0) + sign * Number(m.groups?.["points"] ?? "0");
        }
    }
    return out;
}

/** The schema's origin resources, as an effect names them. */
const RESOURCE_NAMES: readonly [RegExp, string][] = [
    [/^wounds?$/iu, "wounds"],
    [/^fate\s+points?$/iu, "fate"],
    [/^corruption\s+points?$/iu, "corruption"],
    [/^insanity\s+points?$/iu, "insanity"],
];

/** One resource amount: "3 Corruption Points", "2 additional Wounds". */
const RESOURCE_AMOUNT = String.raw`(?<points>\d+)\s+(?:additional\s+)?(?<what>wounds?|(?:fate|corruption|insanity)\s+points?)\b`;

/**
 * "Gain 1 Fate Point", "Begin play with 1 Insanity Point and 1 Corruption
 * Point", "+2 Wounds" → resource key → points: what an effect adds to the
 * character's wounds, Fate, Corruption or Insanity. A sign after a die
 * ("1d5+1 Corruption Points") is a rolled amount, not a fixed one.
 */
export function resourceChanges(effect: string): Record<string, number> {
    const out: Record<string, number> = {};
    const amount = RESOURCE_AMOUNT.replace(/\?<\w+>/gu, "?:");
    const lead = new RegExp(
        String.raw`(?:\b(?:gains?|begins?\s+play\s+with)\s+|(?<![\p{L}\d]\s*)\+\s*)(?<list>${amount}(?:\s*(?:,|and)\s+${amount})*)`,
        "giu",
    );
    for (const m of effect.matchAll(lead)) {
        for (const item of (m.groups?.["list"] ?? "").matchAll(new RegExp(RESOURCE_AMOUNT, "giu"))) {
            const what = item.groups?.["what"] ?? "";
            const key = RESOURCE_NAMES.find(([name]) => name.test(what))?.[1];
            if (key !== undefined) {
                out[key] = (out[key] ?? 0) + Number(item.groups?.["points"] ?? "0");
            }
        }
    }
    return out;
}

/** An origin reading's `resources`, when its effect changes any. */
function withResources(effect: string): { resources?: Record<string, number> } {
    const resources = resourceChanges(effect);
    return Object.keys(resources).length === 0 ? {} : { resources };
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
            modifiers: { ...signedCharacteristicChanges(effect), ...characteristicChanges(effect) },
            ...withResources(effect),
            effect,
            fromTable: true,
        });
    }
    return out;
}

const labelField = (label: string): GrantField | undefined => {
    // A text layer may join a label's words ("StartingAptitudes").
    const spaced = label.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
    return LABEL_FIELDS.find(([re]) => re.test(spaced))?.[1];
};

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

/**
 * A granted trait as the schema holds it: a bracketed figure is its level
 * ("Unnatural Toughness (2)"), a bracketed word its specialisation
 * ("Unnatural Characteristic (Strength)").
 */
export function traitGrant(text: string): JsonObject {
    const m = /^(?<name>[^(]+?)\s*\((?<inner>[^()]+)\)\s*$/u.exec(text.trim());
    const name = m?.groups?.["name"];
    const inner = m?.groups?.["inner"]?.trim();
    if (name === undefined || inner === undefined) {
        return { name: text.trim() };
    }
    const level = /^(\d+)$/u.exec(inner)?.[1];
    if (level !== undefined) {
        return { name, level: Number(level) };
    }
    return /^\p{L}[\p{L}\s'-]*$/u.test(inner) ? { name, specialization: inner } : { name: text.trim() };
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

type ChoiceType = "skill" | "talent" | "aptitude" | "equipment" | "trait" | "specialAbility";

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
    // A list names things; a sentence under the label is prose, not an item,
    // and neither is a stray mark or (for skills and talents, which are
    // capitalised names) a fragment of running text.
    const named = (i: string): boolean =>
        type === "skill" || type === "talent" ? /^\s*[\p{Lu}\p{N}]/u.test(i) : /\p{L}/u.test(i);
    // The list may close its sentence: the full stop is not part of the last item.
    const items = splitTopLevel(text.replace(/\.\s*$/u, ""), LIST_SEPARATOR);
    for (const item of items
        .filter((i) => !readsAsProse(i) && named(i))
        .map((i) => (type === "skill" ? withoutCharacteristicTag(i) : i))
        .flatMap((i) => mixedSpecialisations(i) ?? [i])) {
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

/**
 * Grants with each skill granted at the reading's base level (`known`, the
 * first rank of a ladder starting there) at `base` instead: the first level of
 * the target line's ladder. A stated higher level stays.
 */
export function withSkillLevelBase(grants: JsonObject, base: string): JsonObject {
    const skills = grants["skills"];
    if (base === GRANTED_SKILL_LEVEL || !Array.isArray(skills)) {
        return grants;
    }
    return {
        ...grants,
        skills: skills.map((s) =>
            s !== null && typeof s === "object" && !Array.isArray(s) && s["level"] === GRANTED_SKILL_LEVEL
                ? { ...s, level: base }
                : s,
        ),
    };
}

/**
 * A skill without the characteristic it tests printed after it in brackets
 * ("Command (Fel)", "Common Lore (Imperium) (Int)"): the tag is no
 * specialisation.
 */
function withoutCharacteristicTag(item: string): string {
    const m = /^(?<rest>.*?\S)\s*\((?<tag>[^()]+)\)\s*$/u.exec(item);
    const tag = m?.groups?.["tag"]?.trim().toLowerCase();
    const rest = m?.groups?.["rest"];
    return tag !== undefined && rest !== undefined && CHARACTERISTICS[tag] !== undefined ? rest : item;
}

/**
 * "Name (A, and B or C)": specialisations listed apart, some held and some to
 * be chosen between, read as one item each ("Name (A)", "Name (B or C)").
 * Null for any other item.
 */
function mixedSpecialisations(item: string): string[] | null {
    const m = /^(?<name>[^(]+?)\s*\((?<inner>[^()]*)\)\s*$/u.exec(item);
    const name = m?.groups?.["name"]?.trim();
    const inner = m?.groups?.["inner"];
    if (name === undefined || inner === undefined || !/,/u.test(inner) || !/\s+or\s+/iu.test(inner)) {
        return null;
    }
    const parts = inner
        .split(",")
        .map((p) => p.replace(/^\s*and\s+/iu, "").trim())
        .filter((p) => p.length > 0);
    return parts.length > 1 ? parts.map((p) => `${name} (${p})`) : null;
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

/** Whether a reading grants anything: a modifier, a wound or fate value, or a listed grant. */
function grantsAnything(read: {
    grants: JsonObject;
    modifiers: Record<string, number>;
    resources?: Record<string, number>;
}): boolean {
    return (
        Object.keys(read.modifiers).length > 0 ||
        Object.keys(read.resources ?? {}).length > 0 ||
        read.grants["woundsFormula"] !== "" ||
        read.grants["fateThreshold"] !== 0 ||
        Object.values(read.grants).some((v) => Array.isArray(v) && v.length > 0)
    );
}

/** Grants of one rules block; `optionsOf` gives the headings a label lists beneath it. */
function grantsOf(
    labels: readonly Entry[],
    optionsOf: (label: Entry) => readonly Entry[],
    namedRules = false,
): {
    grants: JsonObject;
    modifiers: Record<string, number>;
    resources?: Record<string, number>;
    grantsPsychicPowers?: true;
    xpCost?: number;
    requirements?: string;
    rules?: OriginRule[];
} {
    const rules: OriginRule[] = [];
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
    const resources: Record<string, number> = {};
    let psyker = false;
    for (const entry of labels) {
        const label = capitalizeWords(entry.heading.text.toLowerCase());
        // A grant's value is the label's first paragraph; later ones are narrative.
        const value = (entry.body.split(PARAGRAPH_BREAK)[0] ?? "").trim();
        const field = labelField(entry.heading.text);
        // A granted Psy Rating makes the character a psyker (#681); one asked
        // for by a prerequisite or price does not.
        if (field === undefined || !PRICE_FIELDS.has(field)) {
            psyker ||= PSY_RATING.test(entry.heading.text) || GRANTED_PSY_RATING.test(value);
        }
        switch (field) {
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
            case "fate": {
                // A signed value ("+1") changes the character's Fate; a bare one is the threshold.
                const bonus = signedBonus(value);
                if (bonus === null) {
                    fateThreshold = Number(/\d+/u.exec(value)?.[0] ?? "0");
                } else {
                    resources["fate"] = bonus;
                }
                break;
            }
            case "wounds": {
                // A signed value ("+2", "−1") is a bonus to the total, which the system
                // reads only from modifiers.resources.wounds; anything else is the
                // starting-wounds formula.
                const bonus = signedBonus(value);
                if (bonus === null) {
                    woundsFormula =
                        /\d+\s*\+\s*\d*d\d+|\d*d\d+\s*\+\s*\d+|\d+/iu.exec(value)?.[0].replace(/\s+/gu, "") ??
                        "";
                } else {
                    resources["wounds"] = bonus;
                }
                break;
            }
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
            case "specialAbilities": {
                // Each ability a heading of its own beneath the label; "choose
                // one" makes them options rather than grants.
                const abilities = optionsOf(entry).map((o) => ({
                    name: capitalizeWords(headingName(o.heading.text).toLowerCase()),
                    description: o.body.trim(),
                }));
                if (abilities.length === 0) {
                    const ability = specialAbility(value);
                    if (ability !== null) {
                        specialAbilities.push(ability);
                    }
                } else if (CHOOSE_ONE.test(value)) {
                    choices.push({ type: "specialAbility", label, count: 1, options: abilities });
                } else {
                    specialAbilities.push(...abilities);
                }
                break;
            }
            case "bonus": {
                // A named ability ("Name: effect"), or a characteristic bonus ("… gain +5 Fellowship").
                const ability = specialAbility(value);
                if (ability !== null) {
                    specialAbilities.push(ability);
                } else {
                    modifiers = { ...modifiers, ...signedCharacteristicChanges(value) };
                }
                break;
            }
            case "skills": {
                // "… begins with A and B as Trained Advanced Skills": the
                // named skills at the stated rank.
                const ranked = RANKED_SKILLS.exec(value)?.groups;
                if (ranked !== undefined) {
                    const level = (ranked["rank"] ?? GRANTED_SKILL_LEVEL).toLowerCase();
                    for (const item of splitTopLevel(ranked["list"] ?? "", LIST_AND)) {
                        skills.push(...skillGrants(item).map((s) => ({ ...s, level })));
                    }
                    break;
                }
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
                    (t) => [traitGrant(t)],
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
            default: {
                // A field naming no grant, beside fields that do, is a rule
                // of the origin's own, named by its label (granted as a talent
                // once the origin's name is known).
                const description = entry.body.trim();
                if (namedRules && description.length > 0 && namesRule(entry.heading.text)) {
                    rules.push({ name: entry.heading.text.trim(), description });
                }
                break;
            }
        }
    }
    // The psyker trait granted makes the character a psyker as a psy rating does.
    psyker ||= traits.some((t) => PSYKER.test(String(t["name"] ?? "")));
    return {
        ...(rules.length === 0 ? {} : { rules }),
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
        ...(Object.keys(resources).length === 0 ? {} : { resources }),
        ...(psyker ? { grantsPsychicPowers: true } : {}),
    };
}

/** A Psy Rating named in a grant: the schema's psy rating, which only a psyker has. */
const PSY_RATING = /\bpsy(?:chic)?\s+rating\b/iu;

/** The schema's psyker trait (and aptitude) by name. */
const PSYKER = /^\s*psyker\s*$/iu;

/**
 * A psy rating a field's text grants: stated with its value ("Psy Rating 2",
 * "a psy rating of 1", "Psy Rating (x2)"), or in a sentence saying the
 * character gains it. One that others have, named in a rule ("anyone who
 * has a psy rating"), grants none.
 */
const GRANTED_PSY_RATING =
    /\bgains?\b[^.•]*\bpsy(?:chic)?\s+rating\b|\bpsy(?:chic)?\s+rating\s*(?:of\s+)?\(?\s*(?:\d|[x×]\s*\d)/iu;

/** A value printed as a signed change ("+2", "−1", "-3"): its number, or null when unsigned. */
function signedBonus(value: string): number | null {
    const m = /^\s*([+−–-])\s*(\d+)\b(?!\s*\+\s*\d*d\d)/iu.exec(value);
    if (m === null) {
        return null;
    }
    const magnitude = Number(m[2]);
    return m[1] === "+" ? magnitude : -magnitude;
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
    // A section names a step's kind in the plural as often as not ("Lanterns").
    const forms = (label: string): string[] => {
        const one = squash(label);
        return [one, one.endsWith("y") ? `${one.slice(0, -1)}ies` : `${one}s`];
    };
    for (const section of [...sections].reverse()) {
        const hit = steps.find((s) =>
            s.labels.some(
                (label) =>
                    squash(label).length >= MIN_SPACELESS_LABEL &&
                    forms(label).some((form) => squash(section).includes(form)),
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

/** An experience price: "100 xp", "200 XP". */
const XP_PRICE = /\d[\d,]*\s*xp\b/iu;

/** An entry's inline `Label: value` fields as label entries, the shape `grantsOf` reads. */
function fieldEntries(entry: Entry): Entry[] {
    return entry.fields.map(([label, value]) => ({
        heading: { ...entry.heading, text: label },
        sections: [],
        fields: [],
        body: value,
    }));
}

/** Pages past its own heading that an origin's grant headings may run on. */
const GRANT_PAGE_REACH = 1;

/**
 * Origins printed as one heading with inline fields: a price in experience
 * under a section naming a creation step ("… Background Packages") makes the
 * heading an origin of that step. Fields naming earlier steps ("Home World:
 * …", "Career: …") are its prerequisites; its other fields, and those of the
 * headings after it up to its next sibling (one set like it) — its "Effects",
 * however they are set — are its grants. An origin grants something; a priced
 * heading granting nothing is a price list.
 */
export function readFieldedOrigins(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    entries.forEach((entry, i) => {
        const priced = entry.fields.some(
            ([label, value]) => labelField(label) === "xpCost" && XP_PRICE.test(value),
        );
        const step = stepOfSections(entry.sections, steps);
        if (!priced || step === undefined) {
            return;
        }
        const required = entry.fields.filter(
            ([label]) => stepNamedIn(label, steps, false, true) !== undefined,
        );
        const requiredLabels = new Set(required.map(([label]) => label));
        const under: Entry[] = [];
        for (const e of entries.slice(i + 1)) {
            if (
                e.heading.style === entry.heading.style ||
                e.heading.pageIndex > entry.heading.pageIndex + GRANT_PAGE_REACH
            ) {
                break;
            }
            under.push(e);
        }
        const granting = [entry, ...under]
            .flatMap(fieldEntries)
            .filter((e) => !requiredLabels.has(e.heading.text));
        const read = grantsOf(granting, () => []);
        if (!grantsAnything(read)) {
            return;
        }
        out.push({
            name: headingName(entry.heading.text),
            step,
            pageIndex: entry.heading.pageIndex,
            description: entry.body,
            ...read,
            ...(required.length === 0
                ? {}
                : { requirements: required.map(([label, value]) => `${label}: ${value}`).join(" ") }),
        });
    });
    return out;
}

/** Fewest kinds of grant an origin's inline fields carry. */
const MIN_INLINE_GRANTS = 2;

/**
 * The step a heading's section names: the section itself ("Choose a …"), or
 * the nearest earlier heading set like the section under the same parent —
 * a step's own heading may stand beside the origins it introduces rather
 * than above them.
 */
function stepOfSection(
    entries: readonly Entry[],
    index: number,
    steps: readonly OriginStepDef[],
): OriginStepDef | undefined {
    const sections = entries[index]?.sections ?? [];
    for (const section of [...sections].reverse()) {
        const named = stepNamedIn(section, steps, true, true);
        if (named !== undefined) {
            return named;
        }
    }
    const parentText = sections.at(-1);
    const parent = entries
        .slice(0, index)
        .findLast((e) => e.heading.text === parentText && e.sections.length === sections.length - 1);
    // Else the nearest section naming a step anywhere in it ("Home World
    // Options", "Career Paths").
    const anywhere = (): OriginStepDef | undefined =>
        [...sections]
            .reverse()
            .map((section) => stepNamedIn(section, steps, true, false))
            .find((s) => s !== undefined);
    if (parent === undefined) {
        return anywhere();
    }
    const siblingOf = (e: Entry): boolean =>
        e.heading.style === parent.heading.style &&
        e.sections.length === parent.sections.length &&
        e.sections.every((s, k) => s === parent.sections[k]);
    for (const e of entries.slice(0, entries.indexOf(parent)).reverse()) {
        if (e.sections.length < parent.sections.length) {
            return anywhere();
        }
        if (siblingOf(e)) {
            const named = stepNamedIn(e.heading.text, steps, true, true);
            if (named !== undefined) {
                return named;
            }
        }
    }
    return anywhere();
}

/**
 * Origins printed as a heading whose inline fields grant several kinds of
 * thing ("…: <skills>", "…: <talents>", "…: <gear>") under a section naming a
 * creation step, unpriced (a priced one is `readFieldedOrigins`'). The origin
 * is named by the heading's words before those its field labels use ("<Name>
 * Starting Abilities") or, when the heading is all label words ("Skills,
 * Talents & Gear"), by the section it sits in; the section's prose describes
 * it.
 */
export function readInlineOrigins(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    entries.forEach((entry, i) => {
        const kinds = new Set(
            entry.fields
                .map(([label, value]) => (value.trim().length > 0 ? labelField(label) : undefined))
                .filter((f) => f !== undefined && !PROSE_FIELDS.has(f)),
        );
        if (kinds.has("xpCost") || kinds.size < MIN_INLINE_GRANTS) {
            return;
        }
        const step = stepOfSection(entries, i, steps);
        if (step === undefined) {
            return;
        }
        const read = grantsOf(fieldEntries(entry), () => [], true);
        if (!grantsAnything(read)) {
            return;
        }
        const labelWords = new Set(entry.fields.flatMap(([label]) => label.split(/\s+/u).map(letters)));
        const words = entry.heading.text.trim().split(/\s+/u);
        const cut = words.findIndex(
            (w) => letters(w).length > 0 && (labelWords.has(letters(w)) || labelField(w) !== undefined),
        );
        // Connecting words alone ("And" before "Gear", a heading's second line) name nothing.
        const before = words.slice(0, cut < 0 ? words.length : cut);
        const own = before.every((w) => letters(w).length === 0 || FUNCTION_WORDS.has(letters(w)))
            ? ""
            : before.join(" ");
        const sectionText = entry.sections.at(-1);
        const section = entries.slice(0, i).findLast((e) => e.heading.text === sectionText);
        // A display heading the text layer split ("O perator") is rejoined by
        // how the section's own text spells its words.
        const under = entries.filter((e) => e.sections.at(-1) === sectionText);
        const vocabulary = wordsOf(
            [section?.body ?? "", ...under.map((e) => `${e.heading.text} ${e.body}`)].join(" "),
        );
        // A heading that extends an earlier one ("Hive World" then "Hive World
        // Characters") is named by the heading it extends.
        const extended = entries
            .slice(0, i)
            .filter((e) => e.heading.pageIndex >= entry.heading.pageIndex - NAMING_HEADING_REACH)
            .reverse()
            .map((e) => ({ e, words: wordPrefix(headingName(e.heading.text), entry.heading.text) }))
            .find(({ words }) => words !== null);
        // A section named for its origin and the step ("<Name> Career Path")
        // names the origin without the step's own words.
        const sectionName = withoutStepLabel(headingName(sectionText ?? ""), step.labels);
        const name = rejoinSplitWords(extended?.words ?? (own.length > 0 ? own : sectionName), vocabulary);
        if (letters(name).length === 0) {
            return;
        }
        out.push({
            name: capitalizeWords(name.toLowerCase()),
            step,
            pageIndex: entry.heading.pageIndex,
            description:
                extended !== undefined && extended.e.body.length > 0
                    ? extended.e.body
                    : (section?.body ?? entry.body),
            ...read,
        });
    });
    return out;
}

/**
 * A heading with a closing label of the step dropped ("<Name> Career Path" →
 * "<Name>" for the step labelled "career"); the heading as it is when that
 * would leave no name.
 */
export function withoutStepLabel(heading: string, labels: readonly string[]): string {
    // Display type may split a word's letters ("C areer P ath"): any letter may be followed by a space.
    const spaced = (word: string): string =>
        [...word]
            .filter((c) => /\p{L}/u.test(c))
            .map((c) => c.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
            .join("\\s*");
    for (const label of labels) {
        const words = label.split(/\s+/u).map(spaced).join("\\s+");
        const cut = heading
            .replace(new RegExp(`\\s+${words}(?:\\s+${spaced("path")})?\\s*$`, "iu"), "")
            .trim();
        if (cut !== heading.trim() && letters(cut).length > 0) {
            return cut;
        }
    }
    return heading;
}

/** A heading naming an origin's abilities: "<Origin> Special Ability" / "… Abilities". */
const ABILITIES_OF = /^(?<origin>.+?)\s+special\s+abilit(?:y|ies)\s*$/iu;

/** An origin's named rules printed apart from it, under a heading naming whose they are. */
export interface OriginAbilities {
    /** The origin the heading names, as printed. */
    origin: string;
    step: OriginStepDef;
    pageIndex: number;
    rules: OriginRule[];
}

/**
 * An origin's abilities printed apart from its grants: a heading naming the
 * origin and closing on the schema's special-ability label ("<Origin> Special
 * Ability") under a section naming a creation step, each ability a `Name:
 * rules` field beneath it.
 */
export function readOriginAbilities(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): OriginAbilities[] {
    return entries.flatMap((entry): OriginAbilities[] => {
        const origin = ABILITIES_OF.exec(entry.heading.text.trim())?.groups?.["origin"]?.trim();
        if (origin === undefined || letters(origin).length === 0) {
            return [];
        }
        const step = [...entry.sections]
            .reverse()
            .map((section) => stepNamedIn(section, steps, true, false))
            .find((s) => s !== undefined);
        const rules = entry.fields
            .filter(([label, value]) => value.trim().length > 0 && namesRule(label))
            .map(([label, value]) => ({ name: label.trim(), description: value.trim() }));
        if (step === undefined || rules.length === 0) {
            return [];
        }
        return [
            {
                // Set in capitals (or with its case lost), the name takes title case.
                origin:
                    caseLost(origin) || !/\p{Ll}/u.test(origin)
                        ? capitalizeWords(origin.toLowerCase())
                        : origin,
                step,
                pageIndex: entry.heading.pageIndex,
                rules,
            },
        ];
    });
}

/** Whether two printed names spell the same origin (letters only, any case). */
export function sameOrigin(a: string, b: string): boolean {
    return letters(a) === letters(b);
}

/** How far up an entry's sections the step naming it may be (its own section, or its parent's). */
const STEP_SECTION_DEPTH = 2;

/**
 * Origins printed as headings directly under a section naming a creation
 * step, each with its prose and its rules as `Label: value` fields ("Effect:
 * …", or named options), and no grant labels a rules block or an inline
 * reading would take (`readOriginPaths`, `readInlineOrigins`). The fields are
 * the origin's effect; characteristic changes printed in it are its modifiers.
 */
export function readEffectOrigins(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): OriginPathReading[] {
    return entries.flatMap((entry): OriginPathReading[] => {
        if (entry.fields.length === 0 || stepNamedIn(entry.heading.text, steps, true, false) !== undefined) {
            return [];
        }
        const step = entry.sections
            .slice(-STEP_SECTION_DEPTH)
            .reverse()
            .map((section) => stepNamedIn(section, steps, true, false))
            .find((s) => s !== undefined);
        if (step === undefined) {
            return [];
        }
        // A field offering a choice ("Effect: Choose one of the following …")
        // lists its options as bulleted `Name: rules` items, which a layout
        // may set apart from the field, among the entry's prose.
        const offering = entry.fields.find(([, value]) => CHOOSE_ONE.test(value));
        const options =
            offering === undefined
                ? []
                : [...entry.body.matchAll(BULLETED_RULE)].flatMap((m) => {
                      const ruleName = m.groups?.["name"]?.trim() ?? "";
                      const rules = m.groups?.["rules"]?.replace(/\s+/gu, " ").trim() ?? "";
                      return namesRule(ruleName) && rules.length > 0
                          ? [{ name: ruleName, description: rules, choice: offering[0].trim(), whole: m[0] }]
                          : [];
                  });
        const body = options.reduce((text, o) => text.replace(o.whole, ""), entry.body).trim();
        const effect = [
            ...entry.fields.map(([label, value]) => `${label}: ${value}`),
            ...options.map((o) => `• ${o.name}: ${o.description}`),
        ].join(PARAGRAPH_BREAK);
        const name = headingName(entry.heading.text).trim();
        return [
            {
                name: caseLost(name) ? capitalizeWords(name.toLowerCase()) : name,
                step,
                pageIndex: entry.heading.pageIndex,
                description: body,
                grants: {},
                modifiers: { ...signedCharacteristicChanges(effect), ...characteristicChanges(effect) },
                // An option offered among others is no fixed change to a resource.
                ...withResources(entry.fields.map(([, value]) => value).join(PARAGRAPH_BREAK)),
                effect,
                ...(options.length === 0 ? {} : { rules: options.map(({ whole: _whole, ...rule }) => rule) }),
            },
        ];
    });
}

/** A printed page range a section cites: "… on pages 38–54". */
const CITED_PAGES = /\bpages\s+(?<lo>\d+)\s*[-–]\s*(?<hi>\d+)\b/giu;
/** A leading article a heading may set before the name its sections repeat ("The …"). */
const LEADING_ARTICLE = /^the\s+/iu;

/** A printed page range, inclusive. */
export interface PageRange {
    lo: number;
    hi: number;
}

/**
 * The printed page ranges a step's own section cites for its origins ("You
 * will find a selection of <step>s on pages 38–54"), by step key.
 */
export function citedOriginPages(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): Map<string, PageRange[]> {
    const out = new Map<string, PageRange[]>();
    for (const entry of entries) {
        const step = stepNamedIn(entry.heading.text, steps, true, true);
        if (step === undefined) {
            continue;
        }
        for (const m of entry.body.matchAll(CITED_PAGES)) {
            const range = { lo: Number(m.groups?.["lo"]), hi: Number(m.groups?.["hi"]) };
            if (range.lo < range.hi) {
                out.set(step.key, [...(out.get(step.key) ?? []), range]);
            }
        }
    }
    return out;
}

/**
 * Origins found by the pages a step's own section cites for them
 * (`citedOriginPages`): within those pages, a heading with a heading of its
 * own beneath it that repeats its name and says more ("<Name>" over "<Name>
 * Characters") is an origin of that step, named as the inner heading spells
 * it; the inner heading's prose states what the origin gives, its
 * characteristic changes its modifiers. `printedPage` gives a page's printed
 * number.
 */
export function readCitedOrigins(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
    printedPage: (pageIndex: number) => string,
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    const taken = new Set<Entry>();
    for (const [key, ranges] of citedOriginPages(entries, steps)) {
        const step = steps.find((s) => s.key === key);
        for (const { lo, hi } of ranges) {
            const within = (e: Entry): boolean => {
                const page = Number(printedPage(e.heading.pageIndex));
                return page >= lo && page <= hi;
            };
            entries.forEach((origin, i) => {
                if (step === undefined || taken.has(origin) || !within(origin)) {
                    return;
                }
                const own = origin.heading.text.trim().replace(LEADING_ARTICLE, "");
                const rules = entries
                    .slice(i + 1)
                    .find(
                        (e) =>
                            within(e) &&
                            e.sections.includes(origin.heading.text) &&
                            wordPrefix(own, e.heading.text) !== null,
                    );
                const words = rules === undefined ? null : wordPrefix(own, rules.heading.text);
                if (rules === undefined || words === null) {
                    return;
                }
                taken.add(origin);
                out.push({
                    name:
                        caseLost(words) || !/\p{Ll}/u.test(words)
                            ? capitalizeWords(words.toLowerCase())
                            : words,
                    step,
                    pageIndex: rules.heading.pageIndex,
                    description: origin.body,
                    grants: {},
                    modifiers: {
                        ...signedCharacteristicChanges(rules.body),
                        ...characteristicChanges(rules.body),
                    },
                    ...withResources(rules.body),
                });
            });
        }
    }
    return out;
}

/**
 * A document's origin readings with the cited pages applied: a step whose
 * own section cites the pages its origins are printed on has them there, so
 * a reading of it from other pages is not one of them; read no other way
 * within those pages (nor from a table, `tabled`), its origins are
 * `readCitedOrigins`'.
 */
export function withCitedOrigins(
    readings: readonly OriginPathReading[],
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
    printedPage: (pageIndex: number) => string,
    tabled: ReadonlySet<string | undefined>,
): OriginPathReading[] {
    const ranges = citedOriginPages(entries, steps);
    const onCitedPages = (o: OriginPathReading): boolean => {
        const cited = ranges.get(o.step.key);
        const page = Number(printedPage(o.pageIndex));
        return cited === undefined || cited.some((r) => page >= r.lo && page <= r.hi);
    };
    const kept = readings.filter(onCitedPages);
    const keptSteps = new Set(kept.map((o) => o.step.key));
    const cited = readCitedOrigins(entries, steps, printedPage).filter(
        (o) => !keptSteps.has(o.step.key) && !tabled.has(o.step.key),
    );
    return [...kept, ...cited];
}

/** Fewest headings beneath an origin's own that repeat its name for it to be read by them. */
const MIN_NAMED_RULES = 2;

/**
 * Origins each printed under a heading of their own, with at least two
 * headings beneath it that repeat its name and say more ("<Name> Pasts",
 * "<Name> Solo Mode Ability"), where the heading's own section closes on a
 * creation step's name ("… the <Step>"). The heading's prose
 * describes the origin.
 */
export function readHeadedOrigins(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    const seen = new Set<string>();
    entries.forEach((origin, i) => {
        const section = origin.sections.at(-1);
        // The step closes the section's heading: a heading that names it and
        // goes on ("<Step> Wargear") is about something else.
        const step = section === undefined ? undefined : stepNamedIn(section, steps, true, true);
        const own = origin.heading.text.trim();
        if (step === undefined || letters(own).length === 0 || seen.has(`${step.key}:${letters(own)}`)) {
            return;
        }
        const named = new Set<string>();
        // Its rules run on until the next heading set as it is, beside it.
        for (const e of entries.slice(i + 1)) {
            if (
                e.heading.style === origin.heading.style &&
                e.sections.length === origin.sections.length &&
                e.sections.every((s, k) => s === origin.sections[k])
            ) {
                break;
            }
            if (e.sections.includes(origin.heading.text) && wordPrefix(own, e.heading.text) !== null) {
                named.add(letters(e.heading.text));
            }
        }
        if (named.size < MIN_NAMED_RULES) {
            return;
        }
        seen.add(`${step.key}:${letters(own)}`);
        out.push({
            name: caseLost(own) || !/\p{Ll}/u.test(own) ? capitalizeWords(own.toLowerCase()) : own,
            step,
            pageIndex: origin.heading.pageIndex,
            description: origin.body,
            grants: {},
            modifiers: {},
        });
    });
    return out;
}

/**
 * The headings directly beneath `entries[index]`, read on until its section
 * closes; headings nested deeper are passed over (two columns can set a
 * sub-heading's own heading before its sibling's).
 */
function childrenOf(entries: readonly Entry[], index: number): Entry[] {
    const parent = entries[index]?.heading.text;
    const children: Entry[] = [];
    for (const e of entries.slice(index + 1)) {
        if (parent === undefined || !e.sections.includes(parent)) {
            break;
        }
        if (e.sections.at(-1) === parent) {
            children.push(e);
        }
    }
    return children;
}

/**
 * Read every origin-path rules block among the document's entries (in order).
 * `runningHeads` gives each page's running text, which names the step when no
 * heading does.
 */
export function readOriginPaths(
    entries: readonly Entry[],
    steps: readonly OriginStepDef[],
    runningHeads: ReadonlyMap<number, readonly string[]>,
): OriginPathReading[] {
    const out: OriginPathReading[] = [];
    entries.forEach((owner, i) => {
        const labels = childrenOf(entries, i);
        const fielded = labels.filter((l) => labelField(l.heading.text) !== undefined);
        const step =
            fielded
                .map((l) => stepNamedIn(l.heading.text, steps, false, false))
                .find((s) => s !== undefined) ??
            stepOfSections(owner.sections, steps) ??
            stepOfSections(runningHeads.get(owner.heading.pageIndex) ?? [], steps) ??
            // A rules block with an experience cost is the step bought with experience.
            (fielded.some((l) => labelField(l.heading.text) === "xpCost")
                ? steps.find((s) => s.boughtWithXp === true)
                : undefined);
        // Prose rules and prerequisites alone describe a step in general; a
        // rules block grants something, and its labels must read as grants.
        const grantLabels = fielded.some((l) => !PROSE_FIELDS.has(labelField(l.heading.text) ?? "changes"));
        // A price or prerequisite met twice ("Cost", "Prerequisites", "Cost",
        // …) lists many things — a table of advances — not one origin's grants.
        const priced = fielded
            .map((l) => labelField(l.heading.text))
            .filter((k) => k !== undefined && PRICE_FIELDS.has(k));
        const listing = new Set(priced).size < priced.length;
        if (step === undefined || fielded.length < MIN_GRANT_LABELS || !grantLabels || listing) {
            return;
        }
        // A step bought with experience may hold only its price and requirement.
        const read = grantsOf(fielded, (label) => childrenOf(entries, entries.indexOf(label)));
        if (!grantsAnything(read) && read.xpCost === undefined && read.requirements === undefined) {
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
            ...read,
        });
    });
    return out;
}
