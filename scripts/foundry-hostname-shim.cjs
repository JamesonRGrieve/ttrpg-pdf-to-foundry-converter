// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Node --require shim for the e2e Foundry server: reports the hostname the
 * release's license.json was issued for, so a local test instance passes the
 * license check instead of stopping at /license. Foundry binds the licence to
 * `os.hostname()`.
 *
 * FOUNDRY_LICENSE_HOSTNAME overrides the value read from the licence. Only
 * the e2e webServer loads this; never load it anywhere else.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function licensedHost() {
    if (process.env.FOUNDRY_LICENSE_HOSTNAME) {
        return process.env.FOUNDRY_LICENSE_HOSTNAME;
    }
    const release = path.resolve(__dirname, "..", process.env.FOUNDRY_RELEASE_DIR || ".foundry-release");
    try {
        return JSON.parse(fs.readFileSync(path.join(release, "license.json"), "utf8")).host || null;
    } catch {
        return null;
    }
}

const host = licensedHost();
if (host) {
    os.hostname = () => host;
}
