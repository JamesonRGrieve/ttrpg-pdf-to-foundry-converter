// SPDX-License-Identifier: AGPL-3.0-or-later
import { entityRef } from "../stages/emit.ts";
import type { Entity, JsonObject, JsonValue } from "../types/entity.ts";
import { CHARACTERISTICS } from "./entry-types.ts";
import type { OriginStepDef } from "./targets.ts";

/**
 * An origin's printed prerequisites as the schema's structured gates
 * (`system.prerequisites`, `{type, key, value}`), which the system checks
 * when a character takes the step:
 *
 *  - a characteristic minimum printed as its own item ("Willpower: 40") →
 *    `characteristic` (`influence` for Influence);
 *  - another origin of the document, named with its step's label ("the X
 *    elite advance", "Y Background:") → `origin`, or `notOrigin` where the
 *    sentence naming it says the step cannot be taken with it ("Characters
 *    with the X elite advance cannot gain …"). Such a gate names the origin's
 *    document by its UUID, so only origins this document also prints are
 *    named; one printed elsewhere stays in the requirements text alone.
 *
 * A sentence naming another origin without a modal of obligation or
 * prohibition ("Characters without the X background … are not sanctioned")
 * states a consequence, not a gate, and is left out.
 */
export function applyOriginPrerequisites(entities: readonly Entity[], steps: readonly OriginStepDef[]): void {
    const origins = entities.filter((e) => e.fields["type"] === "originPath");
    const named = origins.flatMap((e) => namings(e, steps));
    for (const origin of origins) {
        const system = objectOf(origin.fields["system"]);
        const text = objectOf(system?.["requirements"])?.["text"];
        if (system === null || typeof text !== "string" || text.trim() === "") {
            continue;
        }
        const gates: JsonObject[] = [];
        const add = (gate: JsonObject): void => {
            if (!gates.some((g) => JSON.stringify(g) === JSON.stringify(gate))) {
                gates.push(gate);
            }
        };
        const others = named.filter((n) => n.entity !== origin);
        for (const item of text.split(BULLET).map((s) => s.trim())) {
            const labelled = LABELLED.exec(item)?.groups;
            const label = labelled?.["label"]?.trim() ?? "";
            const body = labelled?.["body"]?.trim() ?? item;
            const minimum = characteristicMinimum(label, body);
            if (minimum !== null) {
                add(minimum);
                continue;
            }
            // A label naming another origin with its step ("Y Background:").
            for (const n of others) {
                if (wholly(n.pattern, label)) {
                    add({ type: "origin", key: refTo(n.entity) });
                }
            }
            for (const sentence of body.split(SENTENCE_END)) {
                const kind = PROHIBITION.test(sentence)
                    ? "notOrigin"
                    : OBLIGATION.test(sentence)
                      ? "origin"
                      : null;
                if (kind === null) {
                    continue;
                }
                for (const n of others) {
                    if (n.pattern.test(sentence)) {
                        add({ type: kind, key: refTo(n.entity) });
                    }
                }
            }
        }
        if (gates.length > 0) {
            system["prerequisites"] = gates;
        }
    }
}

/** Items of a printed prerequisites list. */
const BULLET = /[•▪●◦]/u;
/** "Label: text". */
const LABELLED = /^(?<label>[^:]{1,60}):\s*(?<body>.*)$/su;
const SENTENCE_END = /(?<=[.!?])\s+/u;
/** A sentence forbidding the step to a character with something. */
const PROHIBITION = /\b(?:cannot|can\s+not|may\s+not|must\s+not)\b/iu;
/** A sentence requiring something of a character taking the step. */
const OBLIGATION = /\b(?:must\s+(?:possess|have|hold|be)|requires?)\b/iu;

/** "Willpower" + "40": a characteristic minimum; Influence is a gate of its own kind. */
function characteristicMinimum(label: string, body: string): JsonObject | null {
    const key = CHARACTERISTICS[label.toLowerCase().replace(/\s+/gu, " ")];
    const value = /^(\d+)\.?$/u.exec(body)?.[1];
    if (key === undefined || value === undefined || label.length <= 3) {
        return null;
    }
    return key === "influence"
        ? { type: "influence", key, value: Number(value) }
        : { type: "characteristic", key, value: Number(value) };
}

interface Naming {
    entity: Entity;
    /** The origin's name followed by one of its step's labels. */
    pattern: RegExp;
}

/** How an origin is named elsewhere: its name followed by its step's label. */
function namings(e: Entity, steps: readonly OriginStepDef[]): Naming[] {
    const name = e.fields["name"];
    const step = steps.find((s) => s.key === objectOf(e.fields["system"])?.["step"]);
    if (typeof name !== "string" || name.trim() === "" || step === undefined) {
        return [];
    }
    const words = (s: string): string =>
        s
            .trim()
            .split(/\s+/u)
            .map(escapeRe)
            .join(String.raw`\s+`);
    return [
        {
            entity: e,
            pattern: new RegExp(
                String.raw`(?<![\p{L}\p{N}])${words(name)}\s+(?:${step.labels.map(words).join("|")})s?(?![\p{L}\p{N}])`,
                "iu",
            ),
        },
    ];
}

/** Whether `pattern` spans all of `text`. */
function wholly(pattern: RegExp, text: string): boolean {
    const m = pattern.exec(text);
    return m !== null && m[0].length === text.trim().length;
}

/** A reference to an origin's document: it gets a block id of its own, which emit resolves to its UUID. */
function refTo(e: Entity): string {
    if (!e.blockId.endsWith(OWN_REF)) {
        e.blockId = `${e.blockId}#${e.ordinal}${OWN_REF}`;
    }
    return entityRef(e.blockId);
}

const OWN_REF = ":referenced";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function objectOf(v: JsonValue | undefined): JsonObject | null {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}
