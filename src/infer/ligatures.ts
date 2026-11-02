// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";

/** An "fi" or "fl" pair followed by a space and a lower-case letter: a ligature set with a space after it. */
const SPLIT = /(fi|fl) (?=\p{Ll})/gu;
/** An "fi" or "fl" pair running on into a lower-case letter: a ligature read whole. */
const WHOLE = /(?:fi|fl)\p{Ll}/gu;

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
