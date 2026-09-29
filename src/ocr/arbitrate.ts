// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RawDoc, RawTextRun } from "../types/ir.ts";
import { at } from "../util/at.ts";
import { numAsc } from "../util/ordered.ts";
import { stripSubsetPrefix } from "../util/text.ts";
import type { OcrPage, OcrWord, PdfBox } from "./types.ts";

/**
 * Cross-reference the PDF text layer against OCR and produce a corrected text
 * layer. The text layer is exact when it is intact, so it is the default; OCR
 * overrides it only where the text layer demonstrably fails.
 *
 * Method, per page:
 *  1. Group text runs into LINES by baseline. Runs that touch (no inter-run gap)
 *     are joined without a space, so glyph runs split by the PDF producer — a
 *     ligature painted as its own run, a drop cap — form one word.
 *  2. Assign each OCR word to the line it overlaps most vertically.
 *  3. ALIGN each line's tokens with its OCR words (both left→right) by dynamic
 *     programming over normalized edit distance, allowing one token to match
 *     several OCR words and several tokens to match one OCR word, so
 *     letter-spaced display text ("s a m p l e") aligns with the printed word.
 *  4. Resolve each aligned group:
 *     - SAME letters (ignoring case and spacing): keep the text layer's letters
 *       but adopt OCR's word boundaries; take OCR's casing only when the text
 *       layer's casing is anomalous (lower→upper inside a word).
 *     - DIFFERENT letters: OCR replaces the tokens only when they carry
 *       corruption markers (control characters, private-use or replacement
 *       glyphs, code points from a custom font encoding) and OCR is confident.
 *  5. OCR words on no text-layer line (text painted as outlines or embedded in
 *     an image) are inserted as new runs when confident.
 *
 * Every rule is structural — geometry, character classes, edit distance,
 * confidence — with no knowledge of what the document says. All iteration
 * orders are geometric, so identical inputs give identical output.
 */

/** Minimum OCR confidence to replace corrupted text-layer letters. */
export const REPLACE_CONFIDENCE = 60;
/** Minimum OCR confidence to insert a word where the text layer has nothing. */
export const INSERT_CONFIDENCE = 85;
export const OCR_FONT_NAME = "ocr-recovered";

/** Glyph box of a run relative to its baseline, as fractions of the font size. */
const DESCENT_FRACTION = 0.22;
const ASCENT_FRACTION = 0.78;
/** Runs whose baselines differ by at most this fraction of the font size share a line. */
const BASELINE_TOLERANCE = 0.3;
/** A horizontal gap below this fraction of the font size joins two runs without a space. */
const JOIN_GAP_FRACTION = 0.12;
/** Horizontal slack when deciding an OCR word lies within a line's extent. */
const LINE_X_SLACK_FRACTION = 0.5;
/** Largest many-to-one merge the aligner considers (a letter-spaced word's letters). */
const MAX_MERGE = 16;
/** Aligned pairs further apart than this normalized edit distance are not a match. */
const MAX_MATCH_DISTANCE = 0.34;
/** A horizontal gap above this multiple of the font size splits a baseline into separate lines (columns, table cells). */
const LINE_SPLIT_GAP_FRACTION = 1.5;
const SKIP_COST = 1;
/** Render order for inserted OCR runs: after every text-layer run. */
const INSERTED_RENDER_ORDER_BASE = 1_000_000;
/**
 * A font face is a small-caps display face when at least this many of its
 * tokens, and at least this share of them, are small-caps evidence (see
 * `smallCapsFonts`).
 */
const SMALL_CAPS_MIN_TOKENS = 20;
const SMALL_CAPS_MIN_SHARE = 0.05;
/**
 * A line whose characters are at least this share corruption markers is
 * unrecoverable token-by-token (a custom encoding usually corrupts the spaces
 * too, fusing the line into one token), so its OCR reading replaces it whole.
 */
const CORRUPT_LINE_SHARE = 0.1;

// Code points that indicate a broken or custom font encoding: control
// characters, private-use glyphs, the replacement character, or anything
// outside the scripts and symbol blocks ordinary body text uses.
const CONTROL_RANGES = String.raw`\u0000-\u0008\u000B-\u001F\u007F`;
const PRIVATE_USE_RANGE = String.raw`\uE000-\uF8FF`;
const REPLACEMENT_CHAR = String.raw`\uFFFD`;
const EXPECTED_RANGES = String.raw`\u0000-\u024F\u02B0-\u02FF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u23FF\u2500-\u27BF`;
const CORRUPTION = new RegExp(
    `[${CONTROL_RANGES}${PRIVATE_USE_RANGE}${REPLACEMENT_CHAR}]|[^${EXPECTED_RANGES}]`,
    "u",
);
const ANOMALOUS_CASE = /\p{Ll}\p{Lu}/u;
const STARTS_LOWERCASE = /^[^\p{L}]*\p{Ll}/u;

function isSmallCapsEvidence(token: string): boolean {
    return STARTS_LOWERCASE.test(token) && ANOMALOUS_CASE.test(token);
}
const HAS_ALNUM = /[\p{L}\p{N}]/u;

interface Segment {
    run: number;
    start: number;
    end: number;
}

interface Token {
    text: string;
    segments: Segment[];
}

interface Line {
    runs: number[];
    box: PdfBox;
    size: number;
    tokens: Token[];
}

function runBox(run: RawTextRun): PdfBox {
    return [
        run.x,
        run.y - DESCENT_FRACTION * run.fontSize,
        run.x + run.width,
        run.y + ASCENT_FRACTION * run.fontSize,
    ];
}

/** The horizontal extent of text segments, placing characters proportionally within their runs. */
function tokenExtent(segments: readonly Segment[], runs: readonly RawTextRun[]): [number, number] {
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    for (const s of segments) {
        const run = at(runs, s.run);
        const perChar = run.text.length > 0 ? run.width / run.text.length : 0;
        x0 = Math.min(x0, run.x + s.start * perChar);
        x1 = Math.max(x1, run.x + s.end * perChar);
    }
    return [x0, x1];
}

function squash(text: string): string {
    return text.replace(/\s+/gu, "").toLowerCase();
}

/** Levenshtein distance normalized by the longer string (0 = identical, 1 = disjoint). */
export function normalizedDistance(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    const n = a.length;
    const m = b.length;
    if (n === 0 || m === 0) {
        return 1;
    }
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i += 1) {
        const cur = [i];
        for (let j = 1; j <= m; j += 1) {
            const sub = at(prev, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1);
            cur.push(Math.min(sub, at(prev, j) + 1, at(cur, j - 1) + 1));
        }
        prev = cur;
    }
    return at(prev, m) / Math.max(n, m);
}

/** Group a page's runs into baseline lines, left→right, with space-aware tokens. */
function buildLines(runs: readonly RawTextRun[]): Line[] {
    const order = runs
        .map((_, i) => i)
        .filter((i) => at(runs, i).text.length > 0 && at(runs, i).width > 0)
        .sort(
            (a, b) =>
                numAsc(at(runs, b).y, at(runs, a).y) || numAsc(at(runs, a).x, at(runs, b).x) || numAsc(a, b),
        );

    const lines: { runs: number[]; baseline: number; size: number }[] = [];
    for (const i of order) {
        const run = at(runs, i);
        const line = lines.find(
            (l) => Math.abs(l.baseline - run.y) <= BASELINE_TOLERANCE * Math.max(l.size, run.fontSize),
        );
        if (line === undefined) {
            lines.push({ runs: [i], baseline: run.y, size: run.fontSize });
        } else {
            line.runs.push(i);
            line.size = Math.max(line.size, run.fontSize);
        }
    }

    // Split each baseline at wide horizontal gaps: two columns, or two table
    // cells, share baselines but are never one line of text.
    const segments: { runs: number[]; size: number }[] = [];
    for (const l of lines) {
        const members = [...l.runs].sort((a, b) => numAsc(at(runs, a).x, at(runs, b).x) || numAsc(a, b));
        let current: number[] = [];
        let prevEnd = Number.NEGATIVE_INFINITY;
        for (const index of members) {
            const run = at(runs, index);
            if (current.length > 0 && run.x - prevEnd > LINE_SPLIT_GAP_FRACTION * l.size) {
                segments.push({ runs: current, size: l.size });
                current = [];
            }
            current.push(index);
            prevEnd = Math.max(prevEnd, run.x + run.width);
        }
        segments.push({ runs: current, size: l.size });
    }

    return segments.map((l) => {
        const members = l.runs;
        const tokens: Token[] = [];
        let current: Token | null = null;
        let prevEnd = Number.NEGATIVE_INFINITY;
        let x0 = Number.POSITIVE_INFINITY;
        let y0 = Number.POSITIVE_INFINITY;
        let x1 = Number.NEGATIVE_INFINITY;
        let y1 = Number.NEGATIVE_INFINITY;
        for (const index of members) {
            const run = at(runs, index);
            const box = runBox(run);
            x0 = Math.min(x0, box[0]);
            y0 = Math.min(y0, box[1]);
            x1 = Math.max(x1, box[2]);
            y1 = Math.max(y1, box[3]);
            // A visible gap between runs is a word break even without a space character.
            if (run.x - prevEnd > JOIN_GAP_FRACTION * l.size) {
                current = null;
            }
            prevEnd = run.x + run.width;
            for (let c = 0; c < run.text.length; c += 1) {
                if (/\s/u.test(run.text.charAt(c))) {
                    current = null;
                    continue;
                }
                if (current === null) {
                    current = { text: "", segments: [] };
                    tokens.push(current);
                }
                current.text += run.text[c];
                const last = current.segments[current.segments.length - 1];
                if (last !== undefined && last.run === index && last.end === c) {
                    last.end = c + 1;
                } else {
                    current.segments.push({ run: index, start: c, end: c + 1 });
                }
            }
        }
        return { runs: members, box: [x0, y0, x1, y1] as const, size: l.size, tokens };
    });
}

/** Assign every OCR word to the line it overlaps most vertically; the rest are line-less. */
function assignWords(
    lines: readonly Line[],
    words: readonly OcrWord[],
): { perLine: OcrWord[][]; lineless: OcrWord[] } {
    const perLine: OcrWord[][] = lines.map(() => []);
    const lineless: OcrWord[] = [];
    for (const word of words) {
        let best = -1;
        let bestOverlap = 0;
        lines.forEach((line, i) => {
            const slack = LINE_X_SLACK_FRACTION * line.size;
            if (word.box[2] < line.box[0] - slack || word.box[0] > line.box[2] + slack) {
                return;
            }
            const overlap = Math.min(word.box[3], line.box[3]) - Math.max(word.box[1], line.box[1]);
            if (overlap > bestOverlap) {
                best = i;
                bestOverlap = overlap;
            }
        });
        if (best >= 0) {
            at(perLine, best).push(word);
        } else {
            lineless.push(word);
        }
    }
    for (const list of perLine) {
        list.sort((a, b) => numAsc(a.box[0], b.box[0]) || numAsc(a.box[2], b.box[2]));
    }
    return { perLine, lineless };
}

export interface AlignedGroup {
    tokens: number[];
    words: number[];
}

/**
 * Minimum-cost monotone alignment of text tokens to OCR words. A match joins
 * 1..MAX_MERGE tokens to one word, or one token to 1..MAX_MERGE words; unmatched
 * items cost SKIP_COST each.
 */
export function align(tokens: readonly string[], words: readonly string[]): AlignedGroup[] {
    const n = tokens.length;
    const m = words.length;
    const cost: number[][] = Array.from({ length: n + 1 }, () =>
        new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY),
    );
    const back: ([number, number] | null)[][] = Array.from({ length: n + 1 }, () =>
        new Array<[number, number] | null>(m + 1).fill(null),
    );
    at(cost, 0)[0] = 0;
    for (let i = 0; i <= n; i += 1) {
        for (let j = 0; j <= m; j += 1) {
            const here = at(at(cost, i), j);
            if (!Number.isFinite(here)) {
                continue;
            }
            const relax = (ni: number, nj: number, c: number): void => {
                const row = at(cost, ni);
                if (here + c < at(row, nj)) {
                    row[nj] = here + c;
                    at(back, ni)[nj] = [i, j];
                }
            };
            if (i < n) {
                relax(i + 1, j, SKIP_COST);
            }
            if (j < m) {
                relax(i, j + 1, SKIP_COST);
            }
            for (let a = 1; a <= MAX_MERGE && i + a <= n; a += 1) {
                for (let b = 1; b <= MAX_MERGE && j + b <= m; b += 1) {
                    if (a > 1 && b > 1) {
                        break;
                    }
                    const d = normalizedDistance(
                        squash(tokens.slice(i, i + a).join("")),
                        squash(words.slice(j, j + b).join("")),
                    );
                    if (d <= MAX_MATCH_DISTANCE) {
                        relax(i + a, j + b, d);
                    }
                }
            }
        }
    }
    const groups: AlignedGroup[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        // Every reachable cell but the origin records the step into it.
        const prev = at(at(back, i), j);
        if (prev === null) {
            break;
        }
        const [pi, pj] = prev;
        if (i - pi > 0 && j - pj > 0) {
            groups.push({
                tokens: Array.from({ length: i - pi }, (_, k) => pi + k),
                words: Array.from({ length: j - pj }, (_, k) => pj + k),
            });
        }
        i = pi;
        j = pj;
    }
    return groups.reverse();
}

/**
 * Typographic ligatures and the shorter spellings a text layer can map their
 * single glyph to (a lost letter, or the whole glyph).
 */
const LIGATURE_REDUCTIONS: readonly [string, readonly string[]][] = [
    ["ffi", ["fi", "ff", "f", ""]],
    ["ffl", ["fl", "ff", "f", ""]],
    ["ff", ["f", ""]],
    ["fi", ["f", "i", ""]],
    ["fl", ["f", "l", ""]],
];

/**
 * Whether the text layer's word is OCR's word with one ligature glyph mapped
 * to fewer letters ("ofers" for "offers"): the layer lost a glyph, OCR did not.
 */
export function lostLigature(layer: string, ocr: string): boolean {
    if (layer === ocr) {
        return false;
    }
    for (const [ligature, reductions] of LIGATURE_REDUCTIONS) {
        for (let at = ocr.indexOf(ligature); at >= 0; at = ocr.indexOf(ligature, at + 1)) {
            const before = ocr.slice(0, at);
            const after = ocr.slice(at + ligature.length);
            if (reductions.some((r) => `${before}${r}${after}` === layer)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * The corrected text for an aligned group, or null to keep the text layer.
 * `spansRuns` forces a rewrite (to the text layer's own letters) when a word is
 * split across several runs, so the corrected layer carries it as one word.
 */
export function resolveGroup(
    textLayer: readonly string[],
    ocr: readonly OcrWord[],
    spansRuns: boolean,
): string | null {
    const joined = textLayer.join("");
    const ocrText = ocr.map((w) => w.text).join(" ");
    // Several text-layer words read by OCR as one word: a real join only when
    // they are letter-spacing or a split initial (all but one are single
    // characters). Two full words are two words, whatever OCR's segmentation.
    const multiChar = textLayer.filter((t) => [...t].length > 1).length;
    if (textLayer.length > 1 && ocr.length === 1 && multiChar > 1) {
        return null;
    }
    if (squash(joined) === squash(ocrText)) {
        const replacement = ANOMALOUS_CASE.test(joined) ? ocrText : matchSpacing(joined, ocrText);
        const rewrites = textLayer.length > 1 || ocr.length > 1 || spansRuns || replacement !== joined;
        return rewrites ? replacement : null;
    }
    const confidence = Math.min(...ocr.map((w) => w.confidence));
    if (textLayer.some((t) => CORRUPTION.test(t)) && confidence >= REPLACE_CONFIDENCE) {
        return ocrText;
    }
    if (confidence >= REPLACE_CONFIDENCE && lostLigature(joined, ocrText)) {
        return ocrText;
    }
    // Letters disagree and the text layer looks intact: keep it. A single token
    // split across touching runs is still unified — the gap test already
    // established it is one printed word.
    return spansRuns && textLayer.length === 1 ? joined : null;
}

/** Re-space `letters` (the text layer's exact characters) at `pattern`'s word breaks. */
function matchSpacing(letters: string, pattern: string): string {
    let out = "";
    let k = 0;
    for (const ch of pattern) {
        if (/\s/u.test(ch)) {
            out += " ";
            continue;
        }
        out += letters[k] ?? "";
        k += 1;
    }
    return out + letters.slice(k);
}

interface Edit {
    start: number;
    end: number;
    replacement: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
    let out = text;
    for (const e of [...edits].sort((a, b) => numAsc(b.start, a.start))) {
        out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    }
    return out;
}

function arbitratePage(runs: readonly RawTextRun[], page: OcrPage, pageIndex: number): RawTextRun[] {
    const lines = buildLines(runs);
    const words = [...page.words].sort((a, b) => numAsc(b.box[3], a.box[3]) || numAsc(a.box[0], b.box[0]));
    const { perLine, lineless } = assignWords(lines, words);

    const edits = new Map<number, Edit[]>();
    /** Host run → runs that donated text to it. */
    const donors = new Map<number, Set<number>>();
    const pushEdit = (run: number, edit: Edit): void => {
        const list = edits.get(run) ?? [];
        list.push(edit);
        edits.set(run, list);
    };

    const rewrite = (segments: readonly Segment[], replacement: string): void => {
        const charsByRun = new Map<number, number>();
        for (const s of segments) {
            charsByRun.set(s.run, (charsByRun.get(s.run) ?? 0) + (s.end - s.start));
        }
        const [host] = at(
            [...charsByRun.entries()].sort((a, b) => numAsc(b[1], a[1]) || numAsc(a[0], b[0])),
            0,
        );
        const hostSegments = segments.filter((s) => s.run === host);
        pushEdit(host, {
            start: Math.min(...hostSegments.map((s) => s.start)),
            end: Math.max(...hostSegments.map((s) => s.end)),
            replacement,
        });
        const given = donors.get(host) ?? new Set<number>();
        for (const s of segments) {
            if (s.run !== host) {
                pushEdit(s.run, { start: s.start, end: s.end, replacement: "" });
                given.add(s.run);
            }
        }
        donors.set(host, given);
    };

    lines.forEach((line, li) => {
        const lineWords = at(perLine, li);
        const lineText = line.tokens.map((t) => t.text).join("");
        const corrupt = [...lineText].filter((ch) => CORRUPTION.test(ch)).length;
        if (lineText.length > 0 && corrupt / lineText.length >= CORRUPT_LINE_SHARE) {
            const confident = lineWords.filter((w) => w.confidence >= REPLACE_CONFIDENCE);
            if (confident.length > 0) {
                rewrite(
                    line.tokens.flatMap((t) => t.segments),
                    confident.map((w) => w.text).join(" "),
                );
            }
            return;
        }
        const groups = align(
            line.tokens.map((t) => t.text),
            lineWords.map((w) => w.text),
        );
        for (const group of groups) {
            const tokens = group.tokens.map((t) => at(line.tokens, t));
            const segments = tokens.flatMap((t) => t.segments);
            const spansRuns = new Set(segments.map((s) => s.run)).size > 1;
            const replacement = resolveGroup(
                tokens.map((t) => t.text),
                group.words.map((w) => at(lineWords, w)),
                spansRuns,
            );
            if (replacement !== null) {
                rewrite(segments, replacement);
            }
        }
        // A corrupt token too garbled to align with any word (a shifted font
        // encoding) takes the unaligned OCR words printed over it.
        const usedTokens = new Set(groups.flatMap((g) => g.tokens));
        const usedWords = new Set(groups.flatMap((g) => g.words));
        line.tokens.forEach((token, ti) => {
            // Only the garbled part: a broken encoding's word break is itself a
            // garbled character, so the token can run on into clean text.
            const garbled = token.segments.filter((s) =>
                CORRUPTION.test(at(runs, s.run).text.slice(s.start, s.end)),
            );
            if (usedTokens.has(ti) || garbled.length === 0) {
                return;
            }
            const [x0, x1] = tokenExtent(garbled, runs);
            const slack = LINE_X_SLACK_FRACTION * line.size;
            const over = lineWords
                .map((word, wi) => ({ word, wi }))
                .filter(({ word, wi }) => {
                    const centre = (word.box[0] + word.box[2]) / 2;
                    return (
                        !usedWords.has(wi) &&
                        word.confidence >= REPLACE_CONFIDENCE &&
                        centre >= x0 - slack &&
                        centre <= x1 + slack
                    );
                });
            if (over.length > 0) {
                for (const { wi } of over) {
                    usedWords.add(wi);
                }
                rewrite(garbled, over.map(({ word }) => word.text).join(" "));
            }
        });
    });

    const texts = runs.map((run, index) => {
        const runEdits = edits.get(index);
        return runEdits === undefined ? run.text : applyEdits(run.text, runEdits).replace(/\s{2,}/gu, " ");
    });
    const consumed = (index: number): boolean => at(texts, index).trim().length === 0;

    const out: RawTextRun[] = [];
    runs.forEach((run, index) => {
        if (!edits.has(index)) {
            out.push(run);
            return;
        }
        if (consumed(index)) {
            return;
        }
        // A host takes over the extent of donor runs it absorbed whole (a drop
        // cap, small capitals after an initial, a ligature piece), never of a
        // run that survives beside it; the merged word is set in the size that
        // carries most of its letters, not its initial's.
        const pieces = [run, ...[...(donors.get(index) ?? [])].filter(consumed).map((d) => at(runs, d))];
        const x = Math.min(...pieces.map((p) => p.x));
        const right = Math.max(...pieces.map((p) => p.x + p.width));
        const lettersBySize = new Map<number, number>();
        for (const p of pieces) {
            lettersBySize.set(p.fontSize, (lettersBySize.get(p.fontSize) ?? 0) + p.text.trim().length);
        }
        const [[fontSize] = [run.fontSize]] = [...lettersBySize].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        out.push({ ...run, text: at(texts, index), x, width: right - x, fontSize });
    });

    let inserted = 0;
    for (const word of lineless) {
        if (word.confidence < INSERT_CONFIDENCE || !HAS_ALNUM.test(word.text)) {
            continue;
        }
        const [x0, y0, x1, y1] = word.box;
        const size = y1 - y0;
        out.push({
            pageIndex,
            x: x0,
            y: y0 + DESCENT_FRACTION * size,
            width: x1 - x0,
            height: size,
            text: word.text,
            fontName: OCR_FONT_NAME,
            fontSize: size,
            weight: "normal",
            italic: false,
            renderOrder: INSERTED_RENDER_ORDER_BASE + inserted,
        });
        inserted += 1;
    }
    return out;
}

/**
 * Font faces whose text is set in small capitals, discovered from the text layer
 * itself. Such faces encode small-cap glyphs as lowercase code points and full
 * capitals as uppercase, and set each word's initial as a separate larger run —
 * so their tokens START lowercase and then turn uppercase ("xaMPlE", "eaDinG").
 * Mixed-case abbreviations ("AgB", "RoF") start uppercase and are not evidence.
 * Evidence is pooled per face (subset prefix stripped). Printed small caps read
 * as capitals, so a small-caps face's text is uppercased.
 */
export function smallCapsFonts(runs: readonly RawTextRun[]): Set<string> {
    const stats = new Map<string, { tokens: number; evidence: number }>();
    for (const run of runs) {
        const face = stripSubsetPrefix(run.fontName);
        const s = stats.get(face) ?? { tokens: 0, evidence: 0 };
        for (const token of run.text.split(/\s+/u)) {
            // A custom-encoded token's shifted letters are not case evidence.
            if (!/\p{L}/u.test(token) || CORRUPTION.test(token)) {
                continue;
            }
            s.tokens += 1;
            if (isSmallCapsEvidence(token)) {
                s.evidence += 1;
            }
        }
        stats.set(face, s);
    }
    const faces = new Set<string>();
    for (const [face, s] of stats) {
        if (s.evidence >= SMALL_CAPS_MIN_TOKENS && s.evidence / s.tokens >= SMALL_CAPS_MIN_SHARE) {
            faces.add(face);
        }
    }
    return faces;
}

/** Return a copy of `raw` whose text layer is corrected against `ocr`. */
export function arbitrate(raw: RawDoc, ocr: readonly OcrPage[]): RawDoc {
    const ocrByPage = new Map(ocr.map((p) => [p.pageIndex, p] as const));
    const runsByPage = new Map<number, RawTextRun[]>();
    for (const run of raw.textRuns) {
        const list = runsByPage.get(run.pageIndex) ?? [];
        list.push(run);
        runsByPage.set(run.pageIndex, list);
    }
    const textRuns: RawTextRun[] = [];
    for (const page of [...raw.pages].sort((a, b) => numAsc(a.pageIndex, b.pageIndex))) {
        const runs = runsByPage.get(page.pageIndex) ?? [];
        const ocrPage = ocrByPage.get(page.pageIndex);
        textRuns.push(...(ocrPage === undefined ? runs : arbitratePage(runs, ocrPage, page.pageIndex)));
    }
    const smallCaps = smallCapsFonts(raw.textRuns);
    return {
        ...raw,
        textRuns: textRuns.map((run) =>
            smallCaps.has(stripSubsetPrefix(run.fontName)) ? { ...run, text: run.text.toUpperCase() } : run,
        ),
    };
}
