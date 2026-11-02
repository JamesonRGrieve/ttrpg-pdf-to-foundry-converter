// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JsonObject, JsonValue } from "../types/entity.ts";
import type { Entry } from "./detect-entries.ts";
import { identifierFromName } from "./identifiers.ts";
import { caseLost, cleanName } from "./names.ts";
import { parseAvailability, parseAvailabilityByPlace, parseWeight } from "./notation.ts";
import { toHtml, type ItemType } from "./schema.ts";

/**
 * Catalogue entry → Foundry item. The type comes first from the entry's own
 * fields (a tier/aptitude block is a talent, a focus-power block a psychic
 * power, …) and otherwise from the nearest enclosing section heading that names
 * a schema type. Field labels and type words are the system's own vocabulary.
 */

/** The system's label for its `gift` mutation category ("Gift of the Gods"). */
const GIFT_LABEL = /\bgifts? of the gods\b/iu;

/**
 * A mutation's schema category from the nearest enclosing section naming one
 * by the system's category labels: a Gift of the Gods, or a major or minor
 * mutation. Null when none does (the schema's initial applies).
 */
export function mutationCategory(sections: readonly string[]): string | null {
    for (const section of [...sections].reverse()) {
        if (GIFT_LABEL.test(section)) {
            return "gift";
        }
        const size = /\b(major|minor)\b/iu.exec(section)?.[1];
        if (size !== undefined) {
            return size.toLowerCase();
        }
    }
    return null;
}

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
    [GIFT_LABEL, "mutation"],
    [/\bconditions?\b/iu, "condition"],
    [/\bcriticals?\b/iu, "criticalInjury"],
    [/\bcybernetics?\b/iu, "cybernetic"],
    [/\bforce fields?\b/iu, "forceField"],
    [/\bammunition\b|\bammo\b/iu, "ammunition"],
    [/\bweapons? (?:modifications?|upgrades?|customi[sz]ations?)\b/iu, "weaponModification"],
    [/\barmou?rs? (?:modifications?|upgrades?)\b/iu, "armourModification"],
    // "Weapon Qualities", "Weapon Special Qualities" (a text layer may drop the space).
    [/\bweapons?\s*(?:special\s*)?qualit(?:y|ies)\b/iu, "weaponQuality"],
    [/\borders\b/iu, "order"],
    // (a text layer may run the word before on: "Usingnavigator Powers")
    [/navigator\s*powers?\b/iu, "navigatorPower"],
    [/\bvehicle traits?\b/iu, "vehicleTrait"],
    [/\bmedals?\b/iu, "medal"],
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

/**
 * The field-less catalogue type a heading or caption names, if any. A word a
 * text layer ran on to one in capitals ("UNUSUALAmmo") is read apart.
 */
export function typeNamedBy(text: string): ItemType | null {
    const apart = text.replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, "$1 ");
    return SECTION_TYPES.find(([re]) => re.test(apart))?.[1] ?? null;
}
/** The kinds that identify themselves by field blocks (see SECTION_TYPES), by the word a section names them with. */
const FIELDED_KINDS: readonly [RegExp, ItemType][] = [
    [/\btalents?\b/iu, "talent"],
    [/\bskills?\b/iu, "skill"],
    [/\bpsychic powers?\b/iu, "psychicPower"],
];

/** A heading's closing parenthetical naming an action ("(Comrade Half Action)"). */
const ACTION_TAG = /\s*\(([^()]*\baction)\)\s*$/iu;

/** A section of actions ("Actions", "Starship Actions"). */
const ACTIONS = /^\s*(?:(?:star|void)?ship\s+)?actions\s*$/iu;
/** A section about ships (the schema's starship and voidcraft kinds). */
const SHIP = /\b(?:star|void)?ships?\b|\bvoidcraft\b/iu;

/**
 * The field-less type an entry takes from its nearest enclosing section that
 * names a catalogue kind. A nearest kind that is a fielded one (a "Talents"
 * section) gives none: its field-less headings are section furniture.
 */
function sectionType(sections: readonly string[]): { type: ItemType; section: string } | null {
    for (const [i, section] of [...sections.entries()].reverse()) {
        // A section naming a fielded kind ("Talents"), even beside a
        // field-less one ("Talents and Traits"), types none of its headings.
        if (FIELDED_KINDS.some(([re]) => re.test(section))) {
            return null;
        }
        const type = typeNamedBy(section);
        if (type !== null) {
            return { type, section };
        }
        // A ship's actions are the schema's orders (ship orders and commands).
        if (ACTIONS.test(section) && sections.slice(0, i).some((outer) => SHIP.test(outer))) {
            return { type: "order", section };
        }
    }
    return null;
}

const lastWord = (text: string): string =>
    text
        .trim()
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length > 0)
        .at(-1)
        ?.toLowerCase() ?? "";

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

/** Most words a name whose small capitals lost their case is read as a heading with. */
const MAX_CASE_LOST_WORDS = 3;

/** A heading that is only one of the schema's kind words. */
const KIND_WORD = /^(?:talents?|traits?|skills?|psychic powers?|weapons?|armou?rs?|gear)$/iu;

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
/** A price in experience: "250 xp". */
const XP_PRICE = /^\s*(?<xp>\d[\d,]*)\s*xp\b/iu;
/** A `Type:` field naming how an ability is used: "Passive", or the action it takes. */
const TAKES_ACTION = /^\s*(?:passive|(?:[\p{L}-]+\s+)?action)\s*\.?\s*$/iu;
/** A `Type:` field naming only an action: "Full Action", "Half Action". */
const ACTION_TYPE = /^\s*[\p{L}-]+\s+action\s*$/iu;

export function entryType(entry: Entry): ItemType | null {
    if (entry.listedAs !== undefined) {
        return entry.listedAs;
    }
    const fields = fieldMap(entry);
    // A creature's statblock lists its skills beside its talents or traits;
    // any power or ability fields beneath belong to rules inside it, not to
    // the entry (statblocks are read from their characteristic grids).
    if (has(fields, "skills") && has(fields, "talents", "traits")) {
        return null;
    }
    // A pact under a section of dark pacts (the schema's kind, by its label).
    if (/\bpact\b/iu.test(entry.heading.text) && entry.sections.some((s) => DARK_PACTS.test(s))) {
        return "darkPact";
    }
    // An oath, by its name, prints its effect under a section about oaths.
    if (
        /\boath\b/iu.test(entry.heading.text) &&
        has(fields, "effect") &&
        entry.sections.some((s) => /\boath/iu.test(s))
    ) {
        return "oath";
    }
    // A ritual prints its requirements and effects under a section of rituals.
    if (
        has(fields, "requirements") &&
        has(fields, "effects", "effect") &&
        entry.sections.some((s) => /\brituals?\b/iu.test(s))
    ) {
        return "ritual";
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
    if (has(fields, "focus power", "focus power test", "sustained", "sustain", "psychic power")) {
        // A heading naming a discipline, or a group of powers ("Psychic
        // Techniques"), introduces the format, not a power of its own.
        if (/\bdisciplines?\b|\b(?:techniques|powers)\s*$/iu.test(entry.heading.text)) {
            return null;
        }
        return "psychicPower";
    }
    if (has(fields, "tier")) {
        return "talent";
    }
    // An ability bought with experience: its price in xp, the action it
    // takes ("Passive", "Half Action") and its effect.
    if (
        XP_PRICE.test(fields.get("cost") ?? "") &&
        has(fields, "effect") &&
        TAKES_ACTION.test(fields.get("type") ?? "")
    ) {
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
    // A short name with no capitals at all, or with a capital inside a word
    // after lower case ("blAst", "PoweR"), is small capitals whose case was
    // lost too (a fragment of prose runs longer, or carries punctuation).
    const heading = entry.heading.text.trim();
    const shortName =
        /^[\p{L}\s()'’-]+$/u.test(heading) && heading.split(/\s+/u).length <= MAX_CASE_LOST_WORDS;
    const smallCapsLost =
        (fields.size > 0 && /\p{Lu}/u.test(heading) && caseLost(heading)) ||
        (shortName && (!/\p{Lu}/u.test(heading) || /\p{Ll}\p{Lu}/u.test(heading)));
    if (!/^[\p{Lu}\p{N}]/u.test(heading) && !smallCapsLost) {
        return null;
    }
    // A heading that is only a kind's name ("TALENT", "Skills") is furniture.
    if (KIND_WORD.test(heading)) {
        return null;
    }
    const typed = sectionType(entry.sections);
    if (typed === null) {
        return null;
    }
    const { type, section } = typed;
    // A heading naming a group of actions ("Extended Actions") heads part of
    // an orders section, as one naming its own kind does — or closing on the
    // plural its section closes on ("Initial Powers" under "… Powers").
    const groupNoun = lastWord(section);
    if (
        typeNamedBy(heading) === type ||
        (type === "order" && /\bactions\b/iu.test(heading)) ||
        (groupNoun.endsWith("s") && lastWord(heading) === groupNoun)
    ) {
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
export function structuredPrerequisites(printed: string): {
    prerequisites: JsonObject;
    psyRating: number | null;
} {
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
            // The line as printed, a "None" or dash for none included; only its gates are parsed.
            text,
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

/**
 * A section heading naming the psychic-power catalogue as a whole (a display
 * heading's initial may be doubled by the text layer: "PPsychic Disciplines").
 */
const POWER_CATALOGUE = /psychic (?:powers?|disciplines?)\b|\bdisciplines\b/iu;
/** A catalogue heading qualified by what its powers are ("Minor Psychic Powers"): itself a discipline. */
const QUALIFIED_CATALOGUE = /^\s*(?!the\b)\p{L}[\p{L}\s-]*\s+psychic\s+powers\s*$/iu;
/** A discipline heading closing on the kind of what it groups: "Lampcraft Powers". */
const GROUP_NOUN = /\s+powers\s*$/iu;

/**
 * A power's discipline as the book prints it (content#35): the heading of the
 * section it sits in directly beneath the section naming the psychic-power
 * catalogue (a heading deeper still groups some of that discipline's powers,
 * or is a diagram's caption). A power printed directly under that section, or outside one, has
 * none ("") rather than the schema's default, which would name a discipline
 * the book never gave it.
 */
export function printedDiscipline(sections: readonly string[]): string {
    const catalogue = sections.findLastIndex((s) => POWER_CATALOGUE.test(s));
    // Under no catalogue section (a display title set larger than the chapter's
    // heading has closed it), a section naming a discipline's powers
    // ("Lampcraft Powers") stands in for it: powers directly beneath it are
    // that discipline's, ones under a heading of its own are that heading's.
    const grouping = catalogue < 0 ? sections.findLastIndex((s) => GROUP_NOUN.test(s)) : -1;
    if (grouping >= 0 && grouping === sections.length - 1) {
        return cleanName(sections[grouping]?.replace(GROUP_NOUN, "") ?? "");
    }
    const anchor = Math.max(catalogue, grouping);
    const under = anchor < 0 ? [] : sections.slice(anchor + 1);
    // A section naming its discipline as such ("Lampcraft Discipline: Wick
    // Techniques") names it by the words before the word.
    const named = under
        .map((s) => /^\s*(?:the\s+)?(?<name>\S.*?)\s+discipline\b/iu.exec(s)?.groups?.["name"])
        .findLast((n) => n !== undefined);
    // A section naming its powers ("Lampcraft Powers") names the discipline by the words before.
    const qualified = sections.findLast((s) => QUALIFIED_CATALOGUE.test(s));
    const own = named ?? under.at(0)?.replace(GROUP_NOUN, "") ?? qualified;
    return own === undefined ? "" : cleanName(own);
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
    const opposedBy =
        /\bopposed by (?:the )?(?:target(?:['’]s)? |its |his |her |their )?([a-z]+(?: [a-z]+)?)/iu.exec(text);
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
        characteristic === null &&
        /\btests?\b/iu.test(text) &&
        only !== undefined &&
        /^\p{Lu}\p{Ll}+$/u.test(only)
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
                : (characteristicKey(opposedName) ??
                  characteristicKey(opposedName.split(" ")[0] ?? "") ??
                  ""),
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

/** The system's activation types (the activation template's `type` choices), longest name first. */
const ACTIVATION_TYPES = [
    "extended-action",
    "half-action",
    "full-action",
    "free-action",
    "reaction",
    "passive",
    "special",
    "action",
] as const;

/**
 * A power's printed action or focus time ("Half Action", "Full Action
 * (Sustained)", "Reaction") → the schema's activation type it starts with;
 * null when it names none ("2 Full Actions" names a count, not a type).
 */
export function activationType(printed: string): string | null {
    const text = printed
        .toLowerCase()
        .replace(/[^a-z]+/gu, " ")
        .trim();
    return ACTIVATION_TYPES.find((t) => `${text} `.startsWith(`${t.replace(/-/gu, " ")} `)) ?? null;
}

/**
 * The target a power's printed range implies: `self` for a range of "Self"
 * (or "You"), `area` for a radius; any other printed range leaves the target
 * to the power's text (`special`).
 */
export function targetType(range: string): string {
    if (/^\s*(?:self|you)\b/iu.test(range)) {
        return "self";
    }
    return /\bradius\b/iu.test(range) ? "area" : "special";
}

/**
 * A power's `activation` and `target` from its printed action (or focus time)
 * and range; a field neither names is left to the schema's initial value.
 */
export function powerActivation(action: string | undefined, range: string | undefined): JsonObject {
    const out: JsonObject = {};
    const type = action === undefined ? null : activationType(action);
    if (type !== null) {
        out["activation"] = { type };
    }
    if (range !== undefined && range.trim() !== "" && !/^[-–—]$/u.test(range.trim())) {
        out["target"] = { type: targetType(range) };
    }
    return out;
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

/** A section of dark pacts (the schema's `darkPact` kind by its label). */
const DARK_PACTS = /\bdark pacts?\b/iu;

/** Sub-headings naming a dark pact's schema lists, each field beneath one an entry of it. */
const PACT_GROUPS: Readonly<Record<string, "boons" | "banes">> = {
    boon: "boons",
    boons: "boons",
    bane: "banes",
    banes: "banes",
};

/**
 * A heading's sub-headings that name a dark pact's lists ("Boons", "Banes")
 * fold into it: each field beneath one joins the heading's fields labelled
 * with its list ("boons: Name").
 */
export function joinPactGroups(entries: readonly Entry[]): Entry[] {
    const out: Entry[] = [];
    for (const entry of entries) {
        const parent = out.at(-1);
        const group = PACT_GROUPS[entry.heading.text.trim().toLowerCase()];
        if (parent !== undefined && group !== undefined && entry.sections.at(-1) === parent.heading.text) {
            out[out.length - 1] = {
                ...parent,
                fields: [
                    ...parent.fields,
                    ...entry.fields.map(([label, value]): [string, string] => [`${group}: ${label}`, value]),
                ],
            };
            continue;
        }
        out.push(entry);
    }
    return out;
}

/** A talent's own field labels (the schema's): a talent entry, not a list of talents. */
const TALENT_FIELD_LABELS =
    /^(?:tier|aptitudes?|prerequisites?|benefits?|effects?|cost|type|alignment|specialisations?|specializations?)$/iu;
/** A run-in label that names something: capitalised words, some lower case, no figures. */
const NAMING_LABEL = /^\p{Lu}[\p{L}'’\s-]*$/u;
/** Fewest named `Name: rules` lines that make a heading a list of what it names. */
const MIN_LISTED = 2;

/**
 * A heading closing on the plural of the talent kind ("… Faith Talents") over
 * nothing but run-in `Name: rules` lines lists talents: each line is a talent
 * of its own, its rules its text, read out after the heading (which keeps its
 * introduction). Labels that are a talent's own fields, set in capitals
 * (a table's header) or opening on a creation step ("Starting …") are no list.
 */
export function splitTalentLists(entries: readonly Entry[]): Entry[] {
    return entries.flatMap((entry) => {
        const labels = entry.fields.map(([label]) => label.trim());
        const lists =
            lastWord(entry.heading.text) === "talents" &&
            labels.length >= MIN_LISTED &&
            labels.every(
                (label) =>
                    NAMING_LABEL.test(label) &&
                    /\p{Ll}/u.test(label) &&
                    !TALENT_FIELD_LABELS.test(label) &&
                    !/^starting\b/iu.test(label),
            );
        if (!lists) {
            return [entry];
        }
        const listed = entry.fields.map(([label, value]): Entry => ({
            heading: { ...entry.heading, text: label.trim() },
            sections: [...entry.sections, entry.heading.text],
            fields: [],
            body: value,
            listedAs: "talent",
        }));
        return [{ ...entry, fields: [] }, ...listed];
    });
}

/** The schema's medal honour types, matched in the medal's sections ("Campaign Honours"). */
const MEDAL_HONOURS = ["imperial", "campaign", "regimental"] as const;

/** A skill's own field labels (the schema's): never one of its specialisations. */
const SKILL_FIELD_LABELS =
    /^(?:aptitudes?|skill use|use time|characteristic|special(?:isations?|izations?)|uses?|special uses?)$/iu;
/** Fewest named fields after a skill's own that make it a specialist skill listing its specialisations. */
const MIN_SPECIALISATIONS = 3;

/**
 * A specialist skill prints each of its specialisations as a labelled field
 * of its own ("Name: what it covers"); its labels, in book order, when it
 * prints at least a few (a stray label — a sidebar's numeral — is none).
 */
export function skillSpecialisations(fields: readonly (readonly [string, string])[]): string[] {
    const named = fields
        .map(([label]) => label.trim())
        .filter(
            (label) =>
                !SKILL_FIELD_LABELS.test(label) && /^\p{L}[\p{L}\s'’-]*$/u.test(label) && !ROMAN.test(label),
        );
    return named.length >= MIN_SPECIALISATIONS ? named : [];
}

/** A Roman numeral (a sidebar's or chapter's number), not a name. */
const ROMAN = /^[IVXLC]+$/u;

/** Build the item body for a typed entry. */
export function entryItem(entry: Entry, type: ItemType): EntryItem {
    const fields = fieldMap(entry);
    const skillType = skillTypeTag(entry.heading.text);
    const { name: headingName, characteristic: headed } = splitCharacteristic(
        withoutKindTag(entry.heading.text).replace(SKILL_TYPE_TAG, ""),
    );
    // An order's heading may close on the action it takes: "Volley (Comrade Half Action)".
    const actionTag = type === "order" ? ACTION_TAG.exec(headingName) : null;
    const name = actionTag === null ? headingName : headingName.slice(0, actionTag.index);
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
            // An ability bought with experience prints its price and its effect.
            const price = XP_PRICE.exec(text("cost") ?? "")?.groups?.["xp"];
            if (price !== undefined) {
                system["cost"] = Number(price.replace(/,/gu, ""));
            }
            const effect = text("effect");
            system["benefit"] = effect === undefined ? html : toHtml(effect);
            const use = text("type");
            if (use !== undefined && TAKES_ACTION.test(use)) {
                system["isPassive"] = /^\s*passive/iu.test(use);
            }
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
            system["discipline"] = printedDiscipline(entry.sections);
            const focus = text("focus power") ?? text("focus power test");
            const threshold = text("threshold");
            if (focus !== undefined || threshold !== undefined) {
                system["focusPower"] = focusPowerTest(focus, threshold);
            }
            for (const [label, field] of [
                ["range", "range"],
                ["subtype", "subtype"],
            ] as const) {
                const value = text(label);
                if (value !== undefined && system[field] === undefined) {
                    system[field] = value;
                }
            }
            Object.assign(system, powerActivation(text("action") ?? text("focus time"), text("range")));
            const sustained = text("sustained") ?? text("sustain");
            if (sustained !== undefined) {
                system["sustained"] = isSustained(sustained);
            }
            const cost = powerXpCost(fields);
            if (cost !== null) {
                system["cost"] = cost;
            }
            // A power printing no `Effect` field states its effect as its text.
            const effect = text("effect");
            variantized["effect"] = effect === undefined ? html : toHtml(effect);
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
            // The time a use of the skill takes: "Skill Use: Full Action."
            const useTime = text("skill use") ?? text("use time");
            if (useTime !== undefined) {
                system["useTime"] = useTime.replace(/\.\s*$/u, "").trim();
            }
            const specialisations = skillSpecialisations(entry.fields);
            if (specialisations.length > 0) {
                system["specialist"] = true;
                system["specializations"] = specialisations;
            }
            variantized["uses"] = entry.body;
            break;
        }
        case "trait":
            system["benefit"] = html;
            break;
        case "oath": {
            const requirement = text("prerequisite") ?? text("prerequisites") ?? text("requirement");
            if (requirement !== undefined) {
                system["requirement"] = toHtml(requirement);
            }
            variantized["effect"] = toHtml(text("effect") ?? "");
            break;
        }
        case "ritual": {
            for (const [labels, key] of [
                [["requirements"], "requirements"],
                [["effects", "effect"], "effect"],
                [["cost", "costs"], "costs"],
                [["the price of failure", "failure"], "failure"],
            ] as const) {
                const value = labels.map((l) => text(l)).find((v) => v !== undefined);
                if (value !== undefined) {
                    system[key] = toHtml(value);
                }
            }
            break;
        }
        case "darkPact": {
            // Its boons and banes, each a named entry of the schema's lists.
            for (const list of ["boons", "banes"] as const) {
                const items = entry.fields.flatMap(([label, value]) => {
                    const named = new RegExp(`^${list}:\\s*(.+)$`, "iu").exec(label)?.[1]?.trim();
                    return named === undefined
                        ? []
                        : [
                              {
                                  identifier: identifierFromName(named),
                                  name: named,
                                  description: toHtml(value),
                                  modifiers: {},
                                  grants: [],
                              },
                          ];
                });
                if (items.length > 0) {
                    system[list] = items;
                }
            }
            break;
        }
        case "medal": {
            // What it is awarded for and the bonus its squad gains, as printed.
            for (const [label, key] of [
                ["awarded for", "awardedFor"],
                ["squad bonus", "squadBonus"],
            ] as const) {
                const value = text(label);
                if (value !== undefined) {
                    system[key] = toHtml(value);
                }
            }
            const honour = MEDAL_HONOURS.find((h) =>
                entry.sections.some((s) => new RegExp(`\\b${h}\\b`, "iu").test(s)),
            );
            if (honour !== undefined) {
                system["honourType"] = honour;
            }
            break;
        }
        case "navigatorPower": {
            // Each mastery level's effect is printed under its level's name.
            const levels: JsonObject = {};
            for (const level of ["novice", "adept", "master"]) {
                const effect = text(level);
                if (effect !== undefined) {
                    levels[level] = { effect: toHtml(effect) };
                }
            }
            if (Object.keys(levels).length > 0) {
                system["levels"] = levels;
            }
            const sustain = text("sustain") ?? text("sustained");
            if (sustain !== undefined) {
                system["sustain"] = toHtml(sustain);
            }
            break;
        }
        case "weaponQuality":
        case "vehicleTrait":
            // A quality or trait printed with a rating placeholder ("Blast (X)") takes a level.
            system["hasLevel"] = /\(\s*x\s*\)/iu.test(name);
            variantized["effect"] = toHtml(text("effect") ?? entry.body);
            break;
        case "mutation": {
            const category = mutationCategory(entry.sections);
            if (category !== null) {
                system["category"] = category;
            }
            // A field labelled by a Chaos alignment is that power's rider.
            const riders = entry.fields.flatMap(([label, value]) => {
                const alignment = PREREQUISITE_ALIGNMENTS.find((a) => a === label.trim().toLowerCase());
                return alignment === undefined ? [] : [{ alignment, description: toHtml(value) }];
            });
            if (riders.length > 0) {
                system["gift"] = { riders };
            }
            variantized["effect"] = toHtml(text("effect") ?? entry.body);
            break;
        }
        case "order": {
            // The printed kind and action ("Sweeping Order (Free Action)"),
            // qualified by an `Order:` line when the kind is printed apart.
            system["notes"] = [text("order"), text("type")].filter((v) => v !== undefined).join(" ");
            if (actionTag?.[1] !== undefined) {
                system["typeAndAction"] = actionTag[1].trim();
            }
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
    // A "Description:" field opens the description (a medal's look).
    const printed = type === "medal" ? text("description") : undefined;
    const description = printed === undefined ? html : toHtml([printed, entry.body].join("\n\n"));
    return { type, name: cleanName(name), description, system, variantized };
}
