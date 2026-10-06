// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Version constants that participate in determinism and cache keying.
 *
 * Output is a function of `(complete PDF, release, pinned renderer/OCR
 * builds)`.
 *
 * - `RELEASE` is the converter's release, `YYYY-MM-DD-HH-MM` (24-hour, UTC):
 *   when it was cut. Bump it on any change that can alter output. It is the
 *   version of every module the converter writes, is recorded in each module
 *   and pack, and is published beside the web page so a module can tell when
 *   a newer converter exists. The stamps compare in time order as strings.
 * - `ENGINE_VERSION` keys the IR cache: bump it only when cached IR may no
 *   longer be reused (with `IR_VERSION`, on any change to normalization or to
 *   the OCR arbitration that feeds it).
 */
export const RELEASE = "2026-10-06-20-11";
export const ENGINE_VERSION = "0.2.0";
export const IR_VERSION = 41;

/** Where the latest release is published, as `{"release": "<RELEASE>"}`. */
export const RELEASE_FEED_URL =
    "https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/release.json";
/** The converter's page, where a module can be built again. */
export const CONVERTER_URL = "https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/";
