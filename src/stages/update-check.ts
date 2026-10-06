// SPDX-License-Identifier: AGPL-3.0-or-later
import { CONVERTER_URL, RELEASE_FEED_URL } from "../version.ts";

/**
 * The script every module ships so its GM learns when a newer converter
 * release exists: once the world is ready, it reads the latest release from
 * the converter's page and, if any active converted module was built by an
 * older one, offers to build it again. A checkbox hides the notice until a
 * newer release still comes out.
 *
 * Several converted modules may be active at once; the first script to run
 * speaks for all of them, so the GM sees one notice. Offline, or if the
 * release cannot be read, it says nothing. The script holds no document
 * content and is the same in every module.
 */

/** Namespace of the manifest flags the converter writes (its release among them). */
export const FLAG_SCOPE = "foundry-pdf-parser";
/** Where the script sits in a module. */
export const UPDATE_CHECK_PATH = "scripts/update-check.js";
/** Browser-storage key holding the release whose notice the GM hid. */
const DISMISSED_KEY = "pdf-compendium.update-notice-hidden";

export const UPDATE_CHECK_SCRIPT = `// Written by the PDF to Compendium converter (${CONVERTER_URL}).
// Tells the GM when a newer converter release exists than the one that built
// an active converted module. It reads only the published release number.
const FLAG = ${JSON.stringify(FLAG_SCOPE)};
const FEED = ${JSON.stringify(RELEASE_FEED_URL)};
const PAGE = ${JSON.stringify(CONVERTER_URL)};
const HIDDEN = ${JSON.stringify(DISMISSED_KEY)};

const escape = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

Hooks.once("ready", async () => {
    if (!game.user?.isGM || globalThis.__pdfCompendiumUpdateCheck) {
        return;
    }
    globalThis.__pdfCompendiumUpdateCheck = true;
    const built = [...game.modules]
        .filter((m) => m.active && typeof m.flags?.[FLAG]?.release === "string")
        .map((m) => ({ title: m.title, release: m.flags[FLAG].release }));
    if (built.length === 0) {
        return;
    }
    let latest;
    try {
        const response = await fetch(FEED, { cache: "no-store" });
        latest = response.ok ? (await response.json()).release : undefined;
    } catch {
        return;
    }
    // Releases are YYYY-MM-DD-HH-MM, so they compare in time order as text.
    const outdated = typeof latest === "string" ? built.filter((m) => m.release < latest) : [];
    let hidden = null;
    try {
        hidden = localStorage.getItem(HIDDEN);
    } catch {
        // Storage blocked: the notice shows, it just cannot be hidden.
    }
    if (outdated.length === 0 || hidden === latest) {
        return;
    }
    const list = outdated.map((m) => \`<li>\${escape(m.title)} (built by release \${escape(m.release)})</li>\`).join("");
    const content = \`<p>A newer PDF to Compendium converter (release \${escape(latest)}) is available. It may extract more, or more accurately, than the release that built:</p>
<ul>\${list}</ul>
<p>To get the new results, convert your PDFs again at <a href="\${PAGE}" target="_blank" rel="noopener">\${PAGE}</a> and replace the module. Nothing changes if you keep it.</p>
<p><label><input type="checkbox" name="hide"> Don't show this again until a newer release</label></p>\`;
    const hide = await foundry.applications.api.DialogV2.prompt({
        window: { title: "New converter release available" },
        content,
        ok: { label: "OK", callback: (_event, button) => button.form.elements.hide.checked },
        rejectClose: false,
    });
    if (hide === true) {
        try {
            localStorage.setItem(HIDDEN, latest);
        } catch {
            // Storage blocked: nothing to remember it in.
        }
    }
});
`;
