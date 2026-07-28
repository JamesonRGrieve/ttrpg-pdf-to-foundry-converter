// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyTransforms, validateTransforms } from "../../src/dsl/transforms.ts";

describe("validateTransforms", () => {
    it("accepts the closed vocabulary", () => {
        expect(() =>
            validateTransforms([
                "trim",
                "collapse_ws",
                "to_int",
                "split(,)",
                "default(x)",
                "capture(\\d+,0)",
            ]),
        ).not.toThrow();
    });
    it("rejects an unknown transform", () => {
        expect(() => validateTransforms(["frobnicate"])).toThrow(/unknown transform/);
    });
});

describe("applyTransforms", () => {
    it("trim / collapse_ws / join_lines", () => {
        expect(applyTransforms(["trim"], "  hi  ")).toBe("hi");
        expect(applyTransforms(["collapse_ws"], "a   b\t c")).toBe("a b c");
        expect(applyTransforms(["join_lines"], "a\nb\nc")).toBe("a b c");
    });
    it("dehyphenate rejoins a word split across a line break", () => {
        expect(applyTransforms(["dehyphenate"], "efflor-\nescence")).toBe("efflorescence");
    });
    it("upper / lower / title_case", () => {
        expect(applyTransforms(["upper"], "abc")).toBe("ABC");
        expect(applyTransforms(["lower"], "ABC")).toBe("abc");
        expect(applyTransforms(["title_case"], "murk basilisk")).toBe("Murk Basilisk");
    });
    it("to_int / to_float parse and null out non-numerics", () => {
        expect(applyTransforms(["to_int"], "Armor 12")).toBe(12);
        expect(applyTransforms(["to_float"], "3.5 kg")).toBe(3.5);
        expect(applyTransforms(["to_int"], "none")).toBeNull();
    });
    it("split returns trimmed, non-empty segments", () => {
        expect(applyTransforms(["split(,)"], "a, b ,,c")).toEqual(["a", "b", "c"]);
    });
    it("capture extracts a group via RE2", () => {
        expect(applyTransforms(["capture(Cost (\\d+),1)"], "Cost 150")).toBe("150");
    });
    it("default fills only when the value is empty", () => {
        expect(applyTransforms(["default(N/A)"], "")).toBe("N/A");
        expect(applyTransforms(["default(N/A)"], "real")).toBe("real");
    });
    it("runs a multi-step pipeline in order", () => {
        expect(applyTransforms(["collapse_ws", "trim", "upper"], "  a  b ")).toBe("A B");
    });
});
