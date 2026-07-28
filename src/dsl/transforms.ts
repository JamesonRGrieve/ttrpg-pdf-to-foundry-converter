// SPDX-License-Identifier: AGPL-3.0-or-later
import { compilePattern } from "./regex.ts";

/**
 * The closed transform vocabulary (spec §8.4). No user-extensible transforms in
 * v1 — adding one is a schema-version bump. Each transform is a pure function of
 * its input and its (fixed, parsed-once) argument, so a field pipeline is fully
 * deterministic. Array-valued results (from `split`) are coerced to a scalar at
 * emit time.
 */

export type TransformValue = string | number | boolean | string[] | null;

const KNOWN_TRANSFORMS = new Set([
    "trim",
    "collapse_ws",
    "join_lines",
    "dehyphenate",
    "upper",
    "lower",
    "title_case",
    "to_int",
    "to_float",
    "split",
    "capture",
    "default",
]);

interface ParsedTransform {
    name: string;
    arg: string | null;
}

function parseExpr(expr: string): ParsedTransform {
    const open = expr.indexOf("(");
    if (open === -1) {
        return { name: expr.trim(), arg: null };
    }
    if (!expr.endsWith(")")) {
        throw new Error(`malformed transform ${JSON.stringify(expr)}: expected closing ')'`);
    }
    return { name: expr.slice(0, open).trim(), arg: expr.slice(open + 1, -1) };
}

function toText(value: TransformValue): string {
    if (value === null) {
        return "";
    }
    if (Array.isArray(value)) {
        return value.join(" ");
    }
    return String(value);
}

function titleCase(input: string): string {
    return input.replace(/\b([a-z])/g, (_m, ch: string) => ch.toUpperCase());
}

/** Apply a single parsed transform to a value. */
function applyOne(parsed: ParsedTransform, value: TransformValue): TransformValue {
    const { name, arg } = parsed;
    switch (name) {
        case "trim":
            return toText(value).trim();
        case "collapse_ws":
            return toText(value).replace(/\s+/g, " ").trim();
        case "join_lines":
            return toText(value).replace(/[\r\n]+/g, " ");
        case "dehyphenate":
            return toText(value).replace(/-\s*[\r\n]+\s*/g, "");
        case "upper":
            return toText(value).toUpperCase();
        case "lower":
            return toText(value).toLowerCase();
        case "title_case":
            return titleCase(toText(value).toLowerCase());
        case "to_int": {
            const n = Number.parseInt(toText(value).replace(/[^\d+-]/g, ""), 10);
            return Number.isNaN(n) ? null : n;
        }
        case "to_float": {
            const n = Number.parseFloat(toText(value).replace(/[^\d.+-]/g, ""));
            return Number.isNaN(n) ? null : n;
        }
        case "split": {
            const sep = arg ?? "";
            return toText(value)
                .split(sep)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
        }
        case "capture": {
            if (arg === null) {
                throw new Error("capture(pattern, group) requires arguments");
            }
            const lastComma = arg.lastIndexOf(",");
            if (lastComma === -1) {
                throw new Error("capture(pattern, group) requires a group index");
            }
            const pattern = arg.slice(0, lastComma).trim();
            const group = Number.parseInt(arg.slice(lastComma + 1).trim(), 10);
            return compilePattern(pattern).capture(toText(value), group);
        }
        case "default": {
            const text = toText(value);
            return text.length > 0 ? value : (arg ?? "");
        }
        default:
            throw new Error(`unknown transform ${JSON.stringify(name)}`);
    }
}

/** Validate a transform expression list at profile load (fail fast on typos). */
export function validateTransforms(exprs: readonly string[]): void {
    for (const expr of exprs) {
        const { name } = parseExpr(expr);
        if (!KNOWN_TRANSFORMS.has(name)) {
            throw new Error(`unknown transform ${JSON.stringify(name)} (closed vocabulary, §8.4)`);
        }
    }
}

/** Run a value through a transform pipeline in order. */
export function applyTransforms(exprs: readonly string[], value: TransformValue): TransformValue {
    let current = value;
    for (const expr of exprs) {
        current = applyOne(parseExpr(expr), current);
    }
    return current;
}
