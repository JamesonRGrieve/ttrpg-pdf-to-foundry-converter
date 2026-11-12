// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { releaseFields } from "../../scripts/prepare-release-manifest.mjs";
import { foundryReleaseBody } from "../../scripts/publish-foundry-release.mjs";
import { packageVersion } from "../../src/version.ts";

const REPO = "https://github.com/owner/repo";

describe("the package version of a release stamp", () => {
    it("is year.monthday.hourminute without leading zeros, ordering later releases higher", () => {
        expect(packageVersion("2026-11-11-13-50")).toBe("2026.1111.1350");
        expect(packageVersion("2026-01-05-09-05")).toBe("2026.105.905");
        expect(packageVersion("2027-01-01-00-00")).toBe("2027.101.0");
    });

    it("refuses a stamp of another shape", () => {
        expect(() => packageVersion("2026.11.11")).toThrow(/YYYY-MM-DD-HH-MM/u);
    });
});

describe("stamping the release manifest", () => {
    it("nightly: appends the run number and points at the nightly tag", () => {
        expect(releaseFields("2026.1111.1350", { channel: "nightly", run: "7", repoUrl: REPO })).toEqual({
            version: "2026.1111.1350.7",
            manifest: `${REPO}/releases/download/nightly/module.json`,
            download: `${REPO}/releases/download/nightly/ttrpg-pdf-converter.zip`,
        });
    });

    it("release: takes the version from the tag, the latest-alias manifest and a tag-pinned download", () => {
        expect(
            releaseFields("2026.1111.1350", { channel: "release", tag: "v2026.1111.1350", repoUrl: REPO }),
        ).toEqual({
            version: "2026.1111.1350",
            manifest: `${REPO}/releases/latest/download/module.json`,
            download: `${REPO}/releases/download/v2026.1111.1350/ttrpg-pdf-converter.zip`,
        });
    });

    it("release: refuses a tag that disagrees with the built version, or is not v<version>", () => {
        expect(() =>
            releaseFields("2026.1111.1350", { channel: "release", tag: "v2026.1111.1351", repoUrl: REPO }),
        ).toThrow(/does not match/u);
        expect(() =>
            releaseFields("2026.1111.1350", { channel: "release", tag: "nightly", repoUrl: REPO }),
        ).toThrow(/v<version>/u);
    });

    it("refuses an unknown channel and a missing repository", () => {
        expect(() => releaseFields("1.0.0", { channel: "beta", repoUrl: REPO })).toThrow(/unknown CHANNEL/u);
        expect(() => releaseFields("1.0.0", { channel: "nightly", repoUrl: "" })).toThrow(/REPO_URL/u);
    });
});

describe("the Foundry package listing request", () => {
    const manifest = {
        id: "ttrpg-pdf-converter",
        version: "2026.1111.1350",
        compatibility: { minimum: "14", verified: 14 },
    };

    it("points the listing at the tag-pinned manifest and the release notes", () => {
        expect(
            foundryReleaseBody(manifest, { repoUrl: REPO, tag: "v2026.1111.1350", dryRun: false }),
        ).toEqual({
            id: "ttrpg-pdf-converter",
            "dry-run": false,
            release: {
                version: "2026.1111.1350",
                manifest: `${REPO}/releases/download/v2026.1111.1350/module.json`,
                notes: `${REPO}/releases/tag/v2026.1111.1350`,
                compatibility: { minimum: "14", verified: "14" },
            },
        });
    });

    it("refuses a tag that does not match the version being released", () => {
        expect(() => foundryReleaseBody(manifest, { repoUrl: REPO, tag: "v1.0.0", dryRun: true })).toThrow(
            /does not match/u,
        );
    });
});
