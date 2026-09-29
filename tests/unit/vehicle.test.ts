// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isVehicleLabel, isVehicleProfile, panelPairs, parseVehicle } from "../../src/infer/vehicle.ts";

const PROFILE = [
    "FRONT:12 SIDE: 9 REAR 7",
    "CRUISING SPEED: 60 KPH TACTICAL SPEED: 12 M",
    "MANOEUVRABILITY: -5 SIZE: ENORMOUS AVL: SC",
    "CARRYING CAPACITY: 4 INTEGRITY: 18 THREAT: 6",
    "CREW: DRIVER (FORE), SPOTTER",
    "VEHICLE TRAITS: ENCLOSED, TRACKED",
    "Mud Skirts: The hauler ignores difficult terrain.",
].join("\n");

describe("vehicle profiles", () => {
    it("reads each schema label's value to the next label on its line", () => {
        const pairs = panelPairs(PROFILE);
        expect(pairs.get("size")).toBe("ENORMOUS");
        expect(pairs.get("avl")).toBe("SC");
        expect(pairs.get("tactical speed")).toBe("12 M");
        expect(pairs.get("rear")).toBe("7");
        expect(pairs.get("vehicle traits")).toBe("ENCLOSED, TRACKED");
        expect(pairs.has("mud skirts")).toBe(false);
    });

    it("needs armour facings and integrity to be a vehicle", () => {
        expect(isVehicleProfile(panelPairs(PROFILE))).toBe(true);
        expect(isVehicleProfile(panelPairs("INTEGRITY: 18\nTHREAT: 6"))).toBe(false);
        expect(isVehicleProfile(panelPairs("The rear 16 metres of the hold."))).toBe(false);
    });

    it("maps the profile onto the land-craft schema", () => {
        const { kind, system, unparsed } = parseVehicle(panelPairs(PROFILE));
        expect(kind).toBe("terracraft");
        expect(unparsed).toEqual([]);
        expect(system).toEqual({
            armour: {
                front: { value: 12, descriptor: "" },
                side: { value: 9, descriptor: "" },
                rear: { value: 7, descriptor: "" },
            },
            speed: { cruising: 60, tactical: 12, notes: "" },
            manoeuverability: -5,
            integrity: { max: 18, value: 18, critical: 0 },
            threatLevel: 6,
            passengers: 4,
            size: 6,
            sizeDescriptor: "Enormous",
            availability: "scarce",
            crew: { required: 2, notes: "Driver (fore), spotter" },
            traitsText: "Enclosed, Tracked",
            locomotion: "tracked",
        });
    });

    it("makes a craft with the Flyer trait an aircraft", () => {
        const { kind, system } = parseVehicle(panelPairs("VEHICLE TRAITS: ENCLOSED, FLYER, SKIMMER"));
        expect(kind).toBe("aircraft");
        expect(system["vehicleClass"]).toBe("air");
        const skimmer = parseVehicle(panelPairs("VEHICLE TRAITS: BIKE, SKIMMER"));
        expect(skimmer.kind).toBe("terracraft");
    });

    it("recognises profile labels however the text layer cased or spaced them", () => {
        expect(isVehicleLabel("CruisingSPEED")).toBe(true);
        expect(isVehicleLabel("Crew")).toBe(true);
        expect(isVehicleLabel("Lantern Sight")).toBe(false);
    });

    it("reports a size off the scale instead of guessing", () => {
        const { system, unparsed } = parseVehicle(panelPairs("SIZE: VAST"));
        expect(system).not.toHaveProperty("size");
        expect(unparsed).toEqual(["size: VAST"]);
    });
});
