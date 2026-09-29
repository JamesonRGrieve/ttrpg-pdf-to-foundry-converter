// SPDX-License-Identifier: AGPL-3.0-or-later
import { NOTE_MARKERS } from "../util/text.ts";

/**
 * Entity-name normalization. Names printed in display faces arrive in capitals
 * (small caps are uppercased by arbitration); compendium names are title case.
 * Only generic English capitalization rules are applied — no name lists.
 */

/** Short function words: kept lowercase inside a title-cased name, never a name's last word. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
    "a",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "from",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
]);

function capitalize(word: string): string {
    // Capitalize after hyphens and opening brackets too: "Half-Track", "(Troop)".
    return word.replace(/(^|[-(/"'])(\p{Ll})/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

/**
 * Capitals scrambled inside words, as a text layer that lost small caps' case
 * leaves them ("hereTek", "STriking"): never so in running prose.
 */
export function scrambledCase(text: string): boolean {
    return /\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}/u.test(text);
}

/**
 * Casing a text layer scrambled (small caps whose case was lost: "oath-caPtain",
 * "GanG leaDer"): capitals inside words after lower-case letters, more than a
 * real name has ("McAllister" has one, and starts with a capital).
 */
export function caseLost(name: string): boolean {
    // A printed name is never all lower case…
    if (!/\p{Lu}/u.test(name)) {
        return true;
    }
    // …nor sets two capitals before lower case ("STriking", "SpiriTSeer").
    if (/\p{Lu}{2}\p{Ll}/u.test(name)) {
        return true;
    }
    // …nor mixes words in capitals with words in lower case, none title-cased ("DEATH world")…
    if (/\p{Ll}/u.test(name) && !/(?<!\p{L})\p{Lu}\p{Ll}/u.test(name)) {
        return true;
    }
    // …nor starts in lower case yet capitalises a later word ("aelurus heavy Trike").
    if (/^\P{L}*\p{Ll}/u.test(name) && /\p{Lu}/u.test(name)) {
        return true;
    }
    const jumps = name.match(/\p{Ll}\p{Lu}/gu)?.length ?? 0;
    // …nor jumps to a capital mid-word beside a word wholly in capitals ("HasHian TRELS")…
    const capitalsWord = /(?<!\p{L})\p{Lu}{2,}(?!\p{L})/u.test(name);
    if (jumps >= 2 || (jumps >= 1 && (/^\P{L}*\p{Ll}/u.test(name) || capitalsWord))) {
        return true;
    }
    // …nor sets a title-cased word beside a long word wholly in capitals
    // ("Berserk CHARGE"); a short one may be an initialism or a numeral.
    return /(?<!\p{L})\p{Lu}\p{Ll}/u.test(name) && LONG_CAPITALS_WORD.test(name);
}

/** A word of capitals too long to be an initialism or a Roman numeral. */
const LONG_CAPITALS_WORD = /(?<!\p{L})\p{Lu}{4,}(?!\p{L})/u;

/** A run of letters in a name or in prose. */
const WORD = /\p{L}+/gu;

/** The words of a text in order, lower-cased. */
export function wordsOf(text: string): string[] {
    return (text.match(WORD) ?? []).map((w) => w.toLowerCase());
}

/**
 * Rejoin a word the text layer split in two ("Hashi an" → "Hashian"): two
 * adjacent words join when the prose around them (`words`, in order) spells
 * them as one word more often than as the two.
 */
export function rejoinSplitWords(name: string, words: readonly string[]): string {
    const count = (whole: string): number => words.filter((w) => w === whole).length;
    const pairs = (a: string, b: string): number =>
        words.filter((w, i) => w === a && words[i + 1] === b).length;
    const parts = name.split(/(\s+)/u);
    for (let i = 0; i + 2 < parts.length; i += 2) {
        const [a, b] = [parts[i] ?? "", parts[i + 2] ?? ""];
        const letters = /^\p{L}+$/u;
        if (
            letters.test(a) &&
            letters.test(b) &&
            count(`${a}${b}`.toLowerCase()) > pairs(a.toLowerCase(), b.toLowerCase())
        ) {
            parts.splice(i, 3, `${a}${b.toLowerCase()}`);
            i -= 2;
        }
    }
    return parts.join("");
}

/** Title-case a name, leaving mixed-case input (already cased by the source) untouched. */
export function titleCase(name: string): string {
    if (/\p{Ll}/u.test(name) && !caseLost(name)) {
        return name;
    }
    return name
        .toLowerCase()
        .split(" ")
        .map((word, i) => (i > 0 && FUNCTION_WORDS.has(word) ? word : capitalize(word)))
        .join(" ");
}

/** Lower-case content words beyond which a "name" reads as a sentence. */
const MAX_LOWERCASE_CONTENT_WORDS = 2;

/**
 * A name is title-like: its content words are capitalised. A run of
 * lower-case content words ("Some cybernetic systems are only provided") is
 * prose that strayed into a name column.
 */
export function readsAsProse(name: string): boolean {
    const lowerContent = name
        .split(/\s+/u)
        .filter((w) => /^\p{Ll}/u.test(w) && !FUNCTION_WORDS.has(w.toLowerCase()));
    return lowerContent.length > MAX_LOWERCASE_CONTENT_WORDS;
}

/** A name starts with a capital or digit, perhaps after opening quotes or brackets. */
export function startsLikeName(name: string): boolean {
    return /^[\p{Pi}\p{Ps}"']*[\p{Lu}\p{N}]/u.test(name);
}

/** Connectives that join clauses: a line ending on one breaks off mid-sentence. */
const CONNECTIVES: ReadonlySet<string> = new Set([
    "unless",
    "if",
    "when",
    "while",
    "than",
    "that",
    "but",
    "because",
    "although",
    "whether",
    "where",
    "which",
]);

/** A "name" whose last word is a lower-case function word or connective is a broken-off sentence. */
export function endsMidSentence(name: string): boolean {
    const last = name.trim().split(/\s+/u).at(-1) ?? "";
    return /^\p{Ll}/u.test(last) && (FUNCTION_WORDS.has(last) || CONNECTIVES.has(last));
}

/**
 * Restore word spaces a text layer dropped between two words of a title
 * ("CriticalEffects" → "Critical Effects"): a capital straight after a
 * lower-case letter starts a new word. For captions and headings, where
 * running camel-case does not occur.
 */
export function restoreWordSpaces(title: string): string {
    return title.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
}

export function cleanName(raw: string): string {
    return titleCase(
        raw
            .replace(NOTE_MARKERS, "")
            .replace(/\s+/gu, " ")
            // Alternatives joined by a slash are one name ("Hood/Cowl"); a
            // space the text layer puts after the slash is not printed.
            .replace(/(?<=\p{L})\/ (?=\p{L})/gu, "/")
            .replace(/[\s:,.;]+$/u, "")
            .trim(),
    );
}

/** The system's NPC `tier` enum. */
const NPC_TIERS = ["troop", "elite", "master", "horde"] as const;
export type NpcTier = (typeof NPC_TIERS)[number];

/**
 * Split a statblock heading into name and tier: a parenthetical naming a tier
 * ("Name (Elite)") is the tier field, not part of the name.
 */
export function splitTier(heading: string): { name: string; tier: NpcTier | null } {
    let tier: NpcTier | null = null;
    const name = heading.replace(/\s*\(([^)]*)\)\s*/gu, (whole, inner: string) => {
        const hit = NPC_TIERS.find((t) => t === inner.trim().toLowerCase());
        if (hit === undefined) {
            return whole;
        }
        tier = hit;
        return " ";
    });
    return { name: cleanName(name), tier };
}
