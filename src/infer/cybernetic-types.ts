// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject } from "../types/entity.ts";
import { parseCyberneticType } from "./notation.ts";

/**
 * A cybernetic's `type` from its own name: a name naming one of the schema's
 * cybernetic types ("Ballistic Mechadendrite", "Cerebral Implants") is of that
 * type. A cybernetic whose name names none keeps the schema's initial type.
 */

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Type every cybernetic (a pack's own, or one embedded in an actor) its name names, unless a reading typed it. */
export function applyCyberneticTypes(entities: readonly Entity[]): void {
    const apply = (type: unknown, name: unknown, system: unknown): void => {
        if (type !== "cybernetic" || typeof name !== "string" || !isObject(system)) {
            return;
        }
        if (typeof system["type"] === "string" && system["type"] !== "") {
            return;
        }
        const named = parseCyberneticType(name);
        if (named !== null) {
            system["type"] = named;
        }
    };
    for (const e of entities) {
        apply(e.fields["type"], e.fields["name"], e.fields["system"]);
        const items = e.fields["items"];
        if (Array.isArray(items)) {
            for (const item of items) {
                if (isObject(item)) {
                    apply(item["type"], item["name"], item["system"]);
                }
            }
        }
    }
}
