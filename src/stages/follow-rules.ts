// SPDX-License-Identifier: AGPL-3.0-or-later
import { FOLLOWS_RULES } from "../infer/origin-paths.ts";
import type { JsonObject, JsonValue } from "../types/entity.ts";
import type { EmittedPack } from "./emit.ts";

/**
 * Origins that follow another origin's rules across the documents of one run:
 * an origin whose description says it follows the X rules, and which carries
 * no base rules of its own, takes the grants and modifiers of the origin
 * named X, of the same line and step, that another document of the run
 * emitted. Its own printed abilities stay. Applied before homologation.
 */
export function withFollowedOrigins(lines: readonly { line: string; packs: readonly EmittedPack[] }[]): void {
    const letters = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const byLine = new Map<string, JsonObject[]>();
    for (const { line, packs } of lines) {
        const held = byLine.get(line) ?? [];
        for (const p of packs) {
            held.push(...p.documents.filter((d) => d["type"] === "originPath"));
        }
        byLine.set(line, held);
    }
    for (const docs of byLine.values()) {
        for (const doc of docs) {
            const system = obj(doc["system"]);
            if (system === undefined || hasBaseRules(system)) {
                continue;
            }
            const named = FOLLOWS_RULES.exec(plain(system))?.[1];
            if (named === undefined) {
                continue;
            }
            const base = docs.find((b) => {
                const bs = obj(b["system"]);
                return (
                    b !== doc &&
                    bs !== undefined &&
                    bs["step"] === system["step"] &&
                    typeof b["name"] === "string" &&
                    letters(b["name"]) === letters(named) &&
                    hasBaseRules(bs)
                );
            });
            const bs = obj(base?.["system"]);
            if (bs === undefined) {
                continue;
            }
            const own = obj(system["grants"]) ?? {};
            const grants: JsonObject = { ...structuredClone(obj(bs["grants"]) ?? {}) };
            for (const [k, v] of Object.entries(own)) {
                if (filled(v)) {
                    grants[k] = v;
                }
            }
            grants["specialAbilities"] = own["specialAbilities"] ?? [];
            system["grants"] = grants;
            system["modifiers"] = structuredClone(bs["modifiers"] ?? {});
        }
    }
}

function obj(v: JsonValue | undefined): JsonObject | undefined {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

function filled(v: JsonValue | undefined): boolean {
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "" && v !== 0;
}

/** Whether an origin's system carries base rules: wounds, fate, aptitudes or characteristic changes. */
function hasBaseRules(system: JsonObject): boolean {
    const g = obj(system["grants"]) ?? {};
    const chars = obj(obj(system["modifiers"])?.["characteristics"]) ?? {};
    return (
        ["woundsFormula", "fateFormula", "aptitudes"].some((k) => filled(g[k])) ||
        Object.keys(chars).length > 0
    );
}

/** An origin's description as plain text. */
function plain(system: JsonObject): string {
    const d = system["description"];
    const html = JSON.stringify(d ?? "");
    return html.replace(/<[^>]+>/gu, " ").replace(/\\n/gu, " ");
}
