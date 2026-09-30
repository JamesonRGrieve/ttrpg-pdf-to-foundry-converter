// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { labelPairs, labelPanel } from "../../src/infer/label-panel.ts";
import { parseHullType } from "../../src/infer/notation.ts";
import {
    hasShipHeader,
    headingHullType,
    isShipLabel,
    isShipProfile,
    parseShip,
    parseWeaponCapacity,
    printedHull,
    shipPairs,
} from "../../src/infer/voidcraft.ts";

const HEADER: [string, string][] = [
    ["Dimensions", "1.2 km long, 0.3 km abeam approx."],
    ["Mass", "5 megatonnes approx."],
    ["Crew", "20,000 crew, approx."],
    ["Accel", "4 gravities max sustainable acceleration"],
];
const PROFILE: [string, string][] = [
    ["Speed", "8 Manoeuvrability: +20"],
    ["Detection", "+15 Hull Integrity: 35"],
    ["Armour", "18 Turret Rating: 2"],
    ["Space", "40 (Used: 38) SP: 40"],
    ["Weapon Capacity", "Dorsal 2, 1 Prow"],
];

describe("label panels", () => {
    const panel = labelPanel(["crew", "crew rating", "mass"]);

    it("reads each label's value to the next label, trying longer labels first", () => {
        const pairs = labelPairs("Crew Rating: Crack (40) Mass: 6 megatonnes", panel);
        expect(pairs.get("crew rating")).toBe("Crack (40)");
        expect(pairs.get("mass")).toBe("6 megatonnes");
        expect(pairs.has("crew")).toBe(false);
    });

    it("keeps only values another label ends when bounded", () => {
        const text = "Mass: 6 megatonnes Crew: 9 crew The ship is old.";
        expect([...labelPairs(text, panel, true)]).toEqual([["mass", "6 megatonnes"]]);
    });

    it("needs the colon unless it is optional and a number follows", () => {
        expect(labelPairs("mass 6", panel).size).toBe(0);
        expect(labelPairs("mass 6", labelPanel(["mass"], true)).get("mass")).toBe("6");
    });
});

describe("ship profiles", () => {
    it("reads fields and the header of running text", () => {
        const body = "Dimensions: 1 km long Mass: 4 megatonnes Accel: 3 gravities The ship is old.";
        const pairs = shipPairs(PROFILE, body);
        expect(pairs.get("manoeuvrability")).toBe("+20");
        expect(pairs.get("dimensions")).toBe("1 km long");
        expect(pairs.get("mass")).toBe("4 megatonnes");
        expect(pairs.has("accel")).toBe(false);
    });

    it("needs numeric profile values to be a ship, and header labels for a header", () => {
        expect(isShipProfile(shipPairs(PROFILE, ""))).toBe(true);
        expect(hasShipHeader(shipPairs(PROFILE, ""))).toBe(false);
        expect(hasShipHeader(shipPairs(HEADER, ""))).toBe(true);
        const explained: [string, string][] = PROFILE.map(([label]) => [label, "It measures the hull."]);
        expect(isShipProfile(shipPairs(explained, ""))).toBe(false);
        const station: [string, string][] = [["Speed", "— Manoeuvrability: —"], ...PROFILE.slice(1)];
        expect(isShipProfile(shipPairs(station, ""))).toBe(true);
    });

    it("recognises the profile's labels", () => {
        expect(isShipLabel("Hull  Integrity")).toBe(true);
        expect(isShipLabel("Cargo Hauler")).toBe(false);
    });

    it("maps the profile onto the voidcraft schema", () => {
        const { system, unparsed } = parseShip(shipPairs([...HEADER, ...PROFILE], ""), "frigate");
        expect(unparsed).toEqual([]);
        expect(system).toEqual({
            speed: 8,
            manoeuvrability: 20,
            detection: 15,
            armour: 18,
            turretRating: 2,
            hullIntegrity: { max: 35, value: 35 },
            space: { total: 40, used: 38 },
            shipPoints: { spent: 0, budget: 40 },
            weaponCapacity: { dorsal: 2, prow: 1, port: 0, starboard: 0, keel: 0 },
            hullType: "frigate",
            hullClass: "Frigate",
            dimensions: "1.2 km long, 0.3 km abeam approx.",
            mass: "5 megatonnes approx.",
            complement: "20,000 crew, approx.",
            acceleration: "4 gravities max sustainable acceleration",
        });
    });

    it("prefers a printed hull, power, crew and total cost", () => {
        const pairs = shipPairs(
            [
                ["Hull", "Light Cruiser"],
                ["Power", "45 (Used: 40)"],
                ["Void Shields", "—"],
                ["Crew Population", "100"],
                ["Crew Rating", "Crack (40)"],
                ["Morale", "99"],
                ["SP Total Cost", "50"],
            ],
            "",
        );
        const { system } = parseShip(pairs, "frigate");
        expect(system["hullType"]).toBe("light-cruiser");
        expect(system["hullClass"]).toBe("Light Cruiser");
        expect(system["power"]).toEqual({ total: 45, used: 40 });
        expect(system["voidShields"]).toBe(0);
        expect(system["crew"]).toEqual({ population: 100, crewRating: 40, morale: { max: 99, value: 99 } });
        expect(system["shipPoints"]).toEqual({ spent: 0, budget: 50 });
    });

    it("reports values it cannot read", () => {
        const unreadable: [string, string][] = [
            ["Speed", "fast"],
            ["Weapon Capacity", "many"],
        ];
        const { unparsed } = parseShip(shipPairs(unreadable, ""), null);
        expect(unparsed).toEqual(["speed: fast", "weapon capacity: many"]);
    });
});

describe("weapon capacity", () => {
    it("reads the list from the start, ignoring a note after it", () => {
        expect(parseWeaponCapacity("Prow 1, Port 2, Starboard 2 (of these slots, 1 port is full)")).toEqual({
            dorsal: 0,
            prow: 1,
            port: 2,
            starboard: 2,
            keel: 0,
        });
        expect(parseWeaponCapacity("1 Prow and 3 Keel Lantern-class Hull")).toEqual({
            dorsal: 0,
            prow: 1,
            port: 0,
            starboard: 0,
            keel: 3,
        });
        expect(parseWeaponCapacity("—")).toEqual({ dorsal: 0, prow: 0, port: 0, starboard: 0, keel: 0 });
        expect(parseWeaponCapacity("Varies")).toBeNull();
    });
});

describe("hull types", () => {
    it("maps printed hulls onto the schema's choices", () => {
        expect(parseHullType("Light Cruisers")).toBe("light-cruiser");
        expect(parseHullType("All Ships")).toBeNull();
        expect(parseHullType("Raiders, Frigates")).toBeNull();
        expect(headingHullType("CRUISER HULLS")).toBe("cruiser");
        expect(headingHullType("Hulls")).toBeNull();
    });

    it("keeps a short free-text hull and cuts one running into prose", () => {
        expect(printedHull("Heavy Cruiser")).toBe("cruiser");
        expect(printedHull("Space Station")).toBe("space-station");
        expect(printedHull("Cruiser Lantern captains are wary of it")).toBe("cruiser");
        expect(printedHull("A drifting lantern of old wicks")).toBeNull();
    });
});
