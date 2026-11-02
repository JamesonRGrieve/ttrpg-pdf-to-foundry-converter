// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IRTextRun } from "../types/ir.ts";
import { groupByBaseline } from "../util/baselines.ts";

/**
 * A statblock's armour diagram: each hit location printed as its schema
 * abbreviation (H, B, AR, AL, LR, LL — the tokens of the system's own armour
 * point line) beside its hit roll and its armour. Where the diagram prints two
 * numbers at a location, set in two sizes, the larger is the location's whole
 * soak (armour with the Toughness bonus added) and the smaller its armour
 * alone; the schema's location armour is that smaller figure, the system
 * adding the Toughness bonus itself. A dash is no armour. Where it prints one
 * number at each location, that number is the soak. Labels are matched in
 * any case (a text layer may lower-case small capitals).
 */

export type HitLocation = "head" | "body" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

/** Armour points at each of the schema's hit locations. */
export type LocationArmour = Record<HitLocation, number>;

export const HIT_LOCATIONS: readonly HitLocation[] = [
    "head",
    "body",
    "leftArm",
    "rightArm",
    "leftLeg",
    "rightLeg",
];

/** The figures a diagram prints at each location, and whether they are soak (Toughness bonus included). */
export interface ArmourDiagram {
    figures: LocationArmour;
    soak: boolean;
}

/** The system's armour point tokens → hit locations. */
const LOCATION_TOKENS: Readonly<Record<string, HitLocation>> = {
    h: "head",
    b: "body",
    ar: "rightArm",
    al: "leftArm",
    lr: "rightLeg",
    ll: "leftLeg",
};

/** Fewest locations a diagram names for its figures to be read as one. */
const MIN_LOCATIONS = 4;
/** Runs closer than this many points continue one word (a large initial and its small capitals). */
const WORD_GAP = 1.5;
/** Where a location's figures sit relative to its label, in points. */
const REACH = { left: -15, right: 45, below: -22, above: 12 } as const;
/** A size this much smaller than the largest figure's sets a figure apart as the smaller kind. */
const SMALLER = 0.7;

interface Placed {
    text: string;
    x: number;
    y: number;
    size: number;
}

/** A line's runs joined into words where they touch. */
function words(runs: readonly IRTextRun[]): Placed[] {
    const out: Placed[] = [];
    let end = Number.NEGATIVE_INFINITY;
    for (const r of [...runs].sort((a, b) => a.x - b.x)) {
        const text = r.text.trim();
        if (text === "") {
            continue;
        }
        const last = out.at(-1);
        if (last !== undefined && r.x - end <= WORD_GAP) {
            last.text += text;
        } else {
            out.push({ text, x: r.x, y: r.y, size: r.size });
        }
        end = r.x + r.width;
    }
    return out;
}

const isFigure = (w: Placed): boolean => /^(?:\d{1,2}|[-–—])$/u.test(w.text);
const figureValue = (w: Placed): number => (/^\d+$/u.test(w.text) ? Number(w.text) : 0);

/**
 * The armour at each location of a diagram among `runs` (a statblock's runs
 * beside its characteristics); null when they print no such diagram.
 */
export function armourDiagram(runs: readonly IRTextRun[]): ArmourDiagram | null {
    const placed = groupByBaseline([...runs], 2).flatMap((line) => words(line.runs));
    const labels = placed.flatMap((w) => {
        const location = LOCATION_TOKENS[w.text.toLowerCase()];
        return location === undefined ? [] : [{ location, at: w }];
    });
    if (new Set(labels.map((l) => l.location)).size < MIN_LOCATIONS) {
        return null;
    }
    const figures = placed.filter(isFigure);
    const largest = Math.max(0, ...figures.map((f) => f.size));
    const near = (label: Placed, f: Placed): boolean => {
        const dx = f.x - label.x;
        const dy = f.y - label.y;
        return dx >= REACH.left && dx <= REACH.right && dy >= REACH.below && dy <= REACH.above;
    };
    const distance = (a: Placed, b: Placed): number => Math.hypot(a.x - b.x, a.y - b.y);
    const nearest = (label: Placed, pool: readonly Placed[]): Placed | undefined =>
        pool.filter((f) => near(label, f)).sort((a, b) => distance(label, a) - distance(label, b))[0];
    const big = figures.filter((f) => f.size > largest * SMALLER);
    const small = figures.filter((f) => f.size <= largest * SMALLER);
    const twoKinds = labels.some((l) => nearest(l.at, small) !== undefined);
    const figuresAt: LocationArmour = { head: 0, body: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
    let read = 0;
    for (const { location, at } of labels) {
        const figure = nearest(at, twoKinds ? small : big);
        if (figure !== undefined) {
            figuresAt[location] = figureValue(figure);
            read += 1;
        }
    }
    return read >= MIN_LOCATIONS ? { figures: figuresAt, soak: !twoKinds } : null;
}

/**
 * The armour points a diagram reading gives, for a creature whose Toughness
 * bonus is `toughnessBonus`: a soak figure less that bonus (never below 0),
 * as the system's own soak adds it back.
 */
export function diagramArmour(reading: ArmourDiagram, toughnessBonus: number): LocationArmour {
    const at = (location: HitLocation): number =>
        reading.soak ? Math.max(0, reading.figures[location] - toughnessBonus) : reading.figures[location];
    return {
        head: at("head"),
        body: at("body"),
        leftArm: at("leftArm"),
        rightArm: at("rightArm"),
        leftLeg: at("leftLeg"),
        rightLeg: at("rightLeg"),
    };
}
