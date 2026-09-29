// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalizeText } from "../../src/util/text.ts";

/**
 * Order-agnostic text accuracy: multiset (bag-of-words) precision / recall / F1
 * of a candidate reading against a reference transcription. Reading order is
 * deliberately ignored — column interleaving is a layout concern the structural
 * stages handle, not a recognition error — so this scores only whether the right
 * words were read.
 */

export interface BagScore {
    matched: number;
    candidate: number;
    reference: number;
}

const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

export function tokens(text: string, caseSensitive: boolean): string[] {
    const canon = canonicalizeText(text);
    const out: string[] = [];
    for (const raw of canon.split(/\s+/u)) {
        const t = raw.replace(EDGE_PUNCT, "");
        if (t.length > 0) {
            out.push(caseSensitive ? t : t.toLowerCase());
        }
    }
    return out;
}

function bag(items: readonly string[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const i of items) {
        m.set(i, (m.get(i) ?? 0) + 1);
    }
    return m;
}

export function scoreBag(candidate: readonly string[], reference: readonly string[]): BagScore {
    const ref = bag(reference);
    let matched = 0;
    for (const [tok, n] of bag(candidate)) {
        matched += Math.min(n, ref.get(tok) ?? 0);
    }
    return { matched, candidate: candidate.length, reference: reference.length };
}

export function addScores(a: BagScore, b: BagScore): BagScore {
    return {
        matched: a.matched + b.matched,
        candidate: a.candidate + b.candidate,
        reference: a.reference + b.reference,
    };
}

export function f1(s: BagScore): { precision: number; recall: number; f1: number } {
    const precision = s.candidate === 0 ? 0 : s.matched / s.candidate;
    const recall = s.reference === 0 ? 0 : s.matched / s.reference;
    return {
        precision,
        recall,
        f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    };
}

/** Reduce a markdown/HTML transcription page to its plain words. */
export function markdownToText(md: string): string {
    return md
        .replace(/^---\n[\s\S]*?\n---\n/u, "")
        .replace(/<!--[\s\S]*?-->/gu, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/<[^>]+>/gu, " ")
        .replace(/&nbsp;/gu, " ")
        .replace(/&amp;/gu, "&")
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .replace(/&quot;/gu, '"')
        .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
        .replace(/^\s*>\s?/gmu, "")
        .replace(/^\s*[-*+]\s+/gmu, "")
        .replace(/[*_`|]+/gu, " ");
}
