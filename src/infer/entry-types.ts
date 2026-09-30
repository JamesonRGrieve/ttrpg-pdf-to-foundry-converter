// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import type { Entry } from "./detect-entries.ts";
import { caseLost, cleanName } from "./names.ts";
import { parseAvailability, parseWeight } from "./notation.ts";
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
    const { name, characteristic } = splitCharacteristic(withoutKindTag(entry.heading.text));
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
            system["aptitudes"] = splitList(text("aptitudes") ?? text("aptitude") ?? "");
            // A closing full stop ends the printed sentence; it is not part of the value.
            system["prerequisites"] = {
                text: (text("prerequisites") ?? text("prerequisite") ?? "").replace(/\.\s*$/u, ""),
            };
            system["benefit"] = html;
            break;
        }
        case "psychicPower": {
            for (const [label, field] of [
                ["prerequisites", "prerequisites"],
                ["prerequisite", "prerequisites"],
                ["action", "action"],
                ["focus power", "focusPower"],
                ["range", "range"],
                ["sustained", "sustained"],
                ["sustain", "sustained"],
                ["subtype", "subtype"],
            ] as const) {
                const value = text(label);
                if (value !== undefined && system[field] === undefined) {
                    system[field] = value;
                }
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
            system["aptitudes"] = splitList(text("aptitudes") ?? text("aptitude") ?? "");
            variantized["uses"] = entry.body;
            break;
        }
        case "trait":
            system["benefit"] = html;
            break;
        default: {
            const weight = text("weight") ?? text("wt");
            const parsedWeight = weight === undefined ? null : parseWeight(weight);
            if (parsedWeight !== null) {
                system["weight"] = parsedWeight;
            }
            const availability = text("availability");
            const parsedAvailability = availability === undefined ? null : parseAvailability(availability);
            if (parsedAvailability !== null) {
                system["availability"] = parsedAvailability;
            }
            const effect = text("effect");
            variantized["effect"] = effect === undefined ? html : toHtml(effect);
        }
    }
    return { type, name: cleanName(name), description: html, system, variantized };
}
