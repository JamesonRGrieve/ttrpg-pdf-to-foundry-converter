// SPDX-License-Identifier: AGPL-3.0-or-later
import { RE2JS } from "re2js";

/**
 * RE2 regex facade (spec §8.2). All profile pattern matching goes through a
 * linear-time, backtracking-free engine: a careless or hostile profile cannot
 * hang an import, and match semantics are fully specified rather than
 * implementation-dependent. Lookbehind and backreferences are unsupported by
 * RE2 syntax, so `compilePattern` rejects them at load time by construction.
 */

export interface CompiledPattern {
    readonly source: string;
    test(input: string): boolean;
    /** Return capture group `group` (0 = whole match) or null when unmatched. */
    capture(input: string, group: number): string | null;
}

export function compilePattern(pattern: string): CompiledPattern {
    let compiled: RE2JS;
    try {
        compiled = RE2JS.compile(pattern);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`invalid RE2 pattern ${JSON.stringify(pattern)}: ${detail}`);
    }
    return {
        source: pattern,
        test(input: string): boolean {
            return compiled.matcher(input).find();
        },
        capture(input: string, group: number): string | null {
            const matcher = compiled.matcher(input);
            if (!matcher.find()) {
                return null;
            }
            if (group < 0 || group > matcher.groupCount()) {
                return null;
            }
            const value = matcher.group(group);
            return value ?? null;
        },
    };
}
