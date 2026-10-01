// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Version constants that participate in determinism and cache keying.
 *
 * Output is a function of `(complete PDF, engine version, pinned renderer/OCR
 * builds)`. Bump `ENGINE_VERSION` on any change that can alter output; bump
 * `IR_VERSION` on any change to normalization or to the OCR arbitration that
 * feeds it, so cached IR is never reused across such a change.
 */
export const ENGINE_VERSION = "0.2.0";
export const IR_VERSION = 34;
