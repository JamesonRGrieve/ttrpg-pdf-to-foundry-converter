// Written by the PDF to Compendium converter (https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/).
// Tells the GM when a newer converter release exists than the one that built
// an active converted module. It reads only the published release number.
const FLAG = "foundry-pdf-parser";
const FEED = "https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/release.json";
const PAGE = "https://jamesonrgrieve.github.io/ttrpg-pdf-to-foundry-converter/";
const HIDDEN = "pdf-compendium.update-notice-hidden";

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
    const list = outdated.map((m) => `<li>${escape(m.title)} (built by release ${escape(m.release)})</li>`).join("");
    const content = `<p>A newer PDF to Compendium converter (release ${escape(latest)}) is available. It may extract more, or more accurately, than the release that built:</p>
<ul>${list}</ul>
<p>To get the new results, convert your PDFs again at <a href="${PAGE}" target="_blank" rel="noopener">${PAGE}</a> and replace the module. Nothing changes if you keep it.</p>
<p><label><input type="checkbox" name="hide"> Don't show this again until a newer release</label></p>`;
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
