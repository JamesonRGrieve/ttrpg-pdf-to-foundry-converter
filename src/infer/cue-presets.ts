// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject } from "../types/entity.ts";

/**
 * `system.cue.preset`: the procedural look the wh40k-rpg system draws a
 * weapon's attack with. Its choices name the same technologies as the
 * weapon `type` choices, so a weapon of a type its presets share a name with
 * (or a plain synonym of: solid projectiles fly as `solid` slugs, explosives
 * and grenades as `launcher` rounds, shock weapons as an `arc`, force
 * weapons as `warp`) takes that preset. A primitive ranged weapon looses a
 * `solid` missile; a primitive or exotic melee weapon could be a blade or a
 * club, so it is left to the system's default for its attack kind.
 */
const PRESET_BY_TYPE: Readonly<Record<string, string>> = {
    las: "las",
    bolt: "bolt",
    plasma: "plasma",
    melta: "melta",
    flame: "flame",
    launcher: "launcher",
    chain: "chain",
    power: "power",
    "solid-projectile": "solid",
    explosive: "launcher",
    grenade: "launcher",
    shock: "arc",
    force: "warp",
};

/** The cue preset a weapon of `type` and `cls` takes; null where its type does not settle one. */
export function cuePresetFor(type: string, cls: string | undefined): string | null {
    if (type === "primitive") {
        return cls === undefined || cls === "melee" ? null : "solid";
    }
    return PRESET_BY_TYPE[type] ?? null;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Give every weapon (a pack's own, or one embedded in an actor) the preset its type settles, unless it has one. */
export function applyCuePresets(entities: readonly Entity[]): void {
    const apply = (type: unknown, system: unknown): void => {
        if (type !== "weapon" || !isObject(system) || typeof system["type"] !== "string") {
            return;
        }
        const cue = isObject(system["cue"]) ? system["cue"] : {};
        if (typeof cue["preset"] === "string" && cue["preset"] !== "") {
            return;
        }
        const cls = typeof system["class"] === "string" ? system["class"] : undefined;
        const preset = cuePresetFor(system["type"], cls);
        if (preset !== null) {
            system["cue"] = { ...cue, preset };
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
