// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { compilePattern } from "../../src/dsl/regex.ts";

describe("compilePattern", () => {
    it("tests and captures groups", () => {
        const p = compilePattern("Armor Class (\\d+)");
        expect(p.test("Armor Class 14")).toBe(true);
        expect(p.test("nothing")).toBe(false);
        expect(p.capture("Armor Class 14", 1)).toBe("14");
        expect(p.capture("Armor Class 14", 0)).toBe("Armor Class 14");
    });
    it("returns null for an unmatched input or out-of-range group", () => {
        const p = compilePattern("(\\d+)");
        expect(p.capture("no digits", 1)).toBeNull();
        expect(p.capture("42", 5)).toBeNull();
    });
    it("rejects a non-RE2 pattern (backreference) with a helpful error", () => {
        expect(() => compilePattern("(a)\\1")).toThrow(/invalid RE2 pattern/);
    });
    it("stays linear-time on input that would catastrophically backtrack", () => {
        // A classic ReDoS pattern; RE2 evaluates it in linear time.
        const p = compilePattern("(a+)+$");
        expect(p.test(`${"a".repeat(40)}!`)).toBe(false);
    });
    it("supports the DOTALL inline flag used by profiles", () => {
        const p = compilePattern("(?s)^(.*?)Armor Class");
        expect(p.capture("line one\nline two\nArmor Class 3", 1)).toBe("line one\nline two\n");
    });
});
