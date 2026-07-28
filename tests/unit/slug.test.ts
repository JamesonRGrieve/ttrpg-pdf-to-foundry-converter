// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { slugify } from "../../src/util/slug.ts";

describe("slugify", () => {
    it("lowercases and hyphenates", () => {
        expect(slugify("Glimmerfin Drake")).toBe("glimmerfin-drake");
    });
    it("strips quotes and collapses non-alphanumerics", () => {
        expect(slugify("Warden's  Signet!!")).toBe("wardens-signet");
    });
    it("trims leading/trailing hyphens and collapses repeats", () => {
        expect(slugify("  --Murk___Basilisk--  ")).toBe("murk-basilisk");
    });
    it("folds accented characters toward ascii", () => {
        expect(slugify("Éclair Café")).toBe("eclair-cafe");
    });
    it("returns 'entry' for all-symbol or empty input", () => {
        expect(slugify("!!!")).toBe("entry");
        expect(slugify("")).toBe("entry");
    });
});
