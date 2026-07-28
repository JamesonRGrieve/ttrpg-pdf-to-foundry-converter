// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic filename slug (spec §9.3). Emitted pack files are named
 * `<name-slug>_<_id>.json`, matching the convention the existing pack tooling
 * round-trips cleanly. The slug is derived purely from the entity name via a
 * fixed transform — no locale, no randomness.
 */
export function slugify(name: string): string {
    const slug = name
        .normalize("NFKD")
        // Strip combining diacritical marks left by NFKD decomposition.
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    return slug.length > 0 ? slug : "entry";
}
