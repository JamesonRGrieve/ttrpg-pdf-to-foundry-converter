// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject, JsonValue } from "../types/entity.ts";
import { CHARACTERISTICS } from "./entry-types.ts";

/**
 * An order's test (the schema's `test`: skill, characteristic, modifier and,
 * for a combined test, the ship stat added to the skill), read from the first
 * test its text asks for: "a Difficult (–10) Tech-Use Test", "a Challenging
 * (+0) Pilot (Space Craft)+ Manoeuvrability Test", "a Challenging (+0)
 * Willpower Test". The subject is kept as printed; a characteristic is the
 * test's characteristic rather than its skill. An order whose text asks for
 * no such test keeps none.
 */
export function applyOrderTests(entities: readonly Entity[]): void {
    for (const e of entities) {
        const system = objectOf(e.fields["system"]);
        if (e.fields["type"] !== "order" || system === null || system["test"] !== undefined) {
            continue;
        }
        const text = Object.values(objectOf(system["effect"]) ?? {})
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.replace(/<[^>]*>/gu, " "))
            .join(" ");
        const test = firstTest(text);
        if (test !== null) {
            system["test"] = test;
        }
    }
}

/** "(–10) Subject Test": the bracketed modifier and the subject up to the word "Test". */
const PRINTED_TEST =
    /\(\s*(?<sign>[+\-–−])\s*(?<amount>\d+)\s*\)\s*(?<subject>[^.()]*?(?:\([^()]*\)[^.()]*?)*)\s*\bTests?\b/u;

/** The schema's ship stats a combined test adds to the skill. */
const SHIP_STATS: readonly string[] = ["manoeuvrability", "detection"];

function firstTest(text: string): JsonObject | null {
    const m = PRINTED_TEST.exec(text)?.groups;
    const subject = m?.["subject"]?.trim() ?? "";
    if (m === undefined || subject === "") {
        return null;
    }
    const modifier = (m["sign"] === "+" ? 1 : -1) * Number(m["amount"]);
    const parts = subject.split(/\s*\+\s*/u).filter((p) => p !== "");
    const last = parts.at(-1)?.toLowerCase() ?? "";
    const shipStat = parts.length > 1 && SHIP_STATS.includes(last) ? last : null;
    const tested = (shipStat === null ? parts : parts.slice(0, -1)).join(" + ");
    const characteristic = CHARACTERISTICS[tested.toLowerCase()] !== undefined && tested.length > 3;
    return {
        skill: characteristic ? "" : tested,
        characteristic: characteristic ? tested : "",
        modifier,
        ...(shipStat === null ? {} : { shipStat }),
    };
}

function objectOf(v: JsonValue | undefined): JsonObject | null {
    return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : null;
}
