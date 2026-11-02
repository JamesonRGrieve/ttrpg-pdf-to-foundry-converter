// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject } from "../types/entity.ts";
import { parseArmourType, parseQualities, parseWeaponType } from "./notation.ts";

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

/**
 * The armour types a modification's `Used With` line names ("Carapace and
 * power armour", "Flak, Mesh, Carapace, and Power armour"), as the schema's
 * armour type choices; "Any armour" is the schema's `any`. Empty when a piece
 * names no type.
 */
export function usedWithArmourTypes(text: string): string[] {
    if (/^\s*(?:any|all)\b/iu.test(text)) {
        return ["any"];
    }
    const types = usedWithPieces(text).map((piece) => parseArmourType(piece));
    return types.length > 0 && types.every((t) => t !== null) ? [...new Set(types)] : [];
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

/**
 * What an ammunition does to the weapon loading it, read from its printed
 * effect: the qualities it adds ("gains the Haywire (2) quality", "add the
 * Hallucinogenic (2) and Recharge qualities") and removes ("loses its
 * Reliable quality"), and the flat amounts it adds to or takes from the
 * weapon's damage and penetration ("add 1 to a weapon's damage and
 * penetration", "reduce its damage by 2") — the schema's `addedQualities`,
 * `removedQualities` and `modifiers` deltas. An amount said to apply only
 * against some targets is no flat modifier and is left in the text.
 */
export interface AmmunitionEffect {
    added: string[];
    removed: string[];
    damage: number;
    penetration: number;
}

/** "the X (n) and Y qualities" after a verb giving or taking them. */
const ADDS_QUALITIES =
    /\b(?:gains?|grants?|adds?)(?:\s+(?:it|them|the\s+weapon))?\s+the\s+([^.]+?)\s+(?:special\s+)?qualit(?:y|ies)\b/giu;
const REMOVES_QUALITIES =
    /\b(?:loses?|removes?)\s+(?:its|the)\s+([^.]+?)\s+(?:special\s+)?qualit(?:y|ies)\b/giu;
/** What the amount is added to: the weapon's (or its, or a weapon's) damage and/or penetration. */
const WEAPONS = String.raw`(?:(?:its|the|a)\s+(?:weapon['’]s\s+)?)?`;
const ADDS_AMOUNT = new RegExp(
    String.raw`\badds?\s+(\d+)\s+to\s+(?:both\s+)?${WEAPONS}(damage|penetration)(\s+and\s+penetration)?\b([^.]*)`,
    "giu",
);
const REDUCES_DAMAGE = new RegExp(String.raw`\breduces?\s+${WEAPONS}damage\s+by\s+(\d+)\b([^.]*)`, "giu");
/** A quality's printed name: a capitalised word or two, a rating in brackets allowed. */
const QUALITY_NAME = /^\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*)?(?:\s*\(\s*[\dX]+\s*\))?$/u;
/** An amount applying only against some targets: "against" in its own clause (up to a comma). */
const CONDITIONAL = /^[^,;]*\bagainst\b/iu;

function qualityList(text: string): string[] {
    const names = text
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/u)
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
    return names.every((n) => QUALITY_NAME.test(n)) ? parseQualities(names.join(", ")) : [];
}

export function ammunitionEffect(html: string): AmmunitionEffect {
    const text = html
        .replace(/<[^>]*>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    const out: AmmunitionEffect = { added: [], removed: [], damage: 0, penetration: 0 };
    for (const m of text.matchAll(ADDS_QUALITIES)) {
        out.added.push(...qualityList(m[1] ?? ""));
    }
    for (const m of text.matchAll(REMOVES_QUALITIES)) {
        out.removed.push(...qualityList(m[1] ?? ""));
    }
    for (const m of text.matchAll(ADDS_AMOUNT)) {
        if (CONDITIONAL.test(m[4] ?? "")) {
            continue;
        }
        const n = Number(m[1]);
        if ((m[2] ?? "").toLowerCase() === "damage") {
            out.damage += n;
            if (m[3] !== undefined) {
                out.penetration += n;
            }
        } else {
            out.penetration += n;
        }
    }
    for (const m of text.matchAll(REDUCES_DAMAGE)) {
        if (!CONDITIONAL.test(m[2] ?? "")) {
            out.damage -= Number(m[1]);
        }
    }
    return out;
}

/** The text of a field that may be held per line (`{dh2: "<p>…</p>"}`) or as a description (`{value}`). */
function textOf(v: unknown): string {
    if (typeof v === "string") {
        return v;
    }
    if (isObject(v)) {
        if (typeof v["value"] === "string") {
            return v["value"];
        }
        return Object.values(v).map(textOf).join(" ");
    }
    return "";
}

const isBlankList = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * Give each ammunition what its printed effect does to the weapon (its
 * effect field, else its description), where no reading set those fields.
 */
export function applyAmmunitionEffects(entities: readonly Entity[]): void {
    for (const e of entities) {
        const system = e.fields["system"];
        if (e.fields["type"] !== "ammunition" || !isObject(system)) {
            continue;
        }
        const effect = ammunitionEffect(textOf(system["effect"]) || textOf(system["description"]));
        if (effect.added.length > 0 && isBlankList(system["addedQualities"])) {
            system["addedQualities"] = [...new Set(effect.added)];
        }
        if (effect.removed.length > 0 && isBlankList(system["removedQualities"])) {
            system["removedQualities"] = [...new Set(effect.removed)];
        }
        const modifiers = isObject(system["modifiers"]) ? system["modifiers"] : {};
        const set = (key: "damage" | "penetration", n: number): void => {
            const current = modifiers[key];
            if (n !== 0 && (current === undefined || current === null || current === 0)) {
                modifiers[key] = n;
                system["modifiers"] = modifiers;
            }
        };
        set("damage", effect.damage);
        set("penetration", effect.penetration);
    }
}
