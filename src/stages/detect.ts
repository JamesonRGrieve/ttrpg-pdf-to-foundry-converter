// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DocMeta, IR } from "../types/ir.ts";
import type { FingerprintSpec, Profile } from "../types/profile.ts";
import { sizeEquals } from "../util/rounding.ts";

/**
 * Stage 4 — Detect (spec §7). Detection SUGGESTS; the user CONFIRMS. The engine
 * never auto-applies a profile and holds no built-in fingerprints — every
 * candidate's `fingerprint` block comes from a user-supplied profile, and we
 * only score similarity.
 *
 * Signal A (metadata) is surfaced verbatim and never matched against any
 * internal list (there is none). Signal B (structural fingerprint) uses only
 * content-agnostic layout descriptors (§7.2) — never text content, never a
 * signal chosen to resist watermarking (C3).
 */

export interface ProfileSuggestion {
    profileId: string;
    name: string;
    /** 0..1 fingerprint similarity. */
    score: number;
}

export interface DetectionResult {
    metadata: DocMeta;
    suggestions: ProfileSuggestion[];
}

function scoreFingerprint(fp: FingerprintSpec | undefined, ir: IR): number {
    if (fp === undefined) {
        return 0;
    }
    const parts: number[] = [];

    if (fp.page_size !== undefined) {
        const tol = fp.page_size.tol;
        const match = ir.fingerprint.pageSizes.some(
            (ps) => Math.abs(ps.w - fp.page_size!.w) <= tol && Math.abs(ps.h - fp.page_size!.h) <= tol,
        );
        parts.push(match ? 1 : 0);
    }

    if (fp.columns !== undefined) {
        parts.push(fp.columns === ir.fingerprint.columns ? 1 : 0);
    }

    if (fp.fonts !== undefined && fp.fonts.length > 0) {
        const present = new Set(ir.fingerprint.fonts);
        const hits = fp.fonts.filter((f) => present.has(f.toLowerCase())).length;
        parts.push(hits / fp.fonts.length);
    }

    if (fp.size_buckets !== undefined && fp.size_buckets.length > 0) {
        const hits = fp.size_buckets.filter((s) => ir.sizeBuckets.some((b) => sizeEquals(b, s))).length;
        parts.push(hits / fp.size_buckets.length);
    }

    if (parts.length === 0) {
        return 0;
    }
    return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function detect(ir: IR, profiles: readonly Profile[]): DetectionResult {
    const suggestions: ProfileSuggestion[] = profiles
        .map((p) => ({
            profileId: p.profile_id,
            name: p.name,
            score: Number(scoreFingerprint(p.fingerprint, ir).toFixed(4)),
        }))
        .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.profileId < b.profileId ? -1 : 1));
    return { metadata: ir.meta, suggestions };
}
