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
export const RELEASE = "2026-11-14-18-07";
export const ENGINE_VERSION = "0.2.0";
export const IR_VERSION = 57;

/**
 * The Foundry package's version for a release stamp, as semver Foundry's
 * package listing and the release tags (`v<version>`) take:
 * `<year>.<month and day>.<hour and minute>` with leading zeros dropped
 * (2026-01-05-09-05 → 2026.105.905). Later releases compare higher.
 */
export function packageVersion(release: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/u.exec(release);
    if (m === null) {
        throw new Error(`release stamp must be YYYY-MM-DD-HH-MM, got ${JSON.stringify(release)}`);
    }
    const [, year, month, day, hour, minute] = m;
    return `${Number(year)}.${Number(`${month}${day}`)}.${Number(`${hour}${minute}`)}`;
}

/** Where the latest release is published, as `{"release": "<RELEASE>"}`. */
export const RELEASE_FEED_URL =
    "https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/release.json";
/** The converter's page, where a module can be built again. */
export const CONVERTER_URL = "https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/";
