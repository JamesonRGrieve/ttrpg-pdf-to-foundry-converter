// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject } from "../types/entity.ts";
import { parseWeaponType } from "./notation.ts";

/**
 * `system.weaponTypes`: the kinds of weapon an ammunition loads, read from
 * its printed `Used With` line. A piece of the line naming one of the
 * schema's weapon types ("All bolt weapons") gives that type; a piece naming
 * weapons ("Stub revolvers", "shotguns (all types)") gives the types of the
 * document's own weapons of that name. Nothing is known of any weapon but
 * what the document prints.
 */

/** A name's letters and digits, lower-cased: how a printed weapon name is matched. */
const key = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Words leading a piece of the list that name no weapon ("all", "any"). */
const LEAD_WORDS = /^(?:(?:and|or|all|any|other)\s+)+/iu;

/** The list's pieces: split at commas and the joining "and"/"or", notes in brackets dropped. */
export function usedWithPieces(text: string): string[] {
    return text
        .replace(/\([^()]*\)/gu, " ")
        .replace(/\.\s*$/u, "")
        .split(/,|\s+(?:and|or)\s+/iu)
        .map((p) => p.replace(LEAD_WORDS, "").trim())
        .filter((p) => p.length > 0);
}

/** The singular forms a plural piece may name a weapon by ("revolvers" → "revolver"). */
const singulars = (piece: string): string[] => {
    const k = key(piece);
    return [k, k.replace(/es$/u, ""), k.replace(/s$/u, "")];
};

/** The weapon types a `Used With` line names, given the document's weapons (name → type). */
export function usedWithTypes(text: string, weaponTypes: ReadonlyMap<string, string>): string[] {
    const found: string[] = [];
    for (const piece of usedWithPieces(text)) {
        const named =
            parseWeaponType(piece) ??
            singulars(piece)
                .map((s) => weaponTypes.get(s))
                .find((t) => t);
        if (named !== undefined && !found.includes(named)) {
            found.push(named);
        }
    }
    return found;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Give each ammunition whose `Used With` line was printed (`usedWith`, by name
 * key) the weapon types it names, unless it has some.
 */
export function applyAmmunitionWeaponTypes(
    entities: readonly Entity[],
    usedWith: ReadonlyMap<string, string>,
): void {
    const weaponTypes = new Map<string, string>();
    for (const e of entities) {
        const system = e.fields["system"];
        const type = isObject(system) ? system["type"] : undefined;
        if (e.fields["type"] === "weapon" && typeof type === "string" && type !== "") {
            weaponTypes.set(key(String(e.fields["name"])), type);
        }
    }
    for (const e of entities) {
        const system = e.fields["system"];
        const text = usedWith.get(key(String(e.fields["name"])));
        if (e.fields["type"] !== "ammunition" || !isObject(system) || text === undefined) {
            continue;
        }
        const current = system["weaponTypes"];
        if (Array.isArray(current) && current.length > 0) {
            continue;
        }
        const types = usedWithTypes(text, weaponTypes);
        if (types.length > 0) {
            system["weaponTypes"] = types;
        }
    }
}
