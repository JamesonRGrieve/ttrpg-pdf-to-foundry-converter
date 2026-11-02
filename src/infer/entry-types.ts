// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import type { Entry } from "./detect-entries.ts";
import { caseLost, cleanName } from "./names.ts";
import { parseAvailability, parseAvailabilityByPlace, parseWeight } from "./notation.ts";
import { toHtml, type ItemType } from "./schema.ts";

/**
 * Catalogue entry → Foundry item. The type comes first from the entry's own
 * fields (a tier/aptitude block is a talent, a focus-power block a psychic
 * power, …) and otherwise from the nearest enclosing section heading that names
 * a schema type. Field labels and type words are the system's own vocabulary.
 */

/**
 * Section-heading words → the item type catalogued beneath. Only for kinds
 * printed WITHOUT a field block; talents, skills and psychic powers identify
 * themselves by their fields, and typing them by section would sweep in the
 * section's other headings.
 */
const SECTION_TYPES: readonly [RegExp, ItemType][] = [
    [/\bmental disorders?\b|\bdisorders?\b/iu, "mentalDisorder"],
    [/\bmalignanc(?:y|ies)\b/iu, "malignancy"],
    [/\bmutations?\b/iu, "mutation"],
    [/\bconditions?\b/iu, "condition"],
    [/\bcriticals?\b/iu, "criticalInjury"],
    [/\bcybernetics?\b/iu, "cybernetic"],
    [/\bforce fields?\b/iu, "forceField"],
    [/\bammunition\b|\bammo\b/iu, "ammunition"],
    [/\bweapons? (?:modifications?|upgrades?|customi[sz]ations?)\b/iu, "weaponModification"],
    [/\barmou?rs? (?:modifications?|upgrades?)\b/iu, "armourModification"],
    [/\btraits?\b/iu, "trait"],
];

/**
 * A kind a heading tags itself with: "NAME (TALENT)", "NAME (UNIQUE PSY
 * POWER)". Singular only, and never a bare "power" — "Resistance (Psychic
 * Powers)" and "Weapon Training (Power)" name what a talent covers.
 */
const KIND_TAG = /\s*\((?:[^()]*\s)?(talent|trait|psychic power|psy power)\)\s*$/iu;
/** The same, leading the name: "TALENT: NAME", "NEW TALENT: NAME". */
const KIND_PREFIX = /^(?:\p{L}+\s+)?(talent|trait|psychic power|psy power)\s*:\s*(?=\S)/iu;
const TAGGED_KINDS: Readonly<Record<string, ItemType>> = {
    talent: "talent",
    trait: "trait",
    "psychic power": "psychicPower",
    "psy power": "psychicPower",
};

/** The kind a heading's tag names, if it carries one. */
export function headingKindTag(heading: string): ItemType | null {
    const word = (KIND_TAG.exec(heading) ?? KIND_PREFIX.exec(heading.trim()))?.[1]?.toLowerCase();
    return word === undefined ? null : (TAGGED_KINDS[word] ?? null);
}

/** A heading without its kind tag. */
export function withoutKindTag(heading: string): string {
    return heading.replace(KIND_TAG, "").trim().replace(KIND_PREFIX, "");
}

/**
 * A skill heading tagged with its schema skill type and any descriptors:
 * "ACROBATICS (ADVANCED, MOVEMENT)", "CAROUSE (BASIC)".
 */
const SKILL_TYPE_TAG = /\s*\(\s*(basic|advanced)\b[^()]*\)\s*$/iu;

/** The schema skill type a heading tags itself with, if any. */
export function skillTypeTag(heading: string): "basic" | "advanced" | null {
    const word = SKILL_TYPE_TAG.exec(heading)?.[1]?.toLowerCase();
    return word === "basic" || word === "advanced" ? word : null;
}

/** Label of the field a skill's characteristic is carried in when printed as its own heading. */
const CHARACTERISTIC_FIELD = "Characteristic";

/**
 * Skills whose characteristic is printed as a heading of its own directly
 * under the skill's ("ACROBATICS (ADVANCED, MOVEMENT)" then "Agility"): the
 * characteristic heading carries the skill's prose and fields, so the two
 * read as one entry, the characteristic kept as a field.
 */
export function joinSkillCharacteristics(entries: readonly Entry[]): Entry[] {
    const out: Entry[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const next = entries[i + 1];
        if (entry === undefined) {
            continue;
        }
        const characteristic = next?.heading.text.trim().toLowerCase() ?? "";
        if (
            next !== undefined &&
            skillTypeTag(entry.heading.text) !== null &&
            CHARACTERISTICS[characteristic] !== undefined
        ) {
            out.push({
                ...entry,
                fields: [[CHARACTERISTIC_FIELD, next.heading.text.trim()], ...entry.fields, ...next.fields],
                body: [entry.body, next.body].filter((b) => b.length > 0).join("\n\n"),
            });
            i += 1;
            continue;
        }
        out.push(entry);
    }
    return out;
}

/** Characteristic names and abbreviations as printed → the schema's characteristic keys. */
export const CHARACTERISTICS: Readonly<Record<string, string>> = {
    "weapon skill": "weaponSkill",
    ws: "weaponSkill",
    "ballistic skill": "ballisticSkill",
    bs: "ballisticSkill",
    strength: "strength",
    s: "strength",
    toughness: "toughness",
    t: "toughness",
    agility: "agility",
    ag: "agility",
    intelligence: "intelligence",
    int: "intelligence",
    perception: "perception",
    per: "perception",
    willpower: "willpower",
    wp: "willpower",
    fellowship: "fellowship",
    fel: "fellowship",
    influence: "influence",
    ifl: "influence",
};

const fieldKey = (label: string): string =>
    label
        .toLowerCase()
        .replace(/[^a-z]+/gu, " ")
        .trim();

function fieldMap(entry: Entry): Map<string, string> {
    const m = new Map<string, string>();
    for (const [label, value] of entry.fields) {
        const key = fieldKey(label);
        if (!m.has(key)) {
            m.set(key, value);
        }
    }
    return m;
}

function has(fields: Map<string, string>, ...keys: string[]): boolean {
    return keys.some((k) => fields.has(k));
}

/** `Name (Characteristic)` → name + the schema characteristic key, when it is one. */
function splitCharacteristic(heading: string): { name: string; characteristic: string | null } {
    const groups = /^(?<name>.*?)\s*\((?<inner>[^)]+)\)\s*$/u.exec(heading)?.groups;
    const name = groups?.["name"];
    const key = CHARACTERISTICS[groups?.["inner"]?.trim().toLowerCase() ?? ""];
    return name === undefined || key === undefined
        ? { name: heading, characteristic: null }
        : { name, characteristic: key };
}

/** The field-less catalogue type a heading or caption names, if any. */
export function typeNamedBy(text: string): ItemType | null {
    return SECTION_TYPES.find(([re]) => re.test(text))?.[1] ?? null;
}

/** The kinds that identify themselves by field blocks (see SECTION_TYPES), by the word a section names them with. */
const FIELDED_KINDS: readonly [RegExp, ItemType][] = [
    [/\btalents?\b/iu, "talent"],
    [/\bskills?\b/iu, "skill"],
    [/\bpsychic powers?\b/iu, "psychicPower"],
];

/**
 * The field-less type an entry takes from its nearest enclosing section that
 * names a catalogue kind. A nearest kind that is a fielded one (a "Talents"
 * section) gives none: its field-less headings are section furniture.
 */
function sectionType(sections: readonly string[]): ItemType | null {
    for (const section of [...sections].reverse()) {
        const type = typeNamedBy(section);
        if (type !== null) {
            return type;
        }
        if (FIELDED_KINDS.some(([re]) => re.test(section))) {
            return null;
        }
    }
    return null;
}

/**
 * The fielded kind an entry's own text refers to itself as ("… each time the
 * character uses this Talent"), when it names exactly one.
 */
function selfNamedKind(entry: Entry): ItemType | null {
    const text = [entry.body, ...entry.fields.map(([, value]) => value)].join(" ");
    const kinds = new Set(SELF_REFERENCES.filter(([re]) => re.test(text)).map(([, kind]) => kind));
    return kinds.size === 1 ? ([...kinds][0] ?? null) : null;
}

/** How an entry of a fielded kind refers to itself in its own text. */
const SELF_REFERENCES: readonly [RegExp, ItemType][] = [
    [/\bthis talent\b/iu, "talent"],
    [/\bthis skill\b/iu, "skill"],
    [/\bthis (?:psychic )?power\b/iu, "psychicPower"],
    [/\bthis order\b/iu, "order"],
];

/** The fielded kind the nearest enclosing section naming any catalogue kind names, if fielded. */
function fieldedSectionKind(sections: readonly string[]): ItemType | null {
    for (const section of [...sections].reverse()) {
        const fielded = FIELDED_KINDS.find(([re]) => re.test(section))?.[1];
        if (fielded !== undefined) {
            return fielded;
        }
        if (typeNamedBy(section) !== null) {
            return null;
        }
    }
    return null;
}

/**
 * A `Type:` field that opens by naming the schema's order kind, at most one
 * qualifying word first: "Sweeping Order (Free Action)", "Order (Half
 * Action)" — not prose that runs on into the field ("… in order").
 */
const ORDER_TYPE = /^\s*(?:[\p{L}-]+\s+)?order\b/iu;
/** A `Type:` field naming only an action: "Full Action", "Half Action". */
const ACTION_TYPE = /^\s*[\p{L}-]+\s+action\s*$/iu;

export function entryType(entry: Entry): ItemType | null {
    const fields = fieldMap(entry);
    // A creature's statblock lists its skills beside its talents or traits;
    // any power or ability fields beneath belong to rules inside it, not to
    // the entry (statblocks are read from their characteristic grids).
    if (has(fields, "skills") && has(fields, "talents", "traits")) {
        return null;
    }
    const tagged = headingKindTag(entry.heading.text);
    if (tagged !== null) {
        return tagged;
    }
    // An order printed with only its action as its type ("Type: Full Action")
    // names itself in its own text ("… to issue this Order").
    const printedType = fields.get("type") ?? "";
    if (ORDER_TYPE.test(printedType) || (ACTION_TYPE.test(printedType) && selfNamedKind(entry) === "order")) {
        return "order";
    }
    if (skillTypeTag(entry.heading.text) !== null) {
        return "skill";
    }
    if (has(fields, "focus power", "sustained", "sustain", "psychic power")) {
        return "psychicPower";
    }
    if (has(fields, "tier")) {
        return "talent";
    }
    // A talent printed with its prerequisites but no tier, under a Talents
    // section — or under any section, when its own text calls it "this Talent".
    if (
        has(fields, "prerequisite", "prerequisites") &&
        (fieldedSectionKind(entry.sections) === "talent" || selfNamedKind(entry) === "talent")
    ) {
        return "talent";
    }
    if (
        splitCharacteristic(entry.heading.text).characteristic !== null &&
        has(fields, "aptitude", "aptitudes")
    ) {
        return "skill";
    }
    // A name starts like a name (unless its small capitals lost their case,
    // keeping some capitals, and a field block follows: "truesilver FILIGREE"),
    // and a heading that names the very kind it sits under ("Traits",
    // "Acquiring Traits") heads part of that section rather than being one of
    // its entries.
    const heading = entry.heading.text.trim();
    const smallCapsLost = fields.size > 0 && /\p{Lu}/u.test(heading) && caseLost(heading);
    if (!/^[\p{Lu}\p{N}]/u.test(heading) && !smallCapsLost) {
        return null;
    }
    const type = sectionType(entry.sections);
    if (type === null || typeNamedBy(heading) === type) {
        return null;
    }
    return MODIFICATION_TYPES.has(type) ? (modificationFor(fields) ?? type) : type;
}

const MODIFICATION_TYPES: ReadonlySet<ItemType> = new Set(["weaponModification", "armourModification"]);

/**
 * What an upgrade fits, from its `Used With:` line: a section may list armour
 * and weapon upgrades together, and each entry says which it is.
 */
function modificationFor(fields: ReadonlyMap<string, string>): ItemType | null {
    const usedWith = fields.get("used with");
    if (usedWith === undefined) {
        return null;
    }
    if (/\barmou?r\b/iu.test(usedWith)) {
        return "armourModification";
    }
    return /\b(?:weapons?|ammunition|ammo)\b/iu.test(usedWith) ? "weaponModification" : null;
}

/** Characteristic names a prerequisite may print, longest first (single letters are too ambiguous in prose). */
const PREREQUISITE_CHARACTERISTICS = Object.keys(CHARACTERISTICS)
    .filter((name) => name.length > 1)
    .sort((a, b) => b.length - a.length);

/** The actor stats a prerequisite may set a minimum on (the schema's threshold keys). */
const PREREQUISITE_THRESHOLDS = ["corruption", "infamy", "insanity", "rank"] as const;

/** The Chaos alignments a prerequisite may require (the schema's alignment choices). */
const PREREQUISITE_ALIGNMENTS = ["khorne", "nurgle", "slaanesh", "tzeentch"] as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A printed Prerequisite line as the schema's structured prerequisites
 * (`{text, characteristics, skills, talents, talentsAny, alignment,
 * thresholds}`), plus the Psy Rating it names. Only gates the schema keys by
 * its own vocabulary are read — characteristic minimums ("Willpower 40",
 * "WP 50+"), stat thresholds ("Corruption 30+", "5+ Insanity points",
 * "Rank 3") and a Chaos alignment ("Aligned Nurgle"). Skills and talents are
 * names from the book, so they stay in `text` for the reader.
 */
export function structuredPrerequisites(printed: string): { prerequisites: JsonObject; psyRating: number | null } {
    const text = printed.replace(/\.\s*$/u, "").trim();
    const shown = /^(?:none|[-–—])?$/iu.test(text) ? "" : text;
    // Each gate is one listed part; a part offering an alternative ("… or 20+
    // Insanity") is a condition the shape cannot hold, so it stays text.
    const parts = shown
        .split(/[,;\n]|\band\b/iu)
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !/\bor\b/iu.test(p));
    const characteristics: JsonObject = {};
    const thresholds: JsonObject = {};
    let alignment = "";
    let psyRating: number | null = null;
    for (const part of parts) {
        for (const name of PREREQUISITE_CHARACTERISTICS) {
            const m = new RegExp(`^${escapeRe(name)}\\s*(?:of\\s*)?(\\d{2,3})\\s*\\+?$`, "iu").exec(part);
            const key = CHARACTERISTICS[name];
            if (m !== null && key !== undefined && characteristics[key] === undefined) {
                characteristics[key] = Number(m[1]);
            }
        }
        for (const stat of PREREQUISITE_THRESHOLDS) {
            // "Corruption 30+", "10 Corruption points", "5+ Insanity points", "Rank 3".
            const m =
                new RegExp(`^${stat}(?:\\s+points?)?\\s*(?:of\\s*)?(\\d+)\\s*\\+?$`, "iu").exec(part) ??
                new RegExp(`^(\\d+)\\s*\\+?\\s*${stat}(?:\\s+points?)?$`, "iu").exec(part);
            if (m !== null && thresholds[stat] === undefined) {
                thresholds[stat] = Number(m[1]);
            }
        }
        const aligned = new RegExp(
            `^aligned\\s+(?:to\\s+|with\\s+)?(${PREREQUISITE_ALIGNMENTS.join("|")})$`,
            "iu",
        ).exec(part);
        if (aligned?.[1] !== undefined) {
            alignment = aligned[1].toLowerCase();
        } else if (/^unaligned$/iu.test(part)) {
            alignment = "unaligned";
        }
        const psy = /^psy(?:chic)?\s+rating\s*(?:of\s*)?(\d+)\s*\+?$/iu.exec(part)?.[1];
        if (psy !== undefined) {
            psyRating = Number(psy);
        }
    }
    return {
        prerequisites: {
            text: shown,
            characteristics,
            skills: [],
            talents: [],
            talentsAny: [],
            alignment,
            thresholds,
        },
        psyRating,
    };
}

/** A characteristic key from a printed name or abbreviation, or null. */
function characteristicKey(name: string): string | null {
    return CHARACTERISTICS[name.toLowerCase().replace(/\s+/gu, " ").trim()] ?? null;
}

/**
 * A printed Focus Power test as the schema's `focusPower` (a SchemaField, not
 * text): the characteristic tested — or the skill, as its key, when a skill
 * is named instead — the printed modifier in brackets ("(–10)"), whether the
 * test is opposed and by what ("opposed by the target's Toughness"), and the
 * threshold a line prints apart ("Threshold: 8").
 */
export function focusPowerTest(printed: string | undefined, threshold: string | undefined): JsonObject {
    const text = (printed ?? "").replace(/\s+/gu, " ").trim();
    const modifier = /\(\s*([+\-−–—]?)\s*(\d+)\s*\)/u.exec(text);
    const sign = modifier?.[1] !== undefined && modifier[1] !== "" && modifier[1] !== "+" ? -1 : 1;
    const opposedBy = /\bopposed by (?:the )?(?:target(?:['’]s)? |its |his |her |their )?([a-z]+(?: [a-z]+)?)/iu.exec(
        text,
    );
    // The tested name: what precedes "test" — past a bracketed modifier, which
    // follows any difficulty word — or the whole value when it names no test.
    const phrase =
        /\)\s*([\p{L}][\p{L} ]*?)\s+tests?\b/iu.exec(text)?.[1] ??
        /([\p{L}][\p{L} ]*?)\s+tests?\b/iu.exec(text)?.[1] ??
        text;
    const tested = phrase
        .replace(/^opposed\s+/iu, "")
        .split(" ")
        .filter((w) => w.length > 0);
    let characteristic: string | null = null;
    // The longest trailing run of words naming a characteristic ("Weapon Skill", "Willpower").
    for (let i = 0; i < tested.length && characteristic === null; i++) {
        characteristic = characteristicKey(tested.slice(i).join(" "));
    }
    // A single other word tested is a skill, keyed as the schema keys skills
    // (its name, lower camel case). A longer name may carry a difficulty word
    // the engine cannot tell from the skill's own, so it is left unset.
    const only = tested.length === 1 ? tested[0] : undefined;
    const skill =
        characteristic === null && /\btests?\b/iu.test(text) && only !== undefined && /^\p{Lu}\p{Ll}+$/u.test(only)
            ? only.toLowerCase()
            : "";
    const thresholdValue = threshold === undefined ? null : /\d+/u.exec(threshold)?.[0];
    const opposedName = opposedBy?.[1];
    return {
        characteristic: characteristic ?? "willpower",
        modifier: modifier === null ? 0 : sign * Number(modifier[2]),
        threshold: thresholdValue === null || thresholdValue === undefined ? null : Number(thresholdValue),
        opposed: /\bopposed\b/iu.test(text),
        opposedCharacteristic:
            opposedName === undefined
                ? ""
                : (characteristicKey(opposedName) ?? characteristicKey(opposedName.split(" ")[0] ?? "") ?? ""),
        skill,
    };
}

/**
 * Whether a printed Sustained value says the power can be sustained (the
 * schema's `sustained` is a boolean): "No" or a dash says it cannot; "Yes" or
 * the action it costs to sustain ("Free Action") says it can.
 */
export function isSustained(printed: string): boolean {
    return !/^\s*(?:no|none|n\/a|[-–—])?\s*\.?\s*$/iu.test(printed);
}

/**
 * The experience a power costs as printed: a `Value` or `Cost` line naming xp
 * ("300 xp"), or a bare number under a label that names xp ("XP Cost: 400").
 * Null when the entry prints none.
 */
export function powerXpCost(fields: ReadonlyMap<string, string>): number | null {
    const number = (value: string): number | null => {
        const digits = /\d[\d,]*/u.exec(value)?.[0];
        return digits === undefined ? null : Number(digits.replace(/,/gu, ""));
    };
    for (const [label, value] of fields) {
        if (/\bxp\b|\bexperience\b/iu.test(label) && /\b(?:cost|value)\b/iu.test(label)) {
            return number(value);
        }
        if (/^(?:value|cost)$/u.test(label) && /\d\s*xp\b/iu.test(value)) {
            return number(value);
        }
    }
    return null;
}

export interface EntryItem {
    type: ItemType;
    name: string;
    description: string;
    system: JsonObject;
    variantized: Record<string, JsonValue>;
}

const splitList = (s: string): string[] =>
    s
        .split(/,/u)
        .map((x) => x.trim())
        .filter((x) => x.length > 0);

/** Build the item body for a typed entry. */
export function entryItem(entry: Entry, type: ItemType): EntryItem {
    const fields = fieldMap(entry);
    const skillType = skillTypeTag(entry.heading.text);
    const { name, characteristic: headed } = splitCharacteristic(
        withoutKindTag(entry.heading.text).replace(SKILL_TYPE_TAG, ""),
    );
    const printedCharacteristic = fields.get(fieldKey(CHARACTERISTIC_FIELD))?.toLowerCase() ?? "";
    const characteristic = headed ?? CHARACTERISTICS[printedCharacteristic] ?? null;
    const html = toHtml(entry.body);
    const system: JsonObject = {};
    const variantized: Record<string, JsonValue> = {};
    const text = (key: string): string | undefined => fields.get(key);

    switch (type) {
        case "talent": {
            const tier = /\d/u.exec(text("tier") ?? "");
            if (tier !== null) {
                system["tier"] = Number(tier[0]);
            }
            // A line whose talents carry an alignment instead of aptitudes
            // keeps it where aptitudes go.
            system["aptitudes"] = splitList(text("aptitudes") ?? text("aptitude") ?? text("alignment") ?? "");
            // A closing full stop ends the printed sentence; it is not part of the value.
            system["prerequisites"] = structuredPrerequisites(
                text("prerequisites") ?? text("prerequisite") ?? "",
            ).prerequisites;
            system["benefit"] = html;
            break;
        }
        case "psychicPower": {
            const printedPrerequisites = text("prerequisites") ?? text("prerequisite");
            if (printedPrerequisites !== undefined) {
                const { prerequisites, psyRating } = structuredPrerequisites(printedPrerequisites);
                system["prerequisites"] = prerequisites;
                if (psyRating !== null) {
                    system["prCost"] = psyRating;
                }
            }
            const focus = text("focus power") ?? text("focus power test");
            const threshold = text("threshold");
            if (focus !== undefined || threshold !== undefined) {
                system["focusPower"] = focusPowerTest(focus, threshold);
            }
            for (const [label, field] of [
                ["action", "action"],
                ["range", "range"],
                ["subtype", "subtype"],
            ] as const) {
                const value = text(label);
                if (value !== undefined && system[field] === undefined) {
                    system[field] = value;
                }
            }
            const sustained = text("sustained") ?? text("sustain");
            if (sustained !== undefined) {
                system["sustained"] = isSustained(sustained);
            }
            const cost = powerXpCost(fields);
            if (cost !== null) {
                system["cost"] = cost;
            }
            const effect = text("effect");
            if (effect !== undefined) {
                variantized["effect"] = toHtml(effect);
            }
            break;
        }
        case "skill": {
            if (characteristic !== null) {
                system["characteristic"] = characteristic;
            }
            if (skillType !== null) {
                system["skillType"] = skillType;
                system["isBasic"] = skillType === "basic";
            }
            system["aptitudes"] = splitList(text("aptitudes") ?? text("aptitude") ?? "");
            variantized["uses"] = entry.body;
            break;
        }
        case "trait":
            system["benefit"] = html;
            break;
        case "order": {
            // The printed kind and action ("Sweeping Order (Free Action)"),
            // qualified by an `Order:` line when the kind is printed apart.
            system["notes"] = [text("order"), text("type")].filter((v) => v !== undefined).join(" ");
            const requirements = [text("prerequisites") ?? text("prerequisite"), text("cost")].filter(
                (v): v is string => v !== undefined,
            );
            system["requirements"] = toHtml(requirements.join("\n\n"));
            variantized["effect"] = toHtml([text("effect") ?? "", entry.body].join("\n\n"));
            break;
        }
        default: {
            const weight = text("weight") ?? text("wt");
            const parsedWeight = weight === undefined ? null : parseWeight(weight);
            if (parsedWeight !== null) {
                system["weight"] = parsedWeight;
            }
            const availability = text("availability");
            const placed = availability === undefined ? null : parseAvailabilityByPlace(availability);
            const parsedAvailability =
                placed?.general ?? (availability === undefined ? null : parseAvailability(availability));
            if (parsedAvailability !== null) {
                system["availability"] = parsedAvailability;
            }
            if (placed !== null) {
                system["availabilityByPlace"] = placed.byPlace;
            }
            const effect = text("effect");
            variantized["effect"] = effect === undefined ? html : toHtml(effect);
        }
    }
    return { type, name: cleanName(name), description: html, system, variantized };
}
