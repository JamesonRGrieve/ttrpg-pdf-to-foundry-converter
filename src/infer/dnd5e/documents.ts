// SPDX-License-Identifier: AGPL-3.0-or-later
import { entityRef } from "../../stages/emit.ts";
import type { Entity, JsonObject, JsonValue } from "../../types/entity.ts";
import { id16 } from "../../util/hash.ts";
import { slugify } from "../../util/slug.ts";
import { escapeHtml } from "../../util/text.ts";
import { printedPage, type PageNumbering } from "../page-numbers.ts";
import { nameKey } from "../pipeline.ts";
import type { Dnd5eTarget } from "../targets.ts";
import { isSection, type Line, ownLines, type Section } from "./layout.ts";
import type { Progression } from "./progression.ts";
import type {
    BackgroundReading,
    ClassReading,
    FeatReading,
    FeatureReading,
    Readings,
    SkillGrant,
    SpeciesReading,
} from "./read.ts";
import { sectionHtml } from "./text.ts";
import { ABILITIES } from "./vocab.ts";

/**
 * Character-option readings → dnd5e Item documents, in the system's own data
 * model: `class` (hit die, primary ability, advancement: hit points,
 * proficiency traits, features by level, ability score improvements, scale
 * values, the subclass choice), `subclass`, `race`, `background` and `feat`
 * (feats proper, and the class, species and background features the others
 * grant). A granted feature is referenced by its compendium UUID.
 */

/** Pack category segment per kind of document. */
const SEGMENT = {
    classes: "classes",
    subclasses: "subclasses",
    classFeatures: "class-features",
    species: "species",
    backgrounds: "backgrounds",
    feats: "feats",
} as const;

/** A character-creation grant happens at character level 0 (on adding the option). */
const ORIGIN_LEVEL = 0;
/** "When you reach character level 5" — a species trait that comes later. */
const CHARACTER_LEVEL = /\bcharacter level (\d{1,2})\b/iu;

interface Context {
    target: Dnd5eTarget;
    book: string;
    source: string;
    numbering: PageNumbering;
    entities: Entity[];
}

const pageOf = (section: Section): number => section.heading?.pageIndex ?? 0;

/** One advancement entry, its `_id` derived from its owner and position. */
function advancement(owner: string, index: number, body: JsonObject): JsonObject {
    return { _id: id16(`advancement\u0000${owner}\u0000${index}`), value: {}, title: "", ...body };
}

function add(ctx: Context, kind: string, segment: string, section: Section, fields: JsonObject): string {
    const blockId = `dnd5e:${kind}:${pageOf(section)}:${section.heading?.order ?? 0}:${slugify(String(fields["name"]))}`;
    ctx.entities.push({
        blockId,
        documentType: "Item",
        group: ctx.target.id,
        pack: `${ctx.target.id}-${ctx.book}-${segment}`,
        ordinal: ctx.entities.length,
        fields,
        images: {},
        provenance: { pageIndex: pageOf(section), y: 0 },
    });
    return blockId;
}

function source(ctx: Context, section: Section): JsonObject {
    return {
        book: ctx.source,
        page: printedPage(ctx.numbering, pageOf(section)),
        rules: ctx.target.rules,
        custom: "",
        license: "",
    };
}

function item(
    ctx: Context,
    name: string,
    type: string,
    section: Section,
    description: string,
    system: JsonObject,
): JsonObject {
    return {
        name,
        type,
        system: {
            description: { value: description, chat: "" },
            source: source(ctx, section),
            identifier: slugify(name),
            ...system,
        },
        effects: [],
        flags: {},
    };
}

function grant(
    owner: string,
    index: number,
    refs: readonly string[],
    level: number,
    title: string,
): JsonObject {
    return advancement(owner, index, {
        type: "ItemGrant",
        level,
        title,
        configuration: {
            items: refs.map((ref) => ({ uuid: entityRef(ref), optional: false })),
            optional: false,
            spell: null,
        },
    });
}

function trait(
    owner: string,
    index: number,
    level: number,
    title: string,
    skills: SkillGrant | { grants: string[]; choices: SkillGrant["choices"] },
): JsonObject {
    return advancement(owner, index, {
        type: "Trait",
        level,
        title,
        configuration: {
            mode: "default",
            allowReplacements: false,
            grants: skills.grants,
            choices: skills.choices,
        },
    });
}

const noFixed = (): JsonObject => Object.fromEntries(ABILITIES.map(([key]) => [key, 0]));

/** Whether an item is (or, as its caption section, holds only) a progression table's lines. */
function inTable(table: Progression | null): (item: Line | Section) => boolean {
    return (item) =>
        table !== null &&
        (isSection(item)
            ? item.caption && ownLines(item).every((l) => table.lines.has(l))
            : table.lines.has(item));
}

/** A feature document under its granting option; `skip` leaves out what other documents carry. */
function addFeature(
    ctx: Context,
    feature: FeatureReading,
    featureType: string,
    requirement: string,
    segment: string,
    skip: (item: Line | Section) => boolean = () => false,
): string {
    const html = sectionHtml(feature.section, skip);
    return add(
        ctx,
        "feature",
        segment,
        feature.section,
        item(ctx, feature.name, "feat", feature.section, html, {
            type: { value: featureType, subtype: "" },
            requirements: requirement,
            prerequisites: { level: null, repeatable: false, items: [] },
            properties: [],
        }),
    );
}

/** Grants of features, one ItemGrant per level, in level order. */
function featureGrants(
    owner: string,
    start: number,
    features: readonly { level: number | null; ref: string }[],
    title: string,
): JsonObject[] {
    const byLevel = new Map<number, string[]>();
    for (const { level, ref } of features) {
        if (level !== null) {
            byLevel.set(level, [...(byLevel.get(level) ?? []), ref]);
        }
    }
    return [...byLevel.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([level, refs], i) => grant(owner, start + i, refs, level, title));
}

function progressionHtml(table: Progression): string {
    const head = `<tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    const rows = table.rows
        .map((row) => `<tr>${row.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("");
    return `<table>${head}${rows}</table>`;
}

function addClass(ctx: Context, reading: ClassReading): void {
    const owner = `class\u0000${reading.name}`;
    const table = inTable(reading.progression);
    const featureRefs = reading.features.map((f) => ({
        level: f.level,
        ref: addFeature(
            ctx,
            f,
            "class",
            `${reading.name} ${f.level ?? ""}`.trim(),
            SEGMENT.classFeatures,
            table,
        ),
    }));
    const skipped = new Set<Line | Section>([
        ...reading.features.map((f) => f.section),
        ...reading.subclasses.map((s) => s.section),
    ]);
    const description =
        sectionHtml(reading.section, (item) => skipped.has(item) || table(item)) +
        (reading.progression === null ? "" : progressionHtml(reading.progression));

    const entries: JsonObject[] = [advancement(owner, 0, { type: "HitPoints", configuration: {} })];
    const proficiency = (grants: string[], title: string): void => {
        if (grants.length > 0) {
            entries.push({
                ...trait(owner, entries.length, 1, title, { grants, choices: [] }),
                classRestriction: "primary",
            });
        }
    };
    proficiency(
        reading.saves.map((k) => `saves:${k}`),
        "Saving Throw Proficiencies",
    );
    proficiency(
        reading.armor.map((k) => `armor:${k}`),
        "Armor Proficiencies",
    );
    proficiency(
        reading.weapons.map((k) => `weapon:${k}`),
        "Weapon Proficiencies",
    );
    if (reading.skills !== null) {
        entries.push({
            ...trait(owner, entries.length, 1, "Skill Proficiencies", reading.skills),
            classRestriction: "primary",
        });
    }
    entries.push(...featureGrants(owner, entries.length, featureRefs, "Features"));
    for (const level of reading.asiLevels) {
        entries.push(
            advancement(owner, entries.length, {
                type: "AbilityScoreImprovement",
                level,
                configuration: { points: 2, fixed: noFixed(), cap: 2, locked: [] },
            }),
        );
    }
    for (const scale of reading.scales) {
        entries.push(
            advancement(owner, entries.length, {
                type: "ScaleValue",
                title: scale.title,
                configuration: {
                    identifier: scale.identifier,
                    type: scale.type,
                    scale: scale.scale as unknown as JsonValue,
                    distance: { units: scale.type === "distance" ? "ft" : "" },
                },
            }),
        );
    }
    if (reading.subclassLevel !== null) {
        entries.push(
            advancement(owner, entries.length, {
                type: "Subclass",
                level: reading.subclassLevel,
                configuration: {},
            }),
        );
    }

    add(
        ctx,
        "class",
        SEGMENT.classes,
        reading.section,
        item(ctx, reading.name, "class", reading.section, description, {
            hd: { denomination: reading.hitDie ?? "d6", additional: "", spent: 0 },
            levels: 1,
            primaryAbility: reading.primaryAbility ?? { value: [], all: true },
            advancement: entries,
        }),
    );

    for (const subclass of reading.subclasses) {
        const subOwner = `subclass\u0000${subclass.name}`;
        const refs = subclass.features.map((f) => ({
            level: f.level,
            ref: addFeature(
                ctx,
                f,
                "class",
                `${subclass.name} ${f.level ?? ""}`.trim(),
                SEGMENT.classFeatures,
                table,
            ),
        }));
        const subSkip = new Set<Line | Section>(subclass.features.map((f) => f.section));
        add(
            ctx,
            "subclass",
            SEGMENT.subclasses,
            subclass.section,
            item(
                ctx,
                subclass.name,
                "subclass",
                subclass.section,
                sectionHtml(subclass.section, (i) => subSkip.has(i)),
                {
                    classIdentifier: slugify(reading.name),
                    advancement: featureGrants(subOwner, 0, refs, "Features"),
                },
            ),
        );
    }
}

/** The feat document a background's feat field names: the longest feat name its text starts with. */
function featNamed(feats: ReadonlyMap<string, string>, text: string): string | null {
    const key = nameKey(text);
    let best: { length: number; ref: string } | null = null;
    for (const [name, ref] of feats) {
        if (key.startsWith(name) && (best === null || name.length > best.length)) {
            best = { length: name.length, ref };
        }
    }
    return best?.ref ?? null;
}

function addBackground(ctx: Context, reading: BackgroundReading, feats: ReadonlyMap<string, string>): void {
    const owner = `background\u0000${reading.name}`;
    const entries: JsonObject[] = [];
    const scores = ctx.target.backgroundAbilityScores;
    if (scores !== null && reading.abilities.length > 0) {
        entries.push(
            advancement(owner, entries.length, {
                type: "AbilityScoreImprovement",
                level: ORIGIN_LEVEL,
                configuration: {
                    points: scores.points,
                    cap: scores.cap,
                    fixed: noFixed(),
                    locked: ABILITIES.map(([key]) => key).filter((k) => !reading.abilities.includes(k)),
                },
            }),
        );
    }
    if (reading.skills !== null) {
        entries.push(trait(owner, entries.length, ORIGIN_LEVEL, "Skill Proficiencies", reading.skills));
    }
    const feat = reading.feat === null ? null : featNamed(feats, reading.feat);
    if (feat !== null) {
        entries.push(grant(owner, entries.length, [feat], ORIGIN_LEVEL, "Feat"));
    }
    if (reading.feature !== null) {
        const ref = addFeature(ctx, reading.feature, "background", reading.name, SEGMENT.backgrounds);
        entries.push(grant(owner, entries.length, [ref], ORIGIN_LEVEL, "Feature"));
    }
    const skip = new Set<Line | Section>(reading.feature === null ? [] : [reading.feature.section]);
    add(
        ctx,
        "background",
        SEGMENT.backgrounds,
        reading.section,
        item(
            ctx,
            reading.name,
            "background",
            reading.section,
            sectionHtml(reading.section, (i) => skip.has(i)),
            {
                advancement: entries,
            },
        ),
    );
}

function addFeat(ctx: Context, reading: FeatReading): string {
    return add(
        ctx,
        "feat",
        SEGMENT.feats,
        reading.section,
        item(
            ctx,
            reading.name,
            "feat",
            reading.section,
            sectionHtml(reading.section, (i) => i === reading.lead),
            {
                type: { value: "feat", subtype: reading.subtype },
                requirements: reading.prerequisite ?? "",
                prerequisites: { level: reading.level, repeatable: reading.repeatable, items: [] },
                properties: [],
            },
        ),
    );
}

/** The section a species trait's description renders from: its own lines only. */
function traitSection(section: Section, lines: readonly Line[]): Section {
    return { ...section, items: [...lines], parent: section.parent };
}

/** `others`: sections other documents carry, left out of the species' description. */
function addSpecies(ctx: Context, reading: SpeciesReading, others: ReadonlySet<Section>): void {
    const owner = `species\u0000${reading.name}`;
    const entries: JsonObject[] = [];
    if (reading.sizes.length > 0) {
        entries.push(
            advancement(owner, 0, {
                type: "Size",
                level: ORIGIN_LEVEL,
                configuration: { sizes: reading.sizes },
            }),
        );
    }
    if (reading.abilityIncreases !== null) {
        entries.push(
            advancement(owner, entries.length, {
                type: "AbilityScoreImprovement",
                level: ORIGIN_LEVEL,
                configuration: {
                    points: reading.abilityIncreases.points,
                    fixed: { ...noFixed(), ...reading.abilityIncreases.fixed },
                    locked: [],
                },
            }),
        );
    }
    const traitRefs = reading.traits.map((t) => {
        const level = CHARACTER_LEVEL.exec(t.body)?.[1];
        const home =
            reading.subrace !== null && t.lines.some((l) => ownLines(reading.subrace as Section).includes(l))
                ? (reading.subrace as Section)
                : reading.section;
        return {
            level: level === undefined ? ORIGIN_LEVEL : Number(level),
            ref: addFeature(
                ctx,
                { name: t.label, level: null, section: traitSection(home, t.lines) },
                "race",
                reading.name,
                SEGMENT.species,
            ),
        };
    });
    entries.push(...featureGrants(owner, entries.length, traitRefs, "Traits"));
    const skipped = new Set<Line | Section>([
        ...reading.traits.flatMap((t) => t.lines),
        ...reading.subraces,
        ...others,
    ]);
    const description =
        sectionHtml(reading.section, (i) => skipped.has(i)) +
        (reading.subrace === null ? "" : sectionHtml(reading.subrace, (i) => skipped.has(i)));
    add(
        ctx,
        "species",
        SEGMENT.species,
        reading.subrace ?? reading.section,
        item(ctx, reading.name, "race", reading.subrace ?? reading.section, description, {
            movement: { walk: reading.walk, units: "ft" },
            senses: { darkvision: reading.darkvision, units: "ft" },
            type: { value: reading.creatureType ?? "humanoid", subtype: "", custom: "" },
            advancement: entries,
        }),
    );
}

export function buildDocuments(
    readings: Readings,
    target: Dnd5eTarget,
    book: string,
    sourceTitle: string,
    numbering: PageNumbering,
): Entity[] {
    const ctx: Context = { target, book, source: sourceTitle, numbering, entities: [] };
    const feats = new Map<string, string>();
    for (const feat of readings.feats) {
        feats.set(nameKey(feat.name), addFeat(ctx, feat));
    }
    for (const reading of readings.classes) {
        addClass(ctx, reading);
    }
    for (const reading of readings.backgrounds) {
        addBackground(ctx, reading, feats);
    }
    const others = new Set<Section>([
        ...readings.classes.map((c) => c.section),
        ...readings.backgrounds.map((b) => b.section),
        ...readings.feats.map((f) => f.section),
    ]);
    for (const reading of readings.species) {
        addSpecies(ctx, reading, others);
    }
    return ctx.entities;
}
