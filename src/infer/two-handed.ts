// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject } from "../types/entity.ts";
import { WEAPON_CLASSES } from "./notation.ts";

/**
 * `system.twoHanded` from the document's own rules: a book sets out how each
 * weapon class is wielded ("Basic weapons normally require two hands …",
 * "Heavy: Such weapons always require two hands …"). A class it says requires
 * two hands gives each weapon of that class the flag, unless a reading set it.
 */

/** "<Class> weapons …", "<Class>: Weapons of this class …", "<Class>: Such weapons …", then "(normally|always) require two hands". */
const CLASS_RULE = new RegExp(
    String.raw`\b(${WEAPON_CLASSES.join("|")})(?:\s+weapons)?\s*:?\s*(?:(?:weapons\s+of\s+this\s+class|such\s+weapons|these\s+weapons)\s+)?(?:(?:normally|always|usually|typically)\s+)?require\s+two\s+hands\b`,
    "giu",
);

/** The weapon classes the document's text says require two hands. */
export function twoHandedClasses(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.replace(/\s+/gu, " ").matchAll(CLASS_RULE)) {
        const cls = m[1]?.toLowerCase();
        if (cls !== undefined) {
            out.add(cls);
        }
    }
    return out;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Flag every weapon (a pack's own, or one embedded in an actor) of a class in `classes` two-handed, unless set. */
export function applyTwoHandedClasses(entities: readonly Entity[], classes: ReadonlySet<string>): void {
    if (classes.size === 0) {
        return;
    }
    const apply = (type: unknown, system: unknown): void => {
        if (
            type === "weapon" &&
            isObject(system) &&
            typeof system["class"] === "string" &&
            classes.has(system["class"]) &&
            system["twoHanded"] === undefined
        ) {
            system["twoHanded"] = true;
        }
    };
    for (const e of entities) {
        apply(e.fields["type"], e.fields["system"]);
        const items = e.fields["items"];
        if (Array.isArray(items)) {
            for (const item of items) {
                if (isObject(item)) {
                    apply(item["type"], item["system"]);
                }
            }
        }
    }
}
