// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-input target schemas from the command line: each `--target <line>`
 * applies to the inputs after it, until the next one; inputs before any
 * take the default. The user chooses every input's line — nothing here reads
 * the inputs themselves.
 */

/** The parts of a `node:util` `parseArgs` token this needs. */
export type ArgToken =
    | { kind: "option"; name: string; value?: string | undefined }
    | { kind: "positional"; value: string }
    | { kind: "option-terminator" };

export interface TargetedInput {
    input: string;
    /** The line id the user gave, or undefined for the default. */
    targetId: string | undefined;
}

export function targetedInputs(tokens: readonly ArgToken[]): TargetedInput[] {
    const out: TargetedInput[] = [];
    let targetId: string | undefined;
    for (const token of tokens) {
        if (token.kind === "option" && token.name === "target") {
            targetId = token.value;
        } else if (token.kind === "positional") {
            out.push({ input: token.value, targetId });
        }
    }
    return out;
}
