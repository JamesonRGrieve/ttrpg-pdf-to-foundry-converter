// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dnd5e Foundry system's own trait vocabulary, as an OUTPUT FORMAT spec:
 * the keys its data model stores (`skills:ath`, `armor:lgt`, `saves:str`,
 * `med`) and the English labels the system shows for them, which are how a
 * printed rule names the same thing. Nothing here enumerates content of any
 * document — these are the system's fixed configuration enums, like the
 * wh40k-rpg characteristic keys.
 */

/** Ability keys and labels (`CONFIG.DND5E.abilities`). */
export const ABILITIES: readonly (readonly [string, string])[] = [
    ["str", "strength"],
    ["dex", "dexterity"],
    ["con", "constitution"],
    ["int", "intelligence"],
    ["wis", "wisdom"],
    ["cha", "charisma"],
];

/** Skill keys and labels (`CONFIG.DND5E.skills`). */
export const SKILLS: readonly (readonly [string, string])[] = [
    ["acr", "acrobatics"],
    ["ani", "animal handling"],
    ["arc", "arcana"],
    ["ath", "athletics"],
    ["dec", "deception"],
    ["his", "history"],
    ["ins", "insight"],
    ["itm", "intimidation"],
    ["inv", "investigation"],
    ["med", "medicine"],
    ["nat", "nature"],
    ["prc", "perception"],
    ["prf", "performance"],
    ["per", "persuasion"],
    ["rel", "religion"],
    ["slt", "sleight of hand"],
    ["ste", "stealth"],
    ["sur", "survival"],
];

/** Armor proficiency keys and the category words that name them (`CONFIG.DND5E.armorProficiencies`). */
export const ARMOR: readonly (readonly [string, RegExp])[] = [
    ["lgt", /^light( armou?r)?$/u],
    ["med", /^medium( armou?r)?$/u],
    ["hvy", /^heavy( armou?r)?$/u],
    ["shl", /^shields?$/u],
];

/** Weapon proficiency keys and the category words that name them (`CONFIG.DND5E.weaponProficiencies`). */
export const WEAPONS: readonly (readonly [string, RegExp])[] = [
    ["sim", /^simple( weapons?)?$/u],
    ["mar", /^martial( weapons?)?$/u],
];

/** Actor size keys and labels (`CONFIG.DND5E.actorSizes`). */
export const SIZES: readonly (readonly [string, string])[] = [
    ["tiny", "tiny"],
    ["sm", "small"],
    ["med", "medium"],
    ["lg", "large"],
    ["huge", "huge"],
    ["grg", "gargantuan"],
];

/** Creature type keys (`CONFIG.DND5E.creatureTypes`); each is its own English label. */
export const CREATURE_TYPES: readonly string[] = [
    "aberration",
    "beast",
    "celestial",
    "construct",
    "dragon",
    "elemental",
    "fey",
    "fiend",
    "giant",
    "humanoid",
    "monstrosity",
    "ooze",
    "plant",
    "undead",
];

/** Feat subtype keys and labels (`CONFIG.DND5E.featureTypes.feat.subtypes`). */
export const FEAT_SUBTYPES: readonly (readonly [string, string])[] = [
    ["general", "general"],
    ["origin", "origin"],
    ["fightingStyle", "fighting style"],
    ["epicBoon", "epic boon"],
];

/** The system's label of its AbilityScoreImprovement advancement, as rules print it. */
export const ABILITY_SCORE_IMPROVEMENT = "ability score improvement";

/** Count words a rule may spell a choice count with. */
const COUNT_WORDS: readonly string[] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
];

/** A count printed as digits or as a word ("2", "two"), or null. */
export function countOf(word: string): number | null {
    const lower = word.toLowerCase();
    if (/^\d+$/u.test(lower)) {
        return Number(lower);
    }
    const index = COUNT_WORDS.indexOf(lower);
    return index < 0 ? null : index;
}

/** Lower-case, letters and spaces only: how labels are compared. */
export function plainWords(text: string): string {
    return text
        .toLowerCase()
        .replace(/[’']/gu, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/** The keys whose labels a text names, in the vocabulary's order. */
export function keysNamed(text: string, vocab: readonly (readonly [string, string])[]): string[] {
    const words = ` ${plainWords(text)} `;
    return vocab.filter(([, label]) => words.includes(` ${label} `)).map(([key]) => key);
}
