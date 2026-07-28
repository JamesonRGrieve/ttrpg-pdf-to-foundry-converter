// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Version constants that participate in determinism and cache keying.
 *
 * `ENGINE_VERSION` and `IR_VERSION` are inputs to `f(complete_pdf, profile,
 * engine_version) -> output corpus` (spec §2.1) and to the intermediate cache
 * key (spec §2.2). Bump `IR_VERSION` on any change to the normalization rules
 * in §5.1-5.4; bump `RESOLVER_VERSION` on any change to the enrichment ranking
 * function (§10.4). `SUPPORTED_SCHEMA_MAJORS` gates the profile DSL (§8.1).
 */
export const ENGINE_VERSION = "0.1.0";
export const IR_VERSION = 1;
export const RESOLVER_VERSION = 1;
export const SUPPORTED_SCHEMA_MAJORS: readonly number[] = [1];
