// SPDX-License-Identifier: AGPL-3.0-or-later
/** Types for `prepare-release-manifest.mjs`. */

export function releaseFields(
    builtVersion: string,
    opts: { channel: string; run?: string; tag?: string; repoUrl: string },
): { version: string; manifest: string; download: string };
