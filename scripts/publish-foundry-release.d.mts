// SPDX-License-Identifier: AGPL-3.0-or-later
/** Types for `publish-foundry-release.mjs`. */

export const RELEASE_API: string;

export function foundryReleaseBody(
    manifest: {
        id: string;
        version: string;
        compatibility?: { minimum?: string | number; verified?: string | number; maximum?: string | number };
    },
    opts: { repoUrl: string; tag: string; dryRun: boolean },
): {
    id: string;
    "dry-run": boolean;
    release: {
        version: string;
        manifest: string;
        notes: string;
        compatibility: { minimum?: string; verified?: string; maximum?: string };
    };
};
