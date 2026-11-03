// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";

/** An "fi" or "fl" pair followed by a space and a lower-case letter: a ligature set with a space after it. */
const SPLIT = /(fi|fl) (?=\p{Ll})/gu;
/** An "fi" or "fl" pair running on into a lower-case letter: a ligature read whole. */
const WHOLE = /(?:fi|fl)\p{Ll}/gu;

/** A run's last word, when it ends on an "fi" or "fl" pair. */
const PAIR_END = /(\p{L}*(?:fi|fl))$/u;
/** The width (in ems of the run's size) from which an empty run is a glyph rather than a space. */
const LOST_GLYPH_EMS = 0.3;
/** How near (points) an empty run must start to the run before it to be its next glyph. */
const TOUCHING = 0.6;

/**
 * Some text layers map the glyph after an "fi"/"fl" ligature to no text: the
 * word ends on the pair ("Rifl") and an empty run a letter wide follows it on
 * the same line. Where the document prints that word, one letter longer, more
 * often than it prints the cut word, the letter is restored ("Rifle").
 */
export function withLostLettersRestored(ir: IR): IR {
    const counts = new Map<string, number>();
    for (const r of ir.runs) {
        for (const w of r.text.toLowerCase().match(/\p{L}+/gu) ?? []) {
            counts.set(w, (counts.get(w) ?? 0) + 1);
        }
    }
    const longer = new Map<string, string | null>();
    const restored = (stem: string): string | null => {
        const key = stem.toLowerCase();
        if (!longer.has(key)) {
            let best: [string, number] | null = null;
            for (const [w, n] of counts) {
                if (
                    w.length === key.length + 1 &&
                    w.startsWith(key) &&
                    (best === null || n > best[1] || (n === best[1] && w < best[0]))
                ) {
                    best = [w, n];
                }
            }
            longer.set(key, best !== null && best[1] > (counts.get(key) ?? 0) ? best[0].slice(-1) : null);
        }
        return longer.get(key) ?? null;
    };
    const lines = new Map<string, IRTextRun[]>();
    for (const r of ir.runs) {
        const key = `${r.pageIndex}:${r.y}`;
        lines.set(key, [...(lines.get(key) ?? []), r]);
    }
    const fixed = new Map<IRTextRun, string>();
    for (const runs of lines.values()) {
        const sorted = [...runs].sort((a, b) => a.x - b.x);
        sorted.forEach((run, i) => {
            const next = sorted[i + 1];
            const stem = PAIR_END.exec(run.text)?.[1];
            if (
                stem === undefined ||
                next === undefined ||
                next.text !== "" ||
                next.width < LOST_GLYPH_EMS * run.size ||
                Math.abs(next.x - (run.x + run.width)) > TOUCHING
            ) {
                return;
            }
            const letter = restored(stem);
            if (letter !== null) {
                fixed.set(run, `${run.text}${letter}`);
            }
        });
    }
    if (fixed.size === 0) {
        return ir;
    }
    return { ...ir, runs: ir.runs.map((r) => (fixed.has(r) ? { ...r, text: fixed.get(r) ?? r.text } : r)) };
}

/**
 * Some text layers map their "fi"/"fl" ligature glyphs to the two letters and
 * a space ("signifi cantly", "fl ame"). A document whose text sets that space
 * after most of its fi/fl pairs does so for all of them, and its words are
 * joined again; a document that splits only a few (a name ending on the pair,
 * a lost letter) is left as it is.
 */
export function withLigaturesJoined(ir: IR): IR {
    const text = ir.runs.map((r) => r.text).join("\n");
    const split = text.match(SPLIT)?.length ?? 0;
    const whole = text.match(WHOLE)?.length ?? 0;
    if (split <= whole) {
        return ir;
    }
    return {
        ...ir,
        runs: ir.runs.map((r) => {
            const joined = r.text.replace(SPLIT, "$1");
            return joined === r.text ? r : { ...r, text: joined };
        }),
    };
}
