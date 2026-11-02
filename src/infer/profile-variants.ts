// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry } from "./detect-entries.ts";
import { SCHEMA_CHAR_ORDER } from "./detect-grids.ts";
import type { DetectedNumericGrid } from "./types.ts";

/**
 * Statblocks printed as variants of a profile: a heading with its prose and
 * statblock fields, whose characteristic field lists only what differs from
 * a profile printed in full nearby ("Char: BS 35, Wounds 12" beside a
 * grid's "… Profile"). The variant is that profile with its own values
 * written over it.
 */

/** A characteristic field's label ("Char:", "Characteristics:"). */
const CHARACTERISTIC_FIELD = /^char(?:acteristic)?s?$/iu;
/** The statblock fields a variant prints besides its characteristics. */
const STATBLOCK_FIELD = /^(?:skills?|talents?|traits?|gear|weapons?|armou?r)$/iu;
/** A characteristic or wounds value: an abbreviation (the schema's keys) and its number. */
const VALUE = /\b(ws|bs|s|t|ag|int|per|wp|fel|wounds?)\s*(\d{1,3})\b/giu;
/** Pages before a variant its profile may be printed on. */
const PROFILE_REACH = 2;

export interface ProfileOverrides {
    characteristics: Record<string, number>;
    wounds: number | null;
}

/** A characteristic field's values: the schema's characteristic keys and wounds; null when it names none. */
export function profileOverrides(text: string): ProfileOverrides | null {
    const characteristics: Record<string, number> = {};
    let wounds: number | null = null;
    for (const m of text.matchAll(VALUE)) {
        const key = (m[1] ?? "").toLowerCase();
        const value = Number(m[2]);
        if (key.startsWith("wound")) {
            wounds = value;
        } else if (SCHEMA_CHAR_ORDER.includes(key)) {
            characteristics[key] = value;
        }
    }
    return Object.keys(characteristics).length === 0 && wounds === null ? null : { characteristics, wounds };
}

/** An entry printed as a profile variant: its overrides, or null when it is none. */
export function variantOverrides(entry: Entry): ProfileOverrides | null {
    const char = entry.fields.find(([label]) => CHARACTERISTIC_FIELD.test(label.trim()));
    if (char === undefined || !entry.fields.some(([label]) => STATBLOCK_FIELD.test(label.trim()))) {
        return null;
    }
    return profileOverrides(char[1]);
}

/**
 * The statblock a variant entry reads as: the nearest profile grid printed
 * before it (on its page or the pages just before) with the variant's
 * values written over its characteristics, and the variant's own fields as
 * the statblock's blocks (its wounds among them, when printed). Null when the
 * entry is no variant or no profile precedes it.
 */
export function variantGrid(
    entry: Entry,
    profiles: readonly DetectedNumericGrid[],
): { grid: DetectedNumericGrid; profile: DetectedNumericGrid } | null {
    const overrides = variantOverrides(entry);
    const page = entry.heading.pageIndex;
    const profile = profiles.findLast((g) => g.pageIndex <= page && g.pageIndex >= page - PROFILE_REACH);
    if (overrides === null || profile === undefined) {
        return null;
    }
    const values = profile.labels.map(
        (label, i) => overrides.characteristics[label] ?? profile.values[i] ?? 0,
    );
    const fields = entry.fields.filter(([label]) => !CHARACTERISTIC_FIELD.test(label.trim()));
    const blocks = [
        ...(overrides.wounds === null ? [] : [{ label: "Wounds", text: String(overrides.wounds) }]),
        ...fields.map(([label, text]) => ({ label, text })),
    ].map((b) => ({ ...b, pageIndex: page }));
    return {
        profile,
        grid: {
            pageIndex: page,
            labels: [...profile.labels],
            values,
            name: entry.heading.text,
            caption: null,
            bannerNumber: overrides.wounds ?? profile.bannerNumber,
            associatedText: blocks.map((b) => `${b.label}: ${b.text}`),
            blocks,
        },
    };
}
