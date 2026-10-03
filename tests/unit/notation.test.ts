// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    isEmptyCell,
    parseArmourPoints,
    parseAvailability,
    parseCoverage,
    parseDamage,
    parseHullTypes,
    parseInteger,
    parseQualities,
    parseRange,
    parseRateOfFire,
    parseReload,
    parseShipPower,
    parseShipWeaponType,
    parseWeaponClass,
    parseWeight,
} from "../../src/infer/notation.ts";

describe("parseDamage", () => {
    it("reads dice, signed bonus and damage-type letter", () => {
        expect(parseDamage("2d10+3 I")).toEqual({ formula: "2d10", bonus: 3, type: "impact" });
        expect(parseDamage("1d10–2 (E)")).toEqual({ formula: "1d10", bonus: -2, type: "energy" });
        expect(parseDamage("1d5+SB R")).toEqual({ formula: "1d5", bonus: 0, type: "rending" });
    });

    it("repairs an OCR l/I for the dice 'd1' and ignores footnote markers", () => {
        expect(parseDamage("1dl0 X†")).toEqual({ formula: "1d10", bonus: 0, type: "explosive" });
    });

    it("rejects non-damage text", () => {
        expect(parseDamage("Basic")).toBeNull();
        expect(parseDamage("12")).toBeNull();
    });

    it("reads a bonus printed after the type letter, and a flat damage with a type", () => {
        expect(parseDamage("1d10 I+1")).toEqual({ formula: "1d10", bonus: 1, type: "impact" });
        expect(parseDamage("0 I")).toEqual({ formula: "0", bonus: 0, type: "impact" });
        expect(parseDamage("1d5-2\bE")).toEqual({ formula: "1d5", bonus: -2, type: "energy" });
    });
});

describe("parseRange", () => {
    it("reads metres, kilometres and strength-bonus multiples", () => {
        expect(parseRange("100m")).toEqual({ value: 100, units: "m", special: "" });
        expect(parseRange("2 km")).toEqual({ value: 2, units: "km", special: "" });
        expect(parseRange("SBx3")).toEqual({ value: 0, units: "m", special: "SBx3" });
        expect(parseRange("3xSB")).toEqual({ value: 0, units: "m", special: "SBx3" });
    });

    it("reads thousands grouped with commas", () => {
        expect(parseRange("3,500m")).toEqual({ value: 3500, units: "m", special: "" });
        expect(parseRange("1,20m")).toBeNull();
    });

    it("rejects non-range text", () => {
        expect(parseRange("Melee")).toBeNull();
    });
});

describe("parseRateOfFire", () => {
    it("reads single, semi and full modes, dash as zero", () => {
        expect(parseRateOfFire("S/3/-")).toEqual({ single: true, semi: 3, full: 0 });
        expect(parseRateOfFire("–/–/10")).toEqual({ single: false, semi: 0, full: 10 });
    });

    it("reads an empty mode field as no such mode", () => {
        expect(parseRateOfFire("S/–/")).toEqual({ single: true, semi: 0, full: 0 });
    });

    it("rejects malformed triples", () => {
        expect(parseRateOfFire("S/3")).toBeNull();
        expect(parseRateOfFire("X/3/2")).toBeNull();
    });
});

describe("parseReload", () => {
    it("maps actions to reload keys", () => {
        expect(parseReload("Full")).toBe("full");
        expect(parseReload("2 Full")).toBe("2-full");
        expect(parseReload("Half")).toBe("half");
        expect(parseReload("—")).toBe("-");
        expect(parseReload("Sometimes")).toBeNull();
        expect(parseReload("Rld 5 Full")).toBe("5-full");
    });
});

describe("parseWeight / parseInteger", () => {
    it("reads kilograms and treats a dash as zero", () => {
        expect(parseWeight("4.5kg")).toBe(4.5);
        expect(parseWeight("15 kg")).toBe(15);
        expect(parseWeight("-")).toBe(0);
        expect(parseWeight(".5kg")).toBe(0.5);
        expect(parseWeight(".02 kg")).toBe(0.02);
        expect(parseWeight("�75kg")).toBe(0.75);
        expect(parseWeight("2�5kg")).toBe(2.5);
        expect(parseWeight("heavy")).toBeNull();
    });

    it("reads signed integers", () => {
        expect(parseInteger("+10")).toBe(10);
        expect(parseInteger("-5")).toBe(-5);
        expect(parseInteger("n/a")).toBe(0);
        expect(parseInteger("x")).toBeNull();
    });

    it("recognizes empty cells", () => {
        expect(isEmptyCell(" – ")).toBe(true);
        expect(isEmptyCell("N/A")).toBe(true);
        expect(isEmptyCell("3")).toBe(false);
    });
});

describe("parseDamage reading a misread type letter", () => {
    it("takes a lone 1, l or | after the damage for the type I, but keeps a bonus that joins it", () => {
        expect(parseDamage("1d10+2 1")).toEqual({ formula: "1d10", bonus: 2, type: "impact" });
        expect(parseDamage("2d10+7 l")).toEqual({ formula: "2d10", bonus: 7, type: "impact" });
        expect(parseDamage("1d10+21")).toEqual({ formula: "1d10", bonus: 21, type: "" });
    });
});

describe("parseArmourPoints", () => {
    it("reads plain points and locations printed apart in parentheses", () => {
        expect(parseArmourPoints("4")).toEqual({ base: 4, exceptions: {} });
        expect(parseArmourPoints("8 (Body 10)")).toEqual({ base: 8, exceptions: { body: 10 } });
        expect(parseArmourPoints("5 (4 on Head)")).toEqual({ base: 5, exceptions: { head: 4 } });
        expect(parseArmourPoints("6 (Arms 4, Legs 5)")).toEqual({
            base: 6,
            exceptions: { leftArm: 4, rightArm: 4, leftLeg: 5, rightLeg: 5 },
        });
    });

    it("leaves a bare conditional value to the text, and rejects other notation", () => {
        expect(parseArmourPoints("3 (6)")).toEqual({ base: 3, exceptions: {} });
        expect(parseArmourPoints("4 (vs fire)")).toBeNull();
        expect(parseArmourPoints("Body")).toBeNull();
    });
});

describe("parseQualities", () => {
    it("slugs qualities, folds ratings, sorts, and keeps commas inside parentheses", () => {
        expect(parseQualities("Sturdy, Spread (3), Quiet")).toEqual(["quiet", "spread-3", "sturdy"]);
        expect(parseQualities("Graded (2, 3)")).toEqual(["graded-2,3"]);
        expect(parseQualities("—")).toEqual([]);
    });

    it("drops a 'Special' entry that points to the weapon's text", () => {
        expect(parseQualities("Balanced, Special")).toEqual(["balanced"]);
        expect(parseQualities("Special")).toEqual([]);
    });

    it("leaves out a further list joined on with a plus, but not a plus inside a rating", () => {
        expect(parseQualities("Balanced, Felling (4) + Accursed, Rampage")).toEqual([
            "balanced",
            "felling-4",
        ]);
        expect(parseQualities("Blast (1d5 + 2)")).toEqual(["blast-1d5+2"]);
    });

    it("folds a rating printed in square brackets, and mends a word broken at its hyphen", () => {
        expect(parseQualities("Toxic [4], Felling [2, 3]")).toEqual(["felling-2,3", "toxic-4"]);
        expect(parseQualities("Twin- Linked, Quiet")).toEqual(["quiet", "twin-linked"]);
    });
});

describe("parseAvailability", () => {
    it("matches full names and hyphenated forms", () => {
        expect(parseAvailability("Very Rare")).toBe("very-rare");
        expect(parseAvailability("Near Unique")).toBe("near-unique");
        expect(parseAvailability("Common")).toBe("common");
    });

    it("resolves abbreviations structurally against the enum", () => {
        expect(parseAvailability("VR")).toBe("very-rare");
        expect(parseAvailability("ER")).toBe("extremely-rare");
        expect(parseAvailability("Sc")).toBe("scarce");
        expect(parseAvailability("Av")).toBe("average");
        expect(parseAvailability("Cm")).toBe("common");
        expect(parseAvailability("Ra")).toBe("rare");
    });

    it("returns null for non-availability text", () => {
        expect(parseAvailability("")).toBeNull();
        expect(parseAvailability("xyz")).toBeNull();
    });
});

describe("parseCoverage", () => {
    it("expands location words in schema order", () => {
        expect(parseCoverage("Body, Arms")).toEqual(["body", "leftArm", "rightArm"]);
        expect(parseCoverage("All")).toEqual(["head", "body", "leftArm", "rightArm", "leftLeg", "rightLeg"]);
        expect(parseCoverage("Head")).toEqual(["head"]);
    });

    it("reads a list whose separator was lost word by word", () => {
        expect(parseCoverage("Body Arms, Legs")).toEqual([
            "body",
            "leftArm",
            "rightArm",
            "leftLeg",
            "rightLeg",
        ]);
        expect(parseCoverage("Head Left Arm")).toEqual(["head", "leftArm"]);
        expect(parseCoverage("A rms, Body, Legs")).toEqual([
            "body",
            "leftArm",
            "rightArm",
            "leftLeg",
            "rightLeg",
        ]);
    });

    it("rejects unknown location words", () => {
        expect(parseCoverage("Tail")).toBeNull();
        expect(parseCoverage("Body Tail")).toBeNull();
    });
});

describe("parseWeaponClass", () => {
    it("takes the first weapon-class word", () => {
        expect(parseWeaponClass("Basic")).toBe("basic");
        expect(parseWeaponClass("Pistol/Melee")).toBe("pistol");
        expect(parseWeaponClass("Something")).toBeNull();
    });
});

describe("ship component cells", () => {
    it("reads power drawn, or made when signed", () => {
        expect(parseShipPower("4")).toEqual({ used: 4, generated: 0 });
        expect(parseShipPower("+40")).toEqual({ used: 0, generated: 40 });
        expect(parseShipPower("—")).toEqual({ used: 0, generated: 0 });
        expect(parseShipPower("a lot")).toBeNull();
    });

    it("reads hull types onto the schema's choices", () => {
        expect(parseHullTypes("All Ships")).toEqual(["all"]);
        expect(parseHullTypes("Raiders, Frigates")).toEqual(["raider", "frigate"]);
        expect(parseHullTypes("Light Cruisers, Cruisers")).toEqual(["light-cruiser", "cruiser"]);
        expect(parseHullTypes("Transports and Cruisers")).toEqual(["transport", "cruiser"]);
        expect(parseHullTypes("Lamp Boats")).toBeNull();
    });

    it("reads a ship weapon type, singular or plural, before its mounting", () => {
        expect(parseShipWeaponType("Macrobatteries")).toBe("macrobattery");
        expect(parseShipWeaponType("Nova Cannons")).toBe("nova-cannon");
        expect(parseShipWeaponType("Torpedo Tubes")).toBe("torpedo");
        expect(parseShipWeaponType("Landing Bays")).toBe("landing-bay");
        expect(parseShipWeaponType("Lamp Arrays")).toBeNull();
    });
});
