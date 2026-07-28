// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IRTextRun } from "../types/ir.ts";
import type { ExcludeRule, Selector } from "../types/profile.ts";
import { sizeEquals } from "../util/rounding.ts";

/**
 * Typographic selector matching (spec §8.5). Selectors are expressed in
 * font/weight/size/indent/column terms — never absolute page coordinates
 * (those are permitted only inside `exclude` regions for page furniture). Size
 * comparison uses the epsilon rule from §5.3, never `===` on a float.
 */

export function matchesSelector(selector: Selector, run: IRTextRun): boolean {
    if (selector.weight !== undefined && selector.weight !== run.weight) {
        return false;
    }
    if (selector.italic !== undefined && selector.italic !== run.italic) {
        return false;
    }
    if (selector.font !== undefined && selector.font !== run.font) {
        return false;
    }
    if (selector.column !== undefined && selector.column !== run.column) {
        return false;
    }
    if (selector.size !== undefined && !sizeEquals(selector.size, run.size)) {
        return false;
    }
    if (selector.indent !== undefined) {
        if (run.indent < selector.indent.min || run.indent > selector.indent.max) {
            return false;
        }
    }
    return true;
}

/**
 * True when a run falls inside any `exclude` region — page furniture such as
 * running heads and footers (§8.3). This is the only place absolute
 * page-coordinate addressing is allowed (§8.5).
 */
export function isExcluded(run: IRTextRun, excludes: readonly ExcludeRule[]): boolean {
    for (const { region } of excludes) {
        const inY = run.y >= region.y_min && run.y <= region.y_max;
        const inX =
            region.x_min === undefined || region.x_max === undefined
                ? true
                : run.x >= region.x_min && run.x <= region.x_max;
        if (inY && inX) {
            return true;
        }
    }
    return false;
}
