// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A profile panel: `LABEL: value` cells, several to a line, drawn from a fixed
 * set of schema labels. A value runs to the next label on its line.
 */

export interface LabelPanel {
    labels: readonly string[];
    pattern: RegExp;
}

/**
 * A panel over `labels` (lower case; a space matches any run of whitespace).
 * Longer labels are tried first, so "crew rating" is not read as "crew".
 * With `colonOptional`, a label may drop its colon when a number follows it
 * directly ("REAR 16").
 */
export function labelPanel(labels: readonly string[], colonOptional = false): LabelPanel {
    const alternatives = [...labels]
        .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
        .map((l) => l.replace(/ /gu, "\\s+"))
        .join("|");
    const separator = colonOptional ? "(?:\\s*:\\s*|\\s+(?=[+-]?\\d))" : "\\s*:\\s*";
    return { labels, pattern: new RegExp(`(?<![\\p{L}])(${alternatives})${separator}`, "giu") };
}

/**
 * `label → value` pairs of a panel's text, keyed by lower-cased label (first
 * occurrence wins). With `bounded`, a value is kept only when another label
 * ends it on its line: the last value on a line of running text may run on
 * into prose.
 */
export function labelPairs(text: string, panel: LabelPanel, bounded = false): Map<string, string> {
    const pairs = new Map<string, string>();
    for (const line of text.split("\n")) {
        const hits = [...line.matchAll(panel.pattern)];
        hits.forEach((m, i) => {
            const next = hits[i + 1];
            if (bounded && next === undefined) {
                return;
            }
            const label = (m[1] ?? "").toLowerCase().replace(/\s+/gu, " ");
            const value = line
                .slice(m.index + m[0].length, next?.index ?? line.length)
                .replace(/\s+/gu, " ")
                .trim();
            if (!pairs.has(label)) {
                pairs.set(label, value);
            }
        });
    }
    return pairs;
}
