// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR } from "../types/ir.ts";
import { slugify } from "../util/slug.ts";

/**
 * The book segment of pack names, taken from the PDF itself: its metadata
 * title, slugged, falling back to the largest text on the first page with
 * text. This names the output after whatever the file calls itself; it is not
 * matched against anything.
 */
export function inferBookSlug(ir: IR): string {
    if (ir.meta.title !== null && /[\p{L}\p{N}]/u.test(ir.meta.title)) {
        return slugify(ir.meta.title);
    }
    if (ir.runs.length === 0) {
        return "untitled";
    }
    const firstPage = Math.min(...ir.runs.map((r) => r.pageIndex));
    const pageRuns = ir.runs.filter((r) => r.pageIndex === firstPage);
    const largest = Math.max(...pageRuns.map((r) => r.size));
    const title = pageRuns
        .filter((r) => r.size === largest)
        .map((r) => r.text)
        .join(" ");
    return /[\p{L}\p{N}]/u.test(title) ? slugify(title) : "untitled";
}
