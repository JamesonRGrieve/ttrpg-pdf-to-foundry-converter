// SPDX-License-Identifier: AGPL-3.0-or-later
import { singularKey } from "../pipeline.ts";
import {
    allLines,
    ancestors,
    isSection,
    type Layout,
    type Line,
    ownLines,
    type Section,
    sectionsOf,
} from "./layout.ts";
import { featureNames, type Progression, readProgression } from "./progression.ts";
import { type Field, readFields, readTraits, type Trait } from "./text.ts";
import {
    ABILITIES,
    ABILITY_SCORE_IMPROVEMENT,
    ARMOR,
    countOf,
    CREATURE_TYPES,
    FEAT_SUBTYPES,
    keysNamed,
    plainWords,
    SIZES,
    SKILLS,
    WEAPONS,
} from "./vocab.ts";

/**
 * Character options read from a document's section structure. Each kind is
 * recognised by the schema fields it carries, never by its name:
 *
 *  - a class: a hit-die field and a level progression table (Level and
 *    Features columns);
 *  - its features: headings named in the table's features column, or headed
 *    `Level N: <name>`; its subclasses: headed `<…> Subclass: <name>`, or the
 *    sections in the class that are neither features nor hold features, whose
 *    own subsections say at what level they apply;
 *  - a background: skill-proficiency and equipment fields;
 *  - a feat: a section opened by an italic line naming its feat category or
 *    its prerequisite;
 *  - a species: size and speed fields or traits, with its subraces the
 *    sections inside it that carry traits of their own.
 */

export interface FeatureReading {
    name: string;
    level: number | null;
    section: Section;
}

export interface SkillGrant {
    grants: string[];
    choices: { count: number; pool: string[] }[];
}

export interface ScaleReading {
    title: string;
    identifier: string;
    type: "number" | "dice" | "distance" | "string";
    scale: Record<string, JsonScale>;
}

export type JsonScale =
    | { value: number }
    | { number: number | null; faces: number }
    | { value: number; units?: string }
    | { value: string };

export interface SubclassReading {
    name: string;
    section: Section;
    features: FeatureReading[];
}

export interface ClassReading {
    name: string;
    section: Section;
    hitDie: string | null;
    primaryAbility: { value: string[]; all: boolean } | null;
    saves: string[];
    armor: string[];
    weapons: string[];
    skills: SkillGrant | null;
    progression: Progression | null;
    features: FeatureReading[];
    asiLevels: number[];
    subclassLevel: number | null;
    scales: ScaleReading[];
    subclasses: SubclassReading[];
}

export interface BackgroundReading {
    name: string;
    section: Section;
    abilities: string[];
    skills: SkillGrant | null;
    feat: string | null;
    feature: FeatureReading | null;
}

export interface FeatReading {
    name: string;
    section: Section;
    /** The italic line naming the category / prerequisite. */
    lead: Line;
    subtype: string;
    prerequisite: string | null;
    level: number | null;
    repeatable: boolean;
}

export interface SpeciesReading {
    name: string;
    /** The section of the species (or, for a subrace, of its parent species). */
    section: Section;
    /** The subrace's own section, when this is a subrace. */
    subrace: Section | null;
    /** Every subrace section of the species (each its own document). */
    subraces: Section[];
    traits: Trait[];
    sizes: string[];
    walk: number | null;
    darkvision: number | null;
    creatureType: string | null;
    abilityIncreases: { fixed: Record<string, number>; points: number } | null;
}

export interface Readings {
    classes: ClassReading[];
    backgrounds: BackgroundReading[];
    feats: FeatReading[];
    species: SpeciesReading[];
}

const LABEL = {
    hitDie: /^hit (point )?di(c)?e$/u,
    saves: /^saving throws?( proficienc(y|ies))?$/u,
    skills: /^skills?( proficienc(y|ies))?$/u,
    armor: /^armou?r( training| proficienc(y|ies))?$/u,
    weapons: /^weapons?( proficienc(y|ies))?$/u,
    primary: /^primary abilit(y|ies)$/u,
    equipment: /^(starting )?equipment$/u,
    abilities: /^ability scores?$/u,
    feat: /^feats?$/u,
    size: /^size$/u,
    speed: /^speed$/u,
    darkvision: /^darkvision$/u,
    creatureType: /^creature type$/u,
    abilityIncrease: /^ability score increases?$/u,
    repeatable: /^repeatable$/u,
} as const;

/**
 * Trait names that set a species' schema fields (size, speed, senses, type,
 * ability scores, languages) or the actor's own details (age, alignment), or
 * announce its subraces — none is a feature of its own.
 */
const STRUCTURAL_TRAITS =
    /^(size|speed|darkvision|creature type|ability score increases?|languages?|age|alignment|subraces?)$/u;

/** `Level N: <name>` — a feature heading that states its level. */
const LEVEL_HEADING = /^level (\d{1,2}):\s*(.+)$/iu;
/** `<class> Subclass: <name>`. */
const SUBCLASS_HEADING = /^(.+?)\s+subclass:\s*(.+)$/iu;
/** A level stated in prose: "at 3rd level". */
const ORDINAL_LEVEL = /\b(\d{1,2})(?:st|nd|rd|th) level\b/iu;
/** A spell slot column's header names its spell level, as a number or an ordinal. */
const SPELL_LEVEL_HEADER = /\d/u;

/** Most sizes a species offers. */
const MAX_SPECIES_SIZES = 3;

/** Fewest subsections stating their level that make a section a subclass's features. */
const MIN_STATED_FEATURES = 2;

/** A section's subsections other than table captions. */
const subsections = (section: Section): Section[] =>
    section.items.filter(isSection).filter((s) => !s.caption);

const labelIs = (field: { label: string }, re: RegExp): boolean => re.test(plainWords(field.label));

function firstField(fields: readonly Field[], re: RegExp): Field | undefined {
    return fields.find((f) => labelIs(f, re));
}

/** Every field in the section and its subsections. */
function fieldsUnder(section: Section): Field[] {
    return sectionsOf(section).flatMap((s) => readFields(ownLines(s)));
}

/** Split a list on commas, semicolons and the words "and"/"or", each item in plain words. */
function listItems(value: string): string[] {
    return value
        .split(/\s*(?:[,;]|\band\b|\bor\b)\s*/iu)
        .map(plainWords)
        .filter((s) => s.length > 0);
}

/** Proficiency keys whose category words a list names ("Light and Medium armor and Shields"). */
function categoryKeys(value: string, vocab: readonly (readonly [string, RegExp])[], all: string[]): string[] {
    const keys = new Set<string>();
    for (const item of listItems(value)) {
        for (const key of /^all armou?r$/u.test(item) ? all : []) {
            keys.add(key);
        }
        for (const [key, re] of vocab) {
            if (re.test(item)) {
                keys.add(key);
            }
        }
    }
    return vocab.map(([key]) => key).filter((k) => keys.has(k));
}

/** Skill proficiencies a field grants outright or offers a choice of. */
export function readSkills(value: string): SkillGrant {
    const choose = /\bchoose (any )?(\w+)\b(.*)$/iu.exec(value);
    if (choose === null) {
        return { grants: keysNamed(value, SKILLS).map((k) => `skills:${k}`), choices: [] };
    }
    const count = countOf(choose[2] ?? "") ?? 1;
    const named = keysNamed(choose[3] ?? "", SKILLS);
    const pool =
        choose[1] !== undefined || named.length === 0 ? ["skills:*"] : named.map((k) => `skills:${k}`);
    return { grants: [], choices: [{ count, pool }] };
}

/** The level a feature's prose states, if any. */
function statedLevel(section: Section): number | null {
    const match = ORDINAL_LEVEL.exec(
        allLines(section)
            .map((l) => l.text)
            .join(" "),
    );
    return match === null ? null : Number(match[1]);
}

/** Feature names per level from the table's features column (a trailing parenthetical dropped). */
function tableFeatures(table: Progression): Map<string, { name: string; levels: number[] }> {
    const out = new Map<string, { name: string; levels: number[] }>();
    for (const row of table.rows) {
        for (const raw of featureNames(row.cells[table.featuresColumn] ?? "")) {
            const name = raw.replace(/\s*\([^)]*\)\s*$/u, "").trim();
            const key = singularKey(name);
            const entry = out.get(key) ?? { name, levels: [] };
            entry.levels.push(row.level);
            out.set(key, entry);
        }
    }
    return out;
}

/** A progression column's value per level, kept where it changes. */
function scaleOf(table: Progression, column: number): ScaleReading | null {
    const title = (table.headers[column] ?? "").trim();
    const values = table.rows
        .map((row) => ({ level: row.level, text: (row.cells[column] ?? "").trim() }))
        .filter((v) => v.text.length > 0 && !/^[—–-]+$/u.test(v.text));
    if (title.length === 0 || values.length === 0) {
        return null;
    }
    const kinds = values.map(({ text }) => {
        if (/^\+?\d+$/u.test(text)) {
            return "number";
        }
        if (/^\d*d\d+$/iu.test(text)) {
            return "dice";
        }
        if (/^\+?\d+\s*(ft\.?|feet)$/iu.test(text)) {
            return "distance";
        }
        return "string";
    });
    const type = kinds.every((k) => k === kinds[0]) ? (kinds[0] ?? "string") : "string";
    const scale: Record<string, JsonScale> = {};
    let previous = "";
    for (const { level, text } of values) {
        if (text === previous) {
            continue;
        }
        previous = text;
        if (type === "number") {
            scale[String(level)] = { value: Number(text.replace("+", "")) };
        } else if (type === "dice") {
            const [n, faces] = text.toLowerCase().split("d");
            scale[String(level)] = {
                number: n === undefined || n === "" ? null : Number(n),
                faces: Number(faces),
            };
        } else if (type === "distance") {
            scale[String(level)] = { value: Number(/\d+/u.exec(text)?.[0] ?? "0") };
        } else {
            scale[String(level)] = { value: text };
        }
    }
    return { title, identifier: slugOf(title), type, scale };
}

function slugOf(text: string): string {
    return plainWords(text).replace(/\s+/gu, "-");
}

/** The columns of a progression table that scale with level (not level, features, bonus or spell slots). */
function scaleColumns(table: Progression): ScaleReading[] {
    const out: ScaleReading[] = [];
    table.headers.forEach((header, column) => {
        const words = plainWords(header);
        if (
            column === table.levelColumn ||
            column === table.featuresColumn ||
            words === "proficiency bonus" ||
            SPELL_LEVEL_HEADER.test(words)
        ) {
            return;
        }
        const scale = scaleOf(table, column);
        if (scale !== null) {
            out.push(scale);
        }
    });
    return out;
}

/**
 * A class feature the system grants as an AbilityScoreImprovement advancement
 * (which offers the score increase or a feat of the player's choice): the
 * advancement's own name, or the epic-boon feat category's.
 */
const isAsi = (name: string): boolean =>
    plainWords(name) === ABILITY_SCORE_IMPROVEMENT ||
    plainWords(name) === FEAT_SUBTYPES.find(([key]) => key === "epicBoon")?.[1];
const namesSubclass = (name: string): boolean => /\bsubclass\b/u.test(plainWords(name));

/** Level-headed features under a section, outside the excluded sections. */
function levelHeaded(section: Section, exclude: ReadonlySet<Section>): FeatureReading[] {
    const out: FeatureReading[] = [];
    const visit = (s: Section): void => {
        for (const item of s.items) {
            if (!isSection(item) || exclude.has(item)) {
                continue;
            }
            const match = LEVEL_HEADING.exec(item.title);
            if (match !== null) {
                out.push({ name: (match[2] ?? "").trim(), level: Number(match[1]), section: item });
            } else {
                visit(item);
            }
        }
    };
    visit(section);
    return out;
}

/** Read the class whose hit-die field is in `fieldSection`, if not already claimed. */
function readClass(fieldSection: Section, hitDie: Field, claimed: ReadonlySet<Section>): ClassReading | null {
    const named = /\bper (.+?) level\b/iu.exec(hitDie.value)?.[1];
    const chain = [fieldSection, ...ancestors(fieldSection)].filter((s) => s.heading !== null);
    const section =
        chain.find((s) => named !== undefined && plainWords(s.title) === plainWords(named)) ??
        chain.find((s) => readProgression(allLines(s)) !== null);
    if (section === undefined || [section, ...ancestors(section)].some((s) => claimed.has(s))) {
        return null;
    }
    const fields = fieldsUnder(section);
    const value = (re: RegExp): string | undefined => firstField(fields, re)?.value;
    const progression = readProgression(allLines(section));

    // Subclasses headed `<…> Subclass: <name>`, with level-headed features.
    const subclasses: SubclassReading[] = [];
    for (const s of sectionsOf(section).slice(1)) {
        const match = SUBCLASS_HEADING.exec(s.title);
        if (match !== null) {
            subclasses.push({
                name: (match[2] ?? "").trim(),
                section: s,
                features: levelHeaded(s, new Set()),
            });
        }
    }
    let features = levelHeaded(section, new Set(subclasses.map((s) => s.section)));
    let subclassLevel = features.find((f) => namesSubclass(f.name))?.level ?? null;

    if (features.length === 0 && progression !== null) {
        // Features named by the table, each at the first level it lists.
        const listed = tableFeatures(progression);
        const seen = new Set<string>();
        const featureSections = new Set<Section>();
        for (const s of sectionsOf(section).slice(1)) {
            const entry = s.caption ? undefined : listed.get(singularKey(s.title));
            if (entry !== undefined && !seen.has(singularKey(s.title))) {
                seen.add(singularKey(s.title));
                featureSections.add(s);
                features.push({ name: s.title, level: entry.levels[0] ?? null, section: s });
            }
        }
        // Sections holding no feature, inside none and not named by the table, at least
        // two of whose subsections state their levels; the innermost such sections.
        const holdsFeature = (s: Section): boolean => sectionsOf(s).some((d) => featureSections.has(d));
        const inFeature = (s: Section): boolean => ancestors(s).some((a) => featureSections.has(a));
        const candidates = sectionsOf(section)
            .slice(1)
            .filter(
                (s) =>
                    !holdsFeature(s) &&
                    !inFeature(s) &&
                    !listed.has(singularKey(s.title)) &&
                    subsections(s).filter((c) => statedLevel(c) !== null).length >= MIN_STATED_FEATURES,
            );
        const candidateSet = new Set(candidates);
        for (const s of candidates) {
            if (
                sectionsOf(s)
                    .slice(1)
                    .some((d) => candidateSet.has(d))
            ) {
                continue;
            }
            let level: number | null = null;
            const subFeatures: FeatureReading[] = [];
            for (const child of subsections(s)) {
                level = statedLevel(child) ?? level;
                subFeatures.push({ name: child.title, level, section: child });
            }
            const first = subFeatures.find((f) => f.level !== null)?.level ?? null;
            subclasses.push({
                name: s.title,
                section: s,
                features: subFeatures.map((f) => ({ ...f, level: f.level ?? first })),
            });
        }
        const subLevels = subclasses.flatMap((s) =>
            s.features.map((f) => f.level ?? Number.POSITIVE_INFINITY),
        );
        subclassLevel = subLevels.length === 0 ? null : Math.min(...subLevels);
        if (subclassLevel === Number.POSITIVE_INFINITY) {
            subclassLevel = null;
        }
    }

    const asiLevels =
        progression === null
            ? features.flatMap((f) => (isAsi(f.name) && f.level !== null ? [f.level] : []))
            : [...tableFeatures(progression).values()].flatMap((f) => (isAsi(f.name) ? f.levels : []));
    features = features.filter((f) => !isAsi(f.name) && !namesSubclass(f.name));

    const primary = value(LABEL.primary);
    const skills = value(LABEL.skills);
    return {
        name: section.title,
        section,
        hitDie: (() => {
            const faces = /d(\d+)/iu.exec(hitDie.value)?.[1];
            return faces === undefined ? null : `d${faces}`;
        })(),
        primaryAbility:
            primary === undefined
                ? null
                : { value: keysNamed(primary, ABILITIES), all: !/\bor\b/iu.test(primary) },
        saves: keysNamed(value(LABEL.saves) ?? "", ABILITIES),
        armor: categoryKeys(value(LABEL.armor) ?? "", ARMOR, ["lgt", "med", "hvy"]),
        weapons: categoryKeys(value(LABEL.weapons) ?? "", WEAPONS, []),
        skills: skills === undefined ? null : readSkills(skills),
        progression,
        features,
        asiLevels: [...new Set(asiLevels)].sort((a, b) => a - b),
        subclassLevel,
        scales: progression === null ? [] : scaleColumns(progression),
        subclasses,
    };
}

function readBackground(section: Section): BackgroundReading | null {
    const fields = readFields(ownLines(section));
    const skills = firstField(fields, LABEL.skills);
    if (skills === undefined || firstField(fields, LABEL.equipment) === undefined) {
        return null;
    }
    const featureSection = section.items.filter(isSection).find((s) => /^feature:\s*\S/iu.test(s.title));
    const feat = firstField(fields, LABEL.feat)
        ?.value.replace(/\(see [^)]*\)/giu, "")
        .trim();
    return {
        name: section.title,
        section,
        abilities: keysNamed(firstField(fields, LABEL.abilities)?.value ?? "", ABILITIES),
        skills: readSkills(skills.value),
        feat: feat === undefined || feat.length === 0 ? null : feat,
        feature:
            featureSection === undefined
                ? null
                : {
                      name: featureSection.title.replace(/^feature:\s*/iu, ""),
                      level: null,
                      section: featureSection,
                  },
    };
}

function readFeat(section: Section): FeatReading | null {
    const [lead] = ownLines(section);
    if (lead === undefined || !lead.italic || section.items[0] !== lead) {
        return null;
    }
    const category = /^(.+?)\s+feat\b/iu.exec(lead.text);
    const prerequisite = /\bprerequisites?:\s*([^)]+)/iu.exec(lead.text);
    if (category === null && prerequisite === null) {
        return null;
    }
    const words = plainWords(category?.[1] ?? "");
    const fields = sectionsOf(section).flatMap((s) => [
        ...readFields(ownLines(s)).map((f) => f.label),
        ...readTraits(ownLines(s)).map((t) => t.label),
        ...(s === section ? [] : [s.title]),
    ]);
    const level = /\blevel (\d{1,2})/iu.exec(prerequisite?.[1] ?? "")?.[1];
    return {
        name: section.title,
        section,
        lead,
        subtype: FEAT_SUBTYPES.find(([, label]) => label === words)?.[0] ?? "",
        prerequisite: prerequisite?.[1]?.trim() ?? null,
        level: level === undefined ? null : Number(level),
        repeatable: fields.some((label) => LABEL.repeatable.test(plainWords(label))),
    };
}

/** The labels a section's own lines set as fields or traits. */
function speciesLabels(section: Section): { fields: Field[]; traits: Trait[] } {
    const lines = ownLines(section);
    return { fields: readFields(lines), traits: readTraits(lines) };
}

const feetIn = (text: string): number | null => {
    const match = /(\d+)\s*(?:feet|ft)/iu.exec(text);
    return match === null ? null : Number(match[1]);
};

/** Fixed ability increases a trait states ("Your Constitution score increases by 2"), and free points. */
function abilityIncreases(text: string): { fixed: Record<string, number>; points: number } {
    const fixed: Record<string, number> = {};
    const words = plainWords(text);
    for (const [key, label] of ABILITIES) {
        const match = new RegExp(`\\b${label} score (?:increases|increase) by (\\d+)`, "u").exec(words);
        if (match !== null) {
            fixed[key] = Number(match[1]);
        }
    }
    const each = /\bability scores each increase by (\d+)/u.exec(words);
    if (each !== null) {
        for (const [key] of ABILITIES) {
            fixed[key] = Number(each[1]);
        }
    }
    let points = 0;
    for (const match of words.matchAll(
        /\b(\w+) (?:other |different )?ability scores? of your choice (?:each )?increases? by (\d+)/gu,
    )) {
        points += (countOf(match[1] ?? "") ?? 1) * Number(match[2]);
    }
    return { fixed, points };
}

function speciesFrom(
    name: string,
    section: Section,
    subrace: Section | null,
    subraces: Section[],
    fields: readonly Field[],
    traits: readonly Trait[],
): SpeciesReading {
    const find = (re: RegExp): string | undefined =>
        fields.find((f) => labelIs(f, re))?.value ?? traits.find((t) => labelIs(t, re))?.body;
    const increase = traits.filter((t) => labelIs(t, LABEL.abilityIncrease)).map((t) => t.body);
    const type = plainWords(find(LABEL.creatureType) ?? "").split(" ")[0] ?? "";
    return {
        name,
        section,
        subrace,
        subraces,
        traits: traits.filter((t) => !STRUCTURAL_TRAITS.test(plainWords(t.label))),
        sizes: keysNamed(find(LABEL.size) ?? "", SIZES),
        walk: feetIn(find(LABEL.speed) ?? ""),
        darkvision: feetIn(find(LABEL.darkvision) ?? ""),
        creatureType: CREATURE_TYPES.includes(type) ? type : null,
        abilityIncreases: increase.length === 0 ? null : abilityIncreases(increase.join(" ")),
    };
}

function readSpecies(section: Section): SpeciesReading[] | null {
    const own = speciesLabels(section);
    const labels = [...own.fields, ...own.traits];
    const sizeText = [
        ...own.fields.map((f) => [f.label, f.value]),
        ...own.traits.map((t) => [t.label, t.body]),
    ]
        .filter(([label]) => LABEL.size.test(plainWords(label ?? "")))
        .map(([, text]) => text ?? "");
    const speedText = labels.find((l) => labelIs(l, LABEL.speed));
    // A species has a size or two and a speed in feet (a glossary of size and speed has neither).
    const sizes = keysNamed(sizeText.join(" "), SIZES).length;
    if (
        sizes < 1 ||
        sizes > MAX_SPECIES_SIZES ||
        speedText === undefined ||
        feetIn("value" in speedText ? speedText.value : speedText.body) === null
    ) {
        return null;
    }
    const parent = section.parent;
    const titled =
        parent !== null &&
        parent.heading !== null &&
        plainWords(section.title).startsWith(`${plainWords(parent.title)} `)
            ? parent
            : section;
    const subraces = sectionsOf(titled)
        .slice(1)
        .filter((s) => s !== section && readTraits(ownLines(s)).length > 0);
    if (subraces.length === 0) {
        return [speciesFrom(titled.title, titled, null, [], own.fields, own.traits)];
    }
    return subraces.map((sub) => {
        const extra = speciesLabels(sub);
        return speciesFrom(
            sub.title,
            titled,
            sub,
            subraces,
            [...own.fields, ...extra.fields],
            [...own.traits, ...extra.traits],
        );
    });
}

export function readCharacterOptions(layout: Layout): Readings {
    const sections = sectionsOf(layout.root).slice(1);
    const claimed = new Set<Section>();
    const isClaimed = (s: Section): boolean => [s, ...ancestors(s)].some((a) => claimed.has(a));

    const classes: ClassReading[] = [];
    for (const section of sections) {
        for (const field of readFields(ownLines(section))) {
            if (labelIs(field, LABEL.hitDie)) {
                const reading = readClass(section, field, claimed);
                if (reading !== null) {
                    classes.push(reading);
                    claimed.add(reading.section);
                }
            }
        }
    }

    const backgrounds: BackgroundReading[] = [];
    const feats: FeatReading[] = [];
    const species: SpeciesReading[] = [];
    for (const section of sections) {
        if (isClaimed(section)) {
            continue;
        }
        const background = readBackground(section);
        if (background !== null) {
            backgrounds.push(background);
            claimed.add(section);
            continue;
        }
        const feat = readFeat(section);
        if (feat !== null) {
            feats.push(feat);
            claimed.add(section);
            continue;
        }
        // A species claims the section its traits are in (and its subraces), not the
        // section it is named by, so what else that section holds is still read.
        const read = readSpecies(section);
        if (read !== null) {
            species.push(...read);
            claimed.add(section);
            for (const sub of read.flatMap((s) => s.subraces)) {
                claimed.add(sub);
            }
        }
    }
    return { classes, backgrounds, feats, species };
}
