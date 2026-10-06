// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
    headerRole,
    isAdvanceList,
    isAttributeScale,
    mergedHeaderRoles,
    normalizeHeader,
    shipTableRoles,
} from "../../src/infer/columns.ts";
import {
    detectEntries,
    endsSentence,
    type Entry,
    headingOf,
    runningHeads,
    type TextLine,
    valueUnfinished,
    withoutFigures,
} from "../../src/infer/detect-entries.ts";
import {
    detectNumericGrids,
    panelBlocks,
    splitBannerText,
    trimToCapitals,
} from "../../src/infer/detect-grids.ts";
import { groupByKeyAnchors, joinContinuations, tableBody } from "../../src/infer/detect-titled-tables.ts";
import {
    entryItem,
    entryType,
    headingKindTag,
    joinSkillCharacteristics,
    typeNamedBy,
} from "../../src/infer/entry-types.ts";
import {
    cleanName,
    endsMidSentence,
    headingLabels,
    readsAsProse,
    rejoinSplitWords,
    restoreWordSpaces,
    splitTier,
    startsLikeName,
    stripHeadingLabel,
    titleCase,
    wordsOf,
} from "../../src/infer/names.ts";
import {
    armourOf,
    listedItems,
    parseNpc,
    rejoinSmallCaps,
    specialAbilities,
    splitFields,
} from "../../src/infer/npc.ts";
import { inferPageNumbering, printedPage } from "../../src/infer/page-numbers.ts";
import {
    citeFirstPage,
    embedNpcItems,
    fitModifications,
    givenNames,
    infer,
    splitNumberFromText,
    introducingEntry,
    keyedByBands,
    namingEntry,
    isBlank,
    kindEntry,
    mergeInto,
    modalHeadingSizes,
    nameKey,
    siblingKinds,
    singularKey,
    type TableRecord,
    withSubProfiles,
} from "../../src/infer/pipeline.ts";
import { mergeContinuationRows } from "../../src/infer/row-merge.ts";
import { mapRow, type RowCells } from "../../src/infer/rows.ts";
import { buildItem, costShape, DEFAULT_LINE, type Line, packName, toHtml } from "../../src/infer/schema.ts";
import { TARGETS } from "../../src/infer/targets.ts";
import type { DetectedTable } from "../../src/infer/types.ts";
import { createLogger } from "../../src/logger.ts";
import type { Entity, JsonObject, JsonValue } from "../../src/types/entity.ts";
import type { IR, IRTextRun } from "../../src/types/ir.ts";
import { inMarginBand, inSideMargin, measureMarginBands } from "../../src/util/page-bands.ts";

function irOf(pageIndexes: number[], runs: IRTextRun[]): IR {
    return {
        irVersion: 0,
        pages: pageIndexes.map((p) => ({
            pageIndex: p,
            width: 600,
            height: 800,
            rotation: 0,
            columns: 1,
            edgeText: [],
            hasTextLayer: true,
        })),
        runs,
        sizeBuckets: [],
        fonts: [],
        meta: { title: null, author: null, producer: null, creator: null, creationDate: null },
        fingerprint: {
            pageSizes: [],
            orientation: "portrait",
            columns: 1,
            fonts: [],
            sizeBuckets: [],
            marginBox: { left: 0, right: 0, top: 0, bottom: 0 },
        },
    };
}

function irRun(text: string, pageIndex: number, y: number): IRTextRun {
    return {
        pageIndex,
        band: 0,
        x: 300,
        y,
        width: 10,
        height: 8,
        text,
        font: "f",
        weight: "normal",
        italic: false,
        size: 8,
        sizeBucket: 0,
        column: 0,
        indent: 0,
        renderOrder: 0,
    };
}

describe("splitNumberFromText", () => {
    it("takes the one bare number of a merged words-and-count cell as the count", () => {
        expect(splitNumberFromText("Head, Arms, 8 Body, Legs", ["locations", "armourPoints"])).toEqual({
            numberRole: "armourPoints",
            number: "8",
            textRole: "locations",
            text: "Head, Arms, Body, Legs",
        });
    });

    it("declines two counts, no count, or roles that are not one of each", () => {
        expect(splitNumberFromText("Head 4 Body 6", ["locations", "armourPoints"])).toBeNull();
        expect(splitNumberFromText("Head, Body", ["locations", "armourPoints"])).toBeNull();
        expect(splitNumberFromText("4 6", ["clip", "penetration"])).toBeNull();
        expect(splitNumberFromText("Head 4", ["locations"])).toBeNull();
    });
});

describe("withSubProfiles", () => {
    const record = (name: string, cells: RowCells): TableRecord => ({
        name,
        itemType: "weapon",
        cells,
        mapped: mapRow("weapon", cells),
    });

    it("folds a weapon's labelled sub-rows into its modes, the first giving its own profile", () => {
        const out = withSubProfiles([
            record("Lamp Rifle", {
                name: "Lamp Rifle",
                class: "Basic",
                range: "110m",
                damage: "†",
                penetration: "†",
            }),
            record("Lamp Rifle (Ember Round)", {
                name: "Lamp Rifle (Ember Round)",
                rof: "S/2/–",
                damage: "1d10+5 E",
                penetration: "1",
                clip: "6",
                reload: "2 Full",
            }),
            record("Lamp Rifle (Wick Round)", {
                name: "Lamp Rifle (Wick Round)",
                damage: "1d10+7 R",
                penetration: "5",
            }),
            record("Wick Gun", { name: "Wick Gun", class: "Basic", damage: "1d10 I" }),
        ]);
        expect(out.map((r) => r.name)).toEqual(["Lamp Rifle", "Wick Gun"]);
        const system = out[0]?.mapped.system ?? {};
        expect(system["damage"]).toMatchObject({ formula: "1d10", bonus: 5, type: "energy", penetration: 1 });
        expect(system["reload"]).toBe("2-full");
        expect(system).toMatchObject({
            modes: [
                {
                    label: "Ember Round",
                    damage: "1d10",
                    damageBonus: 5,
                    penetration: 1,
                    clipMax: 6,
                    reload: "2-full",
                },
                { label: "Wick Round", damage: "1d10", damageBonus: 7, penetration: 5 },
            ],
        });
    });

    it("leaves a qualified row alone when its weapon prints its own profile", () => {
        const out = withSubProfiles([
            record("Lamp Hammer (light)", { name: "Lamp Hammer (light)", class: "Melee", damage: "1d10 I" }),
            record("Lamp Hammer", { name: "Lamp Hammer", class: "Melee", damage: "2d10 I" }),
            record("Lamp Hammer (heavy)", {
                name: "Lamp Hammer (heavy)",
                class: "Melee",
                damage: "2d10+2 I",
            }),
        ]);
        expect(out.map((r) => r.name)).toEqual(["Lamp Hammer (light)", "Lamp Hammer", "Lamp Hammer (heavy)"]);
    });
});

describe("singularKey", () => {
    it("gives singular and plural forms of a name one key", () => {
        expect(singularKey("Wick Rockets")).toBe(singularKey("Wick Rocket"));
        expect(singularKey("Glass")).toBe("glass");
        expect(singularKey("Lamp (heavy)")).not.toBe(singularKey("Lamp"));
    });
});

describe("givenNames", () => {
    it("keys each name, and each without a closing qualifier", () => {
        const names = givenNames(["Lamp Hammer (light)", "Lamp Hammer (heavy)", "Wick Gun"]);
        expect(names.has(nameKey("Lamp Hammer"))).toBe(true);
        expect(names.has(nameKey("Lamp Hammer (light)"))).toBe(true);
        expect(names.has(nameKey("Wick Gun"))).toBe(true);
        expect(names.has(nameKey("Lamp"))).toBe(false);
    });
});

describe("columns", () => {
    it("maps schema field headers, including letter-spaced display text", () => {
        expect(headerRole("DAM")).toBe("damage");
        expect(headerRole("Rate of Fire")).toBe("rof");
        expect(headerRole("D AM")).toBe("damage");
        expect(headerRole("Locations Covered")).toBe("locations");
        expect(headerRole("Location(s) Covered")).toBe("locations");
        expect(headerRole("Armour Type")).toBe("name");
        expect(headerRole("Talent Name")).toBe("name");
        expect(headerRole("Names")).toBe("name");
        expect(headerRole("Type")).toBe("type");
        expect(headerRole("Special + Bound Attributes")).toBe("special");
        expect(headerRole("Special Rules")).toBe("special");
        expect(headerRole("Covered")).toBe("locations");
        expect(headerRole("LocationsCovered")).toBe("locations");
        expect(mergedHeaderRoles("Location(s) AP")).toEqual(["locations", "armourPoints"]);
        expect(headerRole("Availabiity")).toBe("availability");
        expect(headerRole("Mystery")).toBeNull();
        expect(normalizeHeader("  Max  Ag ")).toBe("max ag");
    });

    it("splits a merged header only when every word is a role", () => {
        expect(mergedHeaderRoles("Clip Rld")).toEqual(["clip", "reload"]);
        expect(mergedHeaderRoles("Clip Colour")).toBeNull();
    });

    it("treats a table led by an availability, weight or cost column as a scale", () => {
        expect(isAttributeScale(["availability"])).toBe(true);
        expect(isAttributeScale(["weight", "availability"])).toBe(true);
        expect(isAttributeScale(["name"])).toBe(false);
        expect(headerRole("Advance")).toBe("advance");
        expect(isAdvanceList(["advance"])).toBe(true);
        expect(isAdvanceList(["name"])).toBe(false);
        expect(isAdvanceList(["name", "cost", "type", "prerequisites"])).toBe(true);
        expect(isAdvanceList(["name", "prerequisites", "benefit"])).toBe(false);
        expect(isAdvanceList(["name", "weight", "cost", "availability"])).toBe(false);
        expect(isAttributeScale(["roll"])).toBe(false);
        expect(isAttributeScale(null)).toBe(false);
    });

    it("reads a Power column as power only in a table of ship components", () => {
        const headers = ["Lamp Components", "Power", "Space", "SP"];
        const roles = headers.map((h) => {
            const role = headerRole(h);
            return role === null ? null : [role];
        });
        expect(roles[1]).toEqual(["name"]);
        expect(shipTableRoles(roles, headers)).toEqual([null, ["power"], ["space"], ["shipPoints"]]);
        expect(shipTableRoles([["name"], null], ["Power", "Threshold"])).toEqual([["name"], null]);
    });

    it("reads a ship weapon's strength and crit rating only in a ship table", () => {
        const headers = ["Lamp Weapons", "Space", "SP", "Strength", "Crit Rating"];
        const roles = headers.map((h) => {
            const role = headerRole(h);
            return role === null ? null : [role];
        });
        expect(shipTableRoles(roles, headers).slice(3)).toEqual([["strength"], ["crit"]]);
        expect(shipTableRoles([null, null], ["Strength", "Crit Rating"])).toEqual([null, null]);
    });
});

describe("names", () => {
    it("title-cases all-caps names, leaving mixed case and short function words alone", () => {
        expect(titleCase("HALL OF THE LANTERN-BEARER")).toBe("Hall of the Lantern-Bearer");
        expect(titleCase("Already Cased")).toBe("Already Cased");
        expect(titleCase("McAllister Lamp")).toBe("McAllister Lamp");
        expect(titleCase("lamplighter")).toBe("Lamplighter");
        expect(titleCase("WIck Keeper")).toBe("Wick Keeper");
        expect(titleCase("LamPLighter")).toBe("Lamplighter");
        expect(titleCase("MARSH world")).toBe("Marsh World");
        expect(titleCase("lantern heavy Trike")).toBe("Lantern Heavy Trike");
        expect(titleCase("Lantern (any Oil)")).toBe("Lantern (any Oil)");
        expect(titleCase("wick-waRden hollis")).toBe("Wick-Warden Hollis");
        expect(titleCase("Hollis LAMPWRIGHT, WicK KeepeR")).toBe("Hollis Lampwright, Wick Keeper");
        expect(titleCase("LanTern KEEPER")).toBe("Lantern Keeper");
        expect(titleCase("Lantern of ASHWICK")).toBe("Lantern of Ashwick");
        expect(titleCase("Lantern Mk IV")).toBe("Lantern Mk IV");
        expect(cleanName("  QUIET TREAD† :")).toBe("Quiet Tread");
        expect(cleanName("Hood/ Cowl")).toBe("Hood/Cowl");
        expect(cleanName("Hard (-20)/ GM's call")).toBe("Hard (-20)/ GM's call");
    });

    it("rejoins a word the text layer split, when the prose spells it whole", () => {
        // The prose holds the split banner once, and the whole word more often.
        const prose = wordsOf(
            "LANTERN WRIGHT. Old Lanternwright tends the wicks; Lanternwright's lamps glow.",
        );
        expect(prose.slice(0, 3)).toEqual(["lantern", "wright", "old"]);
        expect(rejoinSplitWords("Lantern Wright", prose)).toBe("Lanternwright");
        expect(rejoinSplitWords(titleCase("LanTern WRIGHT"), prose)).toBe("Lanternwright");
        expect(rejoinSplitWords("Wick Keeper", prose)).toBe("Wick Keeper");
        // Two words the prose uses apart more often stay apart.
        expect(rejoinSplitWords("Hive World", wordsOf("a hive world; the hive world; a hiveworld"))).toBe(
            "Hive World",
        );
    });

    it("tells a title-like name from a sentence", () => {
        expect(readsAsProse("Lantern of the Deep Ward")).toBe(false);
        expect(readsAsProse("Glow-globe")).toBe(false);
        expect(readsAsProse("Some lanterns are only lit at dusk")).toBe(true);
        expect(startsLikeName("“Lamp’s Glow” Oil Flask")).toBe(true);
        expect(startsLikeName("(Heavy) Lantern")).toBe(true);
        expect(startsLikeName("lantern oil")).toBe(false);
        expect(endsMidSentence("Half Action unless")).toBe(true);
        expect(endsMidSentence("Lantern of")).toBe(true);
        expect(endsMidSentence("Lantern of the Deep Ward")).toBe(false);
        expect(endsMidSentence("Wick trimmer")).toBe(false);
    });

    it("keeps connecting words lower case inside a title", () => {
        expect(titleCase("CLUES FROM THE REEDS")).toBe("Clues from the Reeds");
    });

    it("restores a word space the text layer dropped inside a title", () => {
        expect(restoreWordSpaces("Glow CriticalEffects - Arm")).toBe("Glow Critical Effects - Arm");
        expect(restoreWordSpaces("Lantern Fuel")).toBe("Lantern Fuel");
    });

    it("takes a schema tier out of a statblock heading", () => {
        expect(splitTier("REEDSTALKER (Elite)")).toEqual({ name: "Reedstalker", tier: "elite" });
        expect(splitTier("Lamp (Brass)")).toEqual({ name: "Lamp (Brass)", tier: null });
        // A plural tier names the same tier.
        expect(splitTier("WICK HOUND (TROOPS)")).toEqual({ name: "Wick Hound", tier: "troop" });
    });

    it("strips a numbered label the document grades its headings by", () => {
        const headings = ["Rank 1: Glow", "Rank 2: Flare", "rank 3: Blaze", "Lamp 9: Wick", "Plain Name"];
        const labels = headingLabels(headings);
        expect([...labels]).toEqual(["rank"]);
        expect(headings.map((h) => stripHeadingLabel(h, labels))).toEqual([
            "Glow",
            "Flare",
            "Blaze",
            "Lamp 9: Wick",
            "Plain Name",
        ]);
    });
});

describe("row merging", () => {
    type Line = { y: number; runs: IRTextRun[] };
    /** A line at `y` filling `cells` table columns (one run per column) in `font`. */
    const line = (y: number, cells: number, text = "X", font = "f"): Line => ({
        y,
        runs: Array.from({ length: cells }, (_, i) => ({ ...irRun(text, 0, y), x: 100 * i, font })),
    });
    /** A line whose runs are the given cell texts, one per column ("" leaves a column empty). */
    const textLine = (y: number, texts: string[]): Line => ({
        y,
        runs: texts.map((t, i) => ({ ...irRun(t, 0, y), x: 100 * i })),
    });
    /** One cell per run by x (100 pt columns), so empty columns stay in place. */
    const shape = {
        cells: (row: Line): string[] => {
            const out = ["", "", "", ""];
            for (const r of row.runs) {
                const col = Math.round(r.x / 100) % out.length;
                out[col] = `${out[col]} ${r.text}`.trim();
            }
            return out;
        },
    };

    it("joins a key-only line and a mid-sentence line to their row even at uniform spacing", () => {
        const rows = [
            textLine(100, ["Glow Aura", "Sheds light."]),
            textLine(90, ["Deep Ward", "Wards off the"]),
            textLine(80, ["Charm", "unquiet dead."]),
            textLine(70, ["Tidal", "Moves water."]),
            textLine(60, ["Pull", ""]),
            textLine(50, ["Hush", "Silences."]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => r.y)).toEqual([100, 90, 70, 50]);
    });

    it("keeps a name wrapped around its row's centred values in one record", () => {
        const rows = [
            textLine(200, ["Glimmer", "", ""]),
            textLine(194.6, ["", "Thrown", "Rare"]),
            textLine(189.2, ["Device", "", ""]),
            textLine(177, ["Wick", "", ""]),
            textLine(171.6, ["", "Thrown", "Common"]),
            textLine(166.2, ["Bomb", "", ""]),
            textLine(154, ["Lamp Mine", "Heavy", "Rare"]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => shape.cells(r)[0])).toEqual([
            "Glimmer Device",
            "Wick Bomb",
            "Lamp Mine",
        ]);
    });

    it("gives a name's first line to the record below when its values sit beside its last line", () => {
        const rows = [
            textLine(200, ["Wick Cannons", "All", "3"]),
            textLine(186, ["Wick Cannon", "", ""]),
            textLine(180, ["Broadside", "Some", "6"]),
            textLine(166, ["Lamp Battery", "All", "4"]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => shape.cells(r)[0])).toEqual([
            "Wick Cannons",
            "Wick Cannon Broadside",
            "Lamp Battery",
        ]);
        // …also straight under a section row set in another face.
        const section = line(212, 1, "Lamps", "bold");
        const underSection = [
            section,
            textLine(200, ["Wick", "", ""]),
            textLine(194, ["Cannon", "All", "3"]),
        ];
        expect(mergeContinuationRows(underSection, shape).map((r) => shape.cells(r)[0])).toEqual([
            "Lamps",
            "Wick Cannon",
        ]);
    });

    it("joins a line carrying the rest of a list cell that broke off, but not a numbered record", () => {
        const rows = [
            textLine(200, ["Wick Gun", "Accurate,", "3"]),
            textLine(194, ["(Long)", "Tearing", ""]),
            textLine(182, ["Lamp Gun", "Reliable", "4"]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => shape.cells(r)[0])).toEqual([
            "Wick Gun (Long)",
            "Lamp Gun",
        ]);
        const bands = [
            textLine(200, ["7", "The lamp gutters,", ""]),
            textLine(194, ["8", "The wick snaps.", ""]),
            textLine(188, ["9", "Darkness falls.", ""]),
        ];
        expect(mergeContinuationRows(bands, shape)).toHaveLength(3);
    });

    it("joins a line that wraps several unfinished cells, one of them mid-sentence", () => {
        const rows = [
            textLine(100, ["Deep", "Glow 40,", "Soothes the"]),
            textLine(90, ["Ward", "Glow Aura", "restless."]),
            textLine(80, ["Tide Call", "Glow 30", "Calls the"]),
            textLine(70, ["Hush", "Glow 20", "Silences."]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => r.y)).toEqual([100, 80, 70]);
    });

    it("joins a short line that breaks off mid-phrase to the line completing it", () => {
        const rows = [
            textLine(100, ["Low Grade (Reed Mat,", "", ""]),
            textLine(90, ["Straw Bed, Hay Loft)", "5", "Common"]),
            textLine(80, ["High Grade (Feather Bed,", "", ""]),
            textLine(70, ["Silk Canopy)", "40", "Rare"]),
            textLine(60, ["Poor", "", "", "Int 30,"]),
            textLine(50, ["(hedge healer)", "50", "Average", "Medicae skill"]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => r.y)).toEqual([100, 80, 60]);
    });

    it("treats a capitalized key line as a new record unless the row above ends on a connecting word", () => {
        const rows = [
            line(100, 4, "Bastion of"),
            line(90, 2, "Iron Will"),
            line(75, 4, "Lamp"),
            line(65, 2, "Rope"),
            line(50, 4),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => r.y)).toEqual([100, 75, 65, 50]);
    });

    it("joins a capitalized fragment of a wide row at the leading inside a row", () => {
        const wide = {
            cells: (row: Line): string[] => {
                const out: string[] = Array.from({ length: 12 }, () => "");
                for (const r of row.runs) {
                    const col = Math.round(r.x / 100);
                    out[col] = `${out[col] ?? ""} ${r.text}`.trim();
                }
                return out;
            },
        };
        const rows = [line(100, 9, "Lamp"), line(92, 2, "Oil"), line(75, 9), line(60, 9), line(45, 9)];
        expect(mergeContinuationRows(rows, wide).map((r) => r.y)).toEqual([100, 75, 60, 45]);
    });

    it("joins a tightly spaced line that fills fewer columns than a typical row", () => {
        const rows = [line(100, 4), line(90, 2, "x"), line(75, 4), line(60, 4), line(50, 1), line(35, 4)];
        expect(mergeContinuationRows(rows, shape).map((r) => r.y)).toEqual([100, 75, 60, 35]);
    });

    it("keeps full rows separate even when a section row makes their spacing look tight", () => {
        const rows = [
            line(100, 1),
            line(80, 4),
            line(70, 4),
            line(60, 4),
            line(40, 1),
            line(20, 4),
            line(10, 4),
        ];
        expect(mergeContinuationRows(rows, shape)).toHaveLength(7);
    });

    it("never joins a line set in another face (a section label or footnote)", () => {
        const rows = [line(100, 4), line(90, 1, "x", "label-face"), line(75, 4), line(65, 1), line(50, 4)];
        expect(mergeContinuationRows(rows, shape).map((r) => r.y)).toEqual([100, 90, 75, 50]);
    });

    it("keeps a uniformly spaced record with blank cells when its cells stand alone", () => {
        const rows = [line(100, 4), line(85, 2), line(70, 4), line(55, 4)];
        expect(mergeContinuationRows(rows, shape)).toHaveLength(4);
    });
});

describe("page numbering", () => {
    it("finds the folio offset from margin numbers agreeing across pages", () => {
        const runs = [3, 4, 5, 6].map((p) => irRun(String(p + 2), p, 20));
        const numbering = inferPageNumbering(irOf([3, 4, 5, 6], runs));
        expect(numbering.offset).toBe(2);
        expect(printedPage(numbering, 10)).toBe("12");
    });

    it("numbers a part of the book whose folios agree on their own offset by it", () => {
        // Pages 3–9 print folios two ahead; pages 20–25 five behind; two stray
        // numbers on pages 40–41 agree with each other and nothing else.
        const runs = [
            ...[3, 4, 5, 6, 7, 8, 9].map((p) => irRun(String(p + 2), p, 20)),
            ...[20, 21, 22, 23, 24, 25].map((p) => irRun(String(p - 5), p, 20)),
            irRun("7", 40, 20),
            irRun("8", 41, 20),
        ];
        const numbering = inferPageNumbering(
            irOf([3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 24, 25, 40, 41], runs),
        );
        expect([4, 12, 22, 40].map((p) => printedPage(numbering, p))).toEqual(["6", "14", "17", "42"]);
    });

    it("falls back to 1-based PDF pages without consistent folios", () => {
        expect(printedPage(inferPageNumbering(irOf([], [])), 0)).toBe("1");
    });
});

describe("npc statblocks", () => {
    it("ends a banner's name at its first standalone number, the headline value", () => {
        expect(splitBannerText("MIRE HOUND (TROOP) 9")).toEqual({ name: "MIRE HOUND (TROOP)", number: 9 });
        expect(splitBannerText("REED KING (MASTER) 14 PEN SPECIAL:")).toEqual({
            name: "REED KING (MASTER)",
            number: 14,
        });
        expect(splitBannerText("2 LANTERN-BEARER")).toEqual({ name: "LANTERN-BEARER", number: null });
    });

    it("rejoins letter-split small-caps labels", () => {
        expect(rejoinSmallCaps("H ALF 3 C HARGE 9")).toBe("HALF 3 CHARGE 9");
    });

    it("splits labelled fields", () => {
        expect(splitFields("Wounds: 12 Movement: 3/6/9/18 Skills: Awareness")).toEqual({
            wounds: "12",
            movement: "3/6/9/18",
            skills: "Awareness",
        });
    });

    it("parses characteristics, tier, panel movement and threat", () => {
        const npc = parseNpc({
            pageIndex: 0,
            name: "MIRE HOUND (Troop)",
            caption: null,
            bannerNumber: 9,
            labels: ["ws", "bs", "s", "t", "ag", "int", "per", "wp", "fel"],
            values: [30, 0, 35, 33, 40, 12, 38, 25, 5],
            associatedText: ["H ALF 5 FULL 10 CHARGE 15 RUN 30 THREAT 7"],
            blocks: [
                { label: null, text: "H ALF 5 FULL 10 CHARGE 15 RUN 30 THREAT 7", pageIndex: 0 },
                { label: "Special", text: "Tearing", pageIndex: 0 },
                { label: "Skills", text: "Awareness (Per)", pageIndex: 0 },
                {
                    label: "Marsh Stride",
                    text: "The hound ignores difficult terrain in wetlands.",
                    pageIndex: 1,
                },
            ],
        });
        expect(npc.name).toBe("Mire Hound");
        expect(npc.abilities).toEqual([
            { name: "Marsh Stride", text: "The hound ignores difficult terrain in wetlands.", pageIndex: 1 },
        ]);
        expect(npc.system["tier"]).toBe("troop");
        expect(npc.system["wounds"]).toEqual({ max: 9, value: 9, critical: 0 });
        expect(npc.system["threatLevel"]).toBe(7);
        expect(npc.system["movement"]).toEqual({ half: 5, full: 10, charge: 15, run: 30 });
    });

    it("reads armour lines into hit locations", () => {
        const at = (line: string) => {
            const armour = armourOf(line);
            const loc = armour === null ? null : Object(armour["locations"]);
            return loc === null
                ? null
                : [loc.head, loc.body, loc.rightArm, loc.leftArm, loc.rightLeg, loc.leftLeg];
        };
        expect(at("Wick Coat (4 All) Total TB: 3")).toEqual([4, 4, 4, 4, 4, 4]);
        expect(at("Robes (3 All except Head)")).toEqual([0, 3, 3, 3, 3, 3]);
        expect(at("Lamp Plate (8 All, 10 Body)")).toEqual([8, 10, 8, 8, 8, 8]);
        expect(at("6 Head, 4 All")).toEqual([6, 4, 4, 4, 4, 4]);
        expect(at("Glow Vest (3 Chest)")).toEqual([0, 3, 0, 0, 0, 0]);
        expect(at("Hides (Head 2, Right Arm 3, Left Arm 1, Body 4, Right Leg 2, Left Leg 2)")).toEqual([
            2, 4, 3, 1, 2, 2,
        ]);
        expect(at("Reed Mail (2 Body, Arms, Legs)")).toEqual([0, 2, 2, 2, 2, 2]);
        expect(at("None (All 5)")).toEqual([5, 5, 5, 5, 5, 5]);
        expect(at("7")).toEqual([7, 7, 7, 7, 7, 7]);
        expect(at("None Total TB: 3")).toEqual([0, 0, 0, 0, 0, 0]);
        expect(at("Front 20, Side 18, Rear 12")).toBeNull();
    });

    it("lists a statblock's talents, traits, weapons and gear as bare items", () => {
        expect(listedItems("Keen Eye, Hatred (Moths, Gnats), None.", "talent")).toEqual([
            { name: "Keen Eye", type: "talent" },
            { name: "Hatred (Moths, Gnats)", type: "talent", specialization: "Moths, Gnats" },
        ]);
        expect(
            listedItems("Wick Lance (1d10+2 R; Pen 2), Lamp Staff: (1d5 I). Trailing prose.", "weapon"),
        ).toEqual([
            { name: "Wick Lance", type: "weapon" },
            { name: "Lamp Staff", type: "weapon" },
        ]);
        expect(listedItems("Dim Sight (+2); lantern", "trait")).toEqual([
            { name: "Dim Sight (+2)", type: "trait" },
            { name: "lantern", type: "trait" },
        ]);
    });

    it("embeds a statblock's items as copies of the document's own, else bare", () => {
        const entity = (documentType: "Item" | "Actor", fields: Record<string, JsonValue>): Entity => ({
            blockId: "b",
            documentType,
            group: "dh2",
            pack: "p",
            ordinal: 0,
            fields,
            images: {},
            provenance: { pageIndex: 0, y: 0 },
        });
        const talent = entity("Item", {
            name: "Hatred",
            type: "talent",
            system: { tier: 1, specialization: "" },
        });
        const coat = entity("Item", { name: "Wick Coat", type: "armour", system: { maxAgility: 40 } });
        const lance = entity("Item", { name: "Wick Lance", type: "gear", system: {} });
        const actor = entity("Actor", {
            name: "Lamp Warden",
            type: "npc",
            system: {},
            items: [
                { name: "Hatred (Moths)", type: "talent", system: { specialization: "Moths" } },
                { name: "Wick Coat", type: "gear", system: {} },
                { name: "Wick Lance", type: "weapon", system: {} },
            ],
        });
        embedNpcItems([talent, coat, lance, actor]);
        const embedded = actor.fields["items"];
        const items = (Array.isArray(embedded) ? embedded : []).filter(
            (i): i is JsonObject => typeof i === "object" && i !== null && !Array.isArray(i),
        );
        expect(items.map((i) => [i["name"], i["type"], i["system"]])).toEqual([
            ["Hatred (Moths)", "talent", { tier: 1, specialization: "Moths" }],
            ["Wick Coat", "armour", { maxAgility: 40 }],
            // A gear item is no weapon: the listed weapon stays bare.
            ["Wick Lance", "weapon", {}],
        ]);
        expect(items.every((i) => typeof i["_id"] === "string" && String(i["_id"]).length === 16)).toBe(true);
        expect(Object(actor.fields["system"])["weapons"]).toEqual({ mode: "embedded", simple: [] });
    });

    it("reads printed fate points", () => {
        const npc = parseNpc({
            pageIndex: 0,
            name: "LAMP WARDEN",
            caption: null,
            bannerNumber: 14,
            labels: [],
            values: [],
            associatedText: ["Gear: lantern, staff", "Fate Points: 3"],
            blocks: [],
        });
        expect(npc.system["fate"]).toEqual({ value: 3, max: 3 });
    });

    it("reads the panel threat, not a rule note labelled with it", () => {
        const npc = parseNpc({
            pageIndex: 0,
            name: "GLOOM LORD (Master)",
            caption: null,
            bannerNumber: 40,
            labels: [],
            values: [],
            associatedText: [
                "THREAT 45",
                "† Rising Threat: Add 5 to this NPC's Threat for each boon after the second.",
            ],
            blocks: [],
        });
        expect(npc.system["threatLevel"]).toBe(45);
    });

    it("keeps named rules as abilities, not statblock, weapon or power fields", () => {
        const block = (label: string | null, text: string) => ({ label, text, pageIndex: 0 });
        expect(
            specialAbilities([
                block(null, "HALF 3"),
                block("Fate Points", "2"),
                block("Range", "Self"),
                block("Effect", "The lamp flares."),
                block("Talents", "Keen Eye"),
                block("Psychic Powers (Psy Rating 2)", "Kindle, Glimmer Ward (see below)"),
                block("Glimmer Ward", "A ward of light."),
                block("Armour (Primitive)", "Hides (Body 2)"),
                block("Insanity Points", "12"),
                block("CruisingSPEED", "30 KPH"),
                block("Crew", "Rider"),
                block("Lantern Sight", "Sees in the dark."),
                block("Empty Rule", ""),
            ]),
        ).toEqual([{ name: "Lantern Sight", text: "Sees in the dark.", pageIndex: 0 }]);
    });

    it("splits a panel into labelled blocks, continuing unlabelled lines", () => {
        const line = (y: number, parts: [string, "bold" | "normal", number][], page = 0) => ({
            y,
            runs: parts.map(([text, weight, x]) => ({
                ...irRun(text, page, y),
                x,
                weight,
                width: 6 * text.length,
            })),
        });
        expect(
            panelBlocks([
                line(300, [["HALF 3 FULL 6", "normal", 100]]),
                line(290, [
                    ["Lantern Sight:", "bold", 100],
                    ["Sees in", "normal", 190],
                ]),
                line(280, [["the dark.", "normal", 100]]),
                line(
                    700,
                    [
                        ["Gear:", "bold", 100],
                        ["staff", "normal", 140],
                    ],
                    1,
                ),
            ]),
        ).toEqual([
            { label: null, text: "HALF 3 FULL 6", pageIndex: 0 },
            { label: "Lantern Sight", text: "Sees in the dark.", pageIndex: 0 },
            { label: "Gear", text: "staff", pageIndex: 1 },
        ]);
    });

    it("reads a label whose first word slipped out of bold, set solid against the rest", () => {
        const run = (text: string, x: number, width: number, weight: "bold" | "normal"): IRTextRun => ({
            ...irRun(text, 0, 300),
            x,
            width,
            weight,
        });
        const label = (gap: number) =>
            panelBlocks([
                {
                    y: 300,
                    runs: [
                        run("Warden", 100, 20, "normal"),
                        run("Oath:", 120 + gap, 30, "bold"),
                        run("Never sleeps.", 160 + gap, 60, "normal"),
                    ],
                },
            ]);
        expect(label(0)).toEqual([{ label: "Warden Oath", text: "Never sleeps.", pageIndex: 0 }]);
        expect(label(20)[0]?.label).toBeNull();
    });

    it("never takes a neighbouring column's field label as the name banner", () => {
        const bold = (text: string, x: number, y: number, size: number, column = 0): IRTextRun => ({
            ...irRun(text, 0, y),
            x,
            width: 6 * text.length,
            size,
            weight: "bold",
            column,
        });
        const values = [
            [31, 42, 27],
            [35, 30, 18],
            [33, 29, 12],
        ];
        const grid = values.flatMap((row, r) =>
            row.map((v, c) => bold(String(v), 200 + 30 * c, 480 - 25 * r, 13)),
        );
        const ir = irOf(
            [0],
            [
                ...grid,
                bold("LAMP", 120, 520, 9),
                bold("WARDEN", 150, 520, 9),
                bold("Fate Points:", 310, 512, 10, 1),
            ],
        );
        expect(detectNumericGrids(ir).map((g) => g.name)).toEqual(["LAMP WARDEN"]);
    });

    it("reads a grid on a page with no text layer from its lattice, whatever the measured weights", () => {
        const read = (text: string, x: number, y: number, size: number): IRTextRun => ({
            ...irRun(text, 0, y),
            x,
            width: 6 * text.length,
            height: size,
            size,
        });
        const values = [
            ["47", "—", "40"],
            ["40", "41", "16"],
            ["41", "20", "05"],
        ];
        const grid = values.flatMap((row, r) => row.map((v, c) => read(v, 200 + 30 * c, 480 - 25 * r, 11)));
        const base = irOf(
            [0],
            [
                ...grid,
                // A stray value beside the grid (a wounds box) and art read as words around the banner.
                read("16", 290, 512, 9),
                read("i", 60, 540, 11),
                read("WARDEN SENTRY (ELITE)", 110, 540, 11),
                read("Va", 260, 540, 11),
            ],
        );
        const ir = { ...base, pages: base.pages.map((p) => ({ ...p, hasTextLayer: false })) };
        const [found] = detectNumericGrids(ir);
        expect(found?.name).toBe("WARDEN SENTRY (ELITE)");
        expect(found?.values).toEqual([47, 0, 40, 40, 41, 16, 41, 20, 5]);
        // With a text layer the same unbolded values are no grid.
        expect(detectNumericGrids(base)).toEqual([]);
    });

    it("trims a scanned banner's short mixed-case end words, never a small-caps word", () => {
        expect(trimToCapitals("Sr WARDEN SENTRY Ps)")).toBe("WARDEN SENTRY");
        expect(trimToCapitals("LaNTERN HOUND (TROOP)")).toBe("LaNTERN HOUND (TROOP)");
        expect(trimToCapitals("Lamp warden")).toBe("Lamp warden");
    });

    it("follows statblock text that runs on through the next column onto the next page", () => {
        const at = (
            text: string,
            page: number,
            x: number,
            y: number,
            column: number,
            bold = false,
        ): IRTextRun => ({
            ...irRun(text, page, y),
            x,
            width: 6 * text.length,
            size: bold ? 13 : 9,
            weight: bold ? "bold" : "normal",
            column,
        });
        const label = (text: string, value: string, page: number, x: number, y: number, column: number) => [
            { ...at(text, page, x, y, column), weight: "bold" as const },
            at(value, page, x + 6 * text.length + 4, y, column),
        ];
        const grid = [
            [31, 42, 27],
            [35, 30, 18],
            [33, 29, 12],
        ].flatMap((row, r) => row.map((v, c) => at(String(v), 0, 60 + 30 * c, 300 - 25 * r, 0, true)));
        const ir = irOf(
            [0, 1],
            [
                ...grid,
                at("LAMP", 0, 60, 340, 0, true),
                at("WARDEN", 0, 100, 340, 0, true),
                ...label("Skills:", "Awareness", 0, 60, 220, 0),
                at("and more awareness", 0, 60, 208, 0),
                ...label("Talents:", "Keen Eye", 0, 330, 700, 1),
                at("and a keener eye", 0, 330, 688, 1),
                ...label("Ember Rule:", "Glows.", 1, 60, 700, 0),
            ],
        );
        const blocks = detectNumericGrids(ir)[0]?.blocks ?? [];
        expect(blocks.map((b) => [b.label, b.pageIndex])).toEqual([
            ["Skills", 0],
            ["Talents", 0],
            ["Ember Rule", 1],
        ]);
    });

    it("reads a grid of only two values, but not a block of one repeated value", () => {
        const bold = (text: string, x: number, y: number, size: number): IRTextRun => ({
            ...irRun(text, 0, y),
            x,
            width: 6 * text.length,
            size,
            weight: "bold",
        });
        const gridOf = (values: number[][]): IRTextRun[] =>
            values.flatMap((row, r) => row.map((v, c) => bold(String(v), 200 + 30 * c, 480 - 25 * r, 13)));
        const names = (values: number[][]): string[] =>
            detectNumericGrids(
                irOf([0], [...gridOf(values), bold("PLAIN", 120, 520, 9), bold("FOLK", 156, 520, 9)]),
            ).map((g) => g.name);
        expect(
            names([
                [25, 25, 30],
                [30, 25, 25],
                [25, 25, 30],
            ]),
        ).toEqual(["PLAIN FOLK"]);
        expect(
            names([
                [3, 3, 3],
                [3, 3, 3],
                [3, 3, 3],
            ]),
        ).toEqual([]);
    });
});

describe("entry typing", () => {
    const entry = (
        heading: string,
        fields: [string, string][],
        sections: string[] = [],
        body = "Prose.",
    ): Entry => ({
        heading: { text: heading, size: 11, style: "h", pageIndex: 0 },
        sections,
        fields,
        body,
    });

    it("types by fields first", () => {
        expect(
            entryType(
                entry("STEADY HAND", [
                    ["Tier", "1"],
                    ["Aptitudes", "Agility, Finesse"],
                ]),
            ),
        ).toBe("talent");
        expect(
            entryType(
                entry("SPARK", [
                    ["Focus Power", "Willpower"],
                    ["Sustained", "No"],
                ]),
            ),
        ).toBe("psychicPower");
        const sustain = entry("SPARK", [
            ["Threshold", "8"],
            ["Sustain", "No"],
        ]);
        expect(entryType(sustain)).toBe("psychicPower");
        expect(entryItem(sustain, "psychicPower").system["sustained"]).toBe("No");
        expect(entryType(entry("CLIMB (AGILITY)", [["Aptitudes", "Agility"]]))).toBe("skill");
    });

    it("keeps a talent's printed alignment where its aptitudes go", () => {
        const aligned = entry("WICK DEVOTEE", [
            ["Tier", "3"],
            ["Prerequisite", "Fellowship 50"],
            ["Alignment", "Lantern"],
        ]);
        expect(entryItem(aligned, "talent").system["aptitudes"]).toEqual(["Lantern"]);
    });

    it("types an entry whose Type names an order, keeping its kind, requirements and effect", () => {
        const sweeping = entry("LAMPS LIT!", [
            ["Type", "Sweeping Order (Free Action)"],
            ["Cost", "200 xp"],
            ["Effect", "Every lamp in range is lit."],
        ]);
        expect(entryType(sweeping)).toBe("order");
        const item = entryItem(sweeping, "order");
        expect(item.system).toEqual({
            notes: "Sweeping Order (Free Action)",
            requirements: "<p>200 xp</p>",
        });
        expect(item.variantized["effect"]).toBe("<p>Every lamp in range is lit.</p><p>Prose.</p>");

        const veteran = entry("TRIM THE WICK", [
            ["Type", "Order (Half Action)"],
            ["Order", "Veteran"],
            ["Prerequisite", "Steady Hand"],
            ["Effect", "The wick is trimmed."],
        ]);
        expect(entryItem(veteran, "order").system).toEqual({
            notes: "Veteran Order (Half Action)",
            requirements: "<p>Steady Hand</p>",
        });
        // An advance of another type is no order, whatever its text says of orders.
        expect(
            entryType(
                entry("LAMP BEARER", [
                    ["Type", "Passive"],
                    ["Effect", "Relays orders."],
                ]),
            ),
        ).toBeNull();
        // An entry typed by its action alone is an order when it calls itself one.
        const action = entry("WATCH THE WICK", [
            ["Type", "Full Action"],
            ["Effect", "The Comrade must be in Cohesion to issue this Order."],
        ]);
        expect(entryType(action)).toBe("order");
        expect(
            entryType({
                ...action,
                fields: [
                    ["Type", "Full Action"],
                    ["Effect", "Trim it."],
                ],
            }),
        ).toBeNull();
        // Nor is one whose Type runs on into prose that mentions an order.
        expect(
            entryType(
                entry("SIDESTEP", [
                    ["Type", "Reaction Subtype: Movement The character must be aware in order"],
                ]),
            ),
        ).toBeNull();
    });

    it("leaves a creature statblock's text section untyped, whatever rules sit inside it", () => {
        expect(
            entryType(
                entry("LAMP WARDEN", [
                    ["Skills", "Awareness (Per) +10"],
                    ["Traits", "Dark-sight"],
                    ["Focus Power", "Willpower"],
                    ["Sustained", "No"],
                ]),
            ),
        ).toBeNull();
    });

    it("gives a field-less entry the kind most of its siblings are typed by their fields", () => {
        const talents = ["Talents"];
        const run = [
            entry("WICK FOCUS", [["Prerequisites", "Ag 30"]], talents),
            entry("LAMP SENSE", [["Prerequisites", "Per 30"]], talents),
            entry("QUIET TREAD", [], talents),
            entry("EMBER HAND", [["Prerequisites", "WP 30"]], talents),
        ];
        const kinds = siblingKinds(run, entryType);
        expect(run.map((e) => kinds.get(e))).toEqual(["talent", "talent", "talent", "talent"]);
        // Too few typed siblings establish no run.
        const short = run.slice(1);
        expect(short.map((e) => siblingKinds(short, entryType).get(e))).toEqual([
            "talent",
            undefined,
            "talent",
        ]);
    });

    it("gives no kind to a sibling before the run, heading entries, with foreign fields or a question", () => {
        const talents = ["Talents"];
        const run = [
            entry("LAMP CARE", [], talents),
            entry("WICK FOCUS", [["Prerequisites", "Ag 30"]], talents),
            entry("LAMP SENSE", [["Prerequisites", "Per 30"]], talents),
            entry("USES OF FLAME", [], talents),
            entry("KINDLING", [], [...talents, "USES OF FLAME"]),
            entry("WICK LENGTHS", [["Short", "1 hour"]], talents),
            entry("WHAT IS A WICK?", [], talents),
            entry("EMBER HAND", [["Prerequisites", "WP 30"]], talents),
        ];
        const kinds = siblingKinds(run, entryType);
        const untyped = ["LAMP CARE", "USES OF FLAME", "KINDLING", "WICK LENGTHS", "WHAT IS A WICK?"];
        expect(run.filter((e) => untyped.includes(e.heading.text)).map((e) => kinds.get(e))).toEqual(
            untyped.map(() => undefined),
        );
    });

    it("drops a prerequisite's closing full stop", () => {
        const item = entryItem(
            entry("LAMP SENSE", [["Prerequisites", "Perception 30."]], ["Talents"]),
            "talent",
        );
        expect(item.system["prerequisites"]).toEqual({ text: "Perception 30" });
    });

    it("falls back to the enclosing section's schema type word", () => {
        expect(entryType(entry("LONG SIGHT", [], ["Chapter One", "Traits"]))).toBe("trait");
        expect(entryType(entry("long SIGHT", [["Effect", "Sees far."]], ["Chapter One", "Traits"]))).toBe(
            "trait",
        );
        expect(entryType(entry("act i: LONG NIGHT", [], ["Chapter One", "Traits"]))).toBeNull();
        // Upgrades listed together are told apart by what each is used with.
        const upgrades = ["Gear", "Armour and Weapon Upgrades"];
        expect(entryType(entry("GLOW WARD", [["Used With", "Any armour."]], upgrades))).toBe(
            "armourModification",
        );
        expect(entryType(entry("GLOW EDGE", [["Used With", "Any melee weapon."]], upgrades))).toBe(
            "weaponModification",
        );
        expect(entryType(entry("GLOW CHARM", [["Effect", "Glows."]], upgrades))).toBe("weaponModification");
        expect(entryType(entry("NOTHING", [], ["Introduction"]))).toBeNull();
    });

    it("never types a section heading under its own section", () => {
        for (const heading of ["TRAITS", "ACQUIRING TRAITS", "carried on from a quote.”"]) {
            expect(entryType(entry(heading, [], ["Chapter One", "Traits"]))).toBeNull();
        }
        expect(entryType(entry("GLOWING WEAPONS", [], ["Traits", "Trait Descriptions"]))).toBe("trait");
        expect(entryType(entry("TIERS AND CATEGORIES", [], ["Traits", "Gaining Talents"]))).toBeNull();
        expect(entryType(entry("WEAPON FOCUS", [["Tier", "1"]], ["Talents"]))).toBe("talent");
        // A talent printed with prerequisites but no tier, under a Talents section.
        expect(entryType(entry("WICK FOCUS", [["Prerequisites", "Ag 30"]], ["Talents", "A"]))).toBe("talent");
        expect(entryType(entry("WICK FOCUS", [["Prerequisites", "Ag 30"]], ["Traits"]))).toBe("trait");
        // Under a section that names no kind, a talent that calls itself one.
        const lore = ["IV: Lamps and Wicks", "Kindly Flames"];
        expect(
            entryType(
                entry("WARM HAND", [["Prerequisites", "None"]], lore, "With this Talent the bearer glows."),
            ),
        ).toBe("talent");
        expect(
            entryType(
                entry(
                    "WARM HAND",
                    [
                        ["Prerequisites", "None"],
                        ["Effect", "Each use of this Talent…"],
                    ],
                    lore,
                ),
            ),
        ).toBe("talent");
        expect(entryType(entry("WARM HAND", [["Prerequisites", "None"]], lore))).toBeNull();
        // A heading tagged with its own kind, under any section; the tag is no part of the name.
        expect(entryType(entry("WARM HAND (TALENT)", [], lore))).toBe("talent");
        expect(entryItem(entry("WARM HAND (TALENT)", [], lore), "talent").name).toBe("Warm Hand");
        expect(entryType(entry("Ember Storm (Unique Psy Power)", [], lore))).toBe("psychicPower");
        expect(entryType(entry("NEW TALENT: WICK USE (LAMPWRIGHT)", [], lore))).toBe("talent");
        // A skill tagged with its type, its characteristic printed as the next heading.
        const [skill, ...rest] = joinSkillCharacteristics([
            entry("WICKCRAFT (ADVANCED, MOVEMENT)", [], lore, ""),
            entry("Agility", [["Skill Use", "Full Action"]], lore, "Trimming wicks in the dark."),
            entry("OTHER", [], lore),
        ]);
        expect(rest.map((e) => e.heading.text)).toEqual(["OTHER"]);
        expect(skill !== undefined && entryType(skill)).toBe("skill");
        const item = skill === undefined ? null : entryItem(skill, "skill");
        expect(item?.name).toBe("Wickcraft");
        expect(item?.system).toMatchObject({
            characteristic: "agility",
            skillType: "advanced",
            isBasic: false,
        });
        expect(item?.variantized["uses"]).toBe("Trimming wicks in the dark.");
        expect(entryItem(entry("TALENT: WARM HAND", [], lore), "talent").name).toBe("Warm Hand");
        // What a talent covers is no tag.
        expect(headingKindTag("Resistance (Psychic Powers)")).toBeNull();
        expect(headingKindTag("Melee Weapon Training (Power)")).toBeNull();
        expect(typeNamedBy("Table 2-1: Mutations")).toBe("mutation");
        expect(typeNamedBy("Weapons Upgrades")).toBe("weaponModification");
        expect(typeNamedBy("Armour Upgrades")).toBe("armourModification");
    });

    it("builds a talent's tier, aptitudes and prerequisites", () => {
        const item = entryItem(
            entry("STEADY HAND", [
                ["Tier", "2"],
                ["Prerequisites", "Agility 30"],
                ["Aptitudes", "Agility, Finesse"],
            ]),
            "talent",
        );
        expect(item.name).toBe("Steady Hand");
        expect(item.system).toMatchObject({
            tier: 2,
            aptitudes: ["Agility", "Finesse"],
            prerequisites: { text: "Agility 30" },
        });
    });
});

describe("margin bands", () => {
    it("finds a recurring foot cluster and no band at an edge without one", () => {
        const pages = 10;
        const baselines = [
            // A folio on every page at 2% of the height, body text from 6% up.
            ...Array.from({ length: pages }, () => ({ y: 16, pageHeight: 800 })),
            ...Array.from({ length: 400 }, (_, i) => ({ y: 48 + (i % 700), pageHeight: 800 })),
        ];
        const bands = measureMarginBands(baselines, pages);
        expect(bands.bottom).toBeGreaterThan(16 / 800);
        expect(bands.bottom).toBeLessThanOrEqual(48 / 800);
        expect(bands.top).toBe(1);
        expect(inMarginBand(16, 800, bands)).toBe(true);
        expect(inMarginBand(48, 800, bands)).toBe(false);
    });

    it("places text wholly beyond the text block's sides in a side margin", () => {
        expect(inSideMargin(566, 588, 600)).toBe(true);
        expect(inSideMargin(10, 30, 600)).toBe(true);
        expect(inSideMargin(376, 525, 600)).toBe(false);
        expect(inSideMargin(540, 590, 600)).toBe(false);
    });
});

describe("result tables", () => {
    const tableOf = (names: string[]): DetectedTable => ({
        pageIndex: 0,
        headers: ["Result", "Cost"],
        rows: names.map((name) => ({
            cells: [
                { colIndex: 0, text: name, isHeader: false },
                { colIndex: 1, text: "10", isHeader: false },
            ],
            isHeaderRow: false,
            isSectionHeader: false,
            sectionName: null,
        })),
        tableTitle: "Lamp Bindings",
    });

    it("reads a table keyed by number bands as results, not items", () => {
        expect(
            keyedByBands(tableOf(["1-2 Degrees of Failure", "1-2 Degrees of Success", "5+ Degrees"]), 0),
        ).toBe(true);
        expect(keyedByBands(tableOf(["Glow Lamp", "Hush Lamp", "10-Wick Lamp"]), 0)).toBe(false);
    });

    it("reads a table keyed by test modifiers as results, not items", () => {
        expect(keyedByBands(tableOf(["Dim +20", "Murky –10", "Pitch Black -30"]), 0)).toBe(true);
        expect(keyedByBands(tableOf(["Lamp-30", "Glow Lamp", "Hush Lamp"]), 0)).toBe(false);
    });
});

describe("table continuations", () => {
    it("gives a continued table its base caption, keeping its own page", () => {
        const table = (pageIndex: number, tableTitle: string): DetectedTable => ({
            pageIndex,
            headers: ["A", "B"],
            rows: [],
            tableTitle,
        });
        const joined = joinContinuations([
            table(40, "Glow Rites"),
            table(41, "Glow Rites (Continued)"),
            table(41, "Hush"),
        ]);
        expect(joined.map((t) => [t.pageIndex, t.tableTitle])).toEqual([
            [40, "Glow Rites"],
            [41, "Glow Rites"],
            [41, "Hush"],
        ]);
    });

    it("reads on past a section row set apart when records resume after it", () => {
        const at = (text: string, x: number, y: number): IRTextRun => ({
            ...irRun(text, 0, y),
            x,
            width: 20,
        });
        const record = (y: number) => ({ y, runs: [0, 100, 200, 300].map((x) => at("v", x, y)) });
        const section = (y: number) => ({ y, runs: [at("Section", 0, y)] });
        const prose = (y: number) => ({ y, runs: [{ ...at("A line of running prose.", 0, y), width: 380 }] });
        const edges = [0, 100, 200, 300];
        // Records 6pt apart; a section row 20pt below them, then records again.
        const resuming = [record(500), record(494), record(488), section(468), record(462), record(456)];
        expect(tableBody(resuming, edges)).toHaveLength(6);
        // The same row with nothing tabular after it ends the table.
        const ending = [record(500), record(494), record(488), section(468), section(462)];
        expect(tableBody(ending, edges)).toHaveLength(3);
        // A footnote among the records is skipped when records resume below it,
        // and ends the table when none do.
        const noteText = "Profile is for the lamp's own wick, not its reserve.";
        const note = (y: number) => ({
            y,
            runs: [at("†", 0, y), { ...at(noteText, 8, y), width: 380, italic: true }],
        });
        const annotated = [record(500), record(494), note(488), section(482), record(476)];
        expect(tableBody(annotated, edges)).toHaveLength(4);
        expect(tableBody([record(500), record(494), note(488), prose(482)], edges)).toHaveLength(2);
        // Prose citing the table by its caption is no record.
        const citing = [record(500), record(494), { y: 488, runs: [at("Table 3-1: Lamps", 0, 488)] }];
        expect(tableBody(citing, edges)).toHaveLength(2);
        // A heading set larger than the records, straight below them, ends the table.
        const heading = { y: 482, runs: [{ ...at("LAMP LORE", 0, 482), size: 12 }, at("ember", 200, 482)] };
        expect(tableBody([record(500), record(494), record(488), heading, prose(476)], edges)).toHaveLength(
            3,
        );
        // …and so does one followed by `Label:` field lines, however many cells they touch.
        const field = {
            y: 476,
            runs: [{ ...at("Value:", 0, 476), weight: "bold" as const }, at("200 xp", 100, 476)],
        };
        expect(tableBody([record(500), record(494), record(488), heading, field], edges)).toHaveLength(3);
        // In a two-column table, a larger line set apart by a wide gap ends it
        // even when a two-cell line follows.
        const pair = (y: number) => ({ y, runs: [at("v", 0, y), at("v", 100, y)] });
        const twoColumns = [pair(500), pair(494), pair(488), { ...heading, y: 460 }, pair(454)];
        expect(tableBody(twoColumns, [0, 100])).toHaveLength(3);
        // A larger section row followed by records stays in the table.
        expect(tableBody([record(500), record(494), heading, record(488), record(482)], edges)).toHaveLength(
            5,
        );
        // Records found only past prose below the heading belong to the next table.
        const paragraph = {
            y: 470,
            runs: [
                {
                    ...at("Lamps are tended nightly and their wicks are trimmed at dawn.", 0, 470),
                    width: 380,
                },
            ],
        };
        expect(
            tableBody([record(500), record(494), heading, paragraph, record(464), record(458)], edges),
        ).toHaveLength(2);
    });

    it("measures a centred key from the key itself, not its baseline group", () => {
        const at = (text: string, x: number, y: number): IRTextRun => ({ ...irRun(text, 0, y), x });
        // Key 01-05 sits mid-cell and shares a baseline group with the text
        // line 4pt above it; the cell's last line is nearer 01-05's key than
        // the next key, though farther from that group's baseline.
        const rows = groupByKeyAnchors(
            [
                { y: 516, runs: [at("Ember Skin: burns", 100, 516)] },
                { y: 506, runs: [at("01-05", 20, 502), at("to the touch and", 100, 506)] },
                { y: 484, runs: [at("never cools.", 100, 484)] },
                { y: 468, runs: [at("Ash Eyes: sees", 100, 468)] },
                { y: 464, runs: [at("06-10", 20, 464)] },
            ],
            [0, 80],
        );
        expect(rows.map((r) => r.runs.map((x) => x.text))).toEqual([
            ["01-05", "to the touch and", "Ember Skin: burns", "never cools."],
            ["06-10", "Ash Eyes: sees"],
        ]);
    });

    it("gives a key heading its row every line down to the next key", () => {
        const at = (text: string, x: number, y: number): IRTextRun => ({ ...irRun(text, 0, y), x });
        // Each key sits on its row's first line; a row's last line lies nearer
        // the next key than its own.
        const rows = groupByKeyAnchors(
            [
                { y: 702, runs: [at("1", 20, 702), at("The flame gutters and the", 100, 702)] },
                { y: 688, runs: [at("wick smokes.", 100, 688)] },
                { y: 675, runs: [at("2", 20, 675), at("The lamp goes out.", 100, 675)] },
                { y: 661, runs: [at("3", 20, 661), at("The oil catches and", 100, 661)] },
                { y: 648, runs: [at("spreads.", 100, 648)] },
            ],
            [0, 80],
        );
        expect(rows.map((r) => r.runs.map((x) => x.text))).toEqual([
            ["1", "The flame gutters and the", "wick smokes."],
            ["2", "The lamp goes out."],
            ["3", "The oil catches and", "spreads."],
        ]);
        // A key beside a line that continues a sentence is centred, not heading.
        const centred = groupByKeyAnchors(
            [
                { y: 702, runs: [at("1", 20, 702), at("The flame gutters.", 100, 702)] },
                { y: 688, runs: [at("Soot: the wick", 100, 688)] },
                { y: 675, runs: [at("2", 20, 675), at("smokes and dims.", 100, 675)] },
            ],
            [0, 80],
        );
        expect(centred.map((r) => r.runs.map((x) => x.text))).toEqual([
            ["1", "The flame gutters."],
            ["2", "smokes and dims.", "Soot: the wick"],
        ]);
    });
});

describe("running heads", () => {
    it("gives each page the edge labels repeated across pages, not a one-off", () => {
        const ir = irOf([0, 1, 2, 3], []);
        const labels = ["II: Lanterns", "II: Lanterns", "II: Lanterns", "Wick"];
        const pages = ir.pages.map((p, i) => ({ ...p, edgeText: [labels[i] ?? ""] }));
        const heads = runningHeads({ ...ir, pages });
        expect([0, 1, 2, 3].map((i) => heads.get(i))).toEqual([
            ["II: Lanterns"],
            ["II: Lanterns"],
            ["II: Lanterns"],
            undefined,
        ]);
    });
});

describe("headings", () => {
    const body = { style: "body|10|normal", size: 10 };
    /** A line of runs (text, x, width) in one face at `size`. */
    const heading = (parts: [string, number, number][], size = 12): TextLine => ({
        pageIndex: 0,
        column: 0,
        y: 500,
        runs: parts.map(([text, x, width]) => ({ ...irRun(text, 0, 500), x, width, font: "display", size })),
        text: parts.map(([t]) => t).join(" "),
        right: Math.max(...parts.map(([, x, w]) => x + w)),
    });

    it("keeps a heading that sets a name within it in italics, not one mixing faces", () => {
        const line = heading([
            ["Captain Vane’s", 100, 80],
            ["Lantern", 185, 45],
        ]);
        const [roman, name] = line.runs;
        if (roman === undefined || name === undefined) {
            throw new Error("two runs expected");
        }
        const italic = { ...line, runs: [roman, { ...name, font: "display-italic", italic: true }] };
        expect(headingOf(italic, body, false)?.text).toBe("Captain Vane’s Lantern");
        const mixed = { ...line, runs: [roman, { ...name, font: "other" }] };
        expect(headingOf(mixed, body, false)).toBeNull();
    });

    it("keeps a name ending in its rank, not a line carrying other values", () => {
        const ranked = heading([
            ["WICK", 100, 30],
            ["MASTERY", 134, 50],
            ["2", 188, 8],
        ]);
        expect(headingOf(ranked, body, false)?.text).toBe("WICK MASTERY 2");
        const labelled = heading([
            ["RANK", 100, 30],
            ["2:", 134, 10],
            ["GLOW", 148, 30],
        ]);
        expect(headingOf(labelled, body, false)?.text).toBe("RANK 2: GLOW");
        const lone = heading([
            ["CHAPTER", 100, 50],
            ["3", 154, 8],
        ]);
        expect(headingOf(lone, body, false)).toBeNull();
        const row = heading([
            ["WICK", 100, 30],
            ["12", 134, 12],
            ["LAMP", 150, 30],
        ]);
        expect(headingOf(row, body, false)).toBeNull();
    });

    it("keeps a heading whose word space is a little wide", () => {
        const wide = heading([
            ["LANTERN’S", 100, 60],
            ["WAKE", 175, 40],
        ]);
        expect(headingOf(wide, body, false)?.text).toBe("LANTERN’S WAKE");
    });

    it("rejects bold labels spread apart like table cells, not a letter-spaced display heading", () => {
        const spreadOut: [string, number, number][] = [
            ["LANTERN", 100, 50],
            ["WAKE", 175, 40],
        ];
        const cells = heading(spreadOut);
        const bold = { ...cells, runs: cells.runs.map((r) => ({ ...r, weight: "bold" as const })) };
        expect(headingOf(bold, body, false)).toBeNull();
        expect(headingOf(cells, body, false)?.text).toBe("LANTERN WAKE");
        // A space glyph in the gap makes it a word space, however wide it measures.
        const [lantern, wake] = bold.runs;
        if (lantern === undefined || wake === undefined) {
            throw new Error("two runs expected");
        }
        const spaced = { ...bold, runs: [lantern, { ...lantern, x: 165, width: 2, text: " " }, wake] };
        expect(headingOf(spaced, body, false)?.text).toBe("LANTERN WAKE");
    });

    it("rejects display text sharing a baseline with text far across the page", () => {
        const apart = heading(
            [
                ["Lanterns &", 100, 160],
                ["Wakes", 370, 130],
            ],
            32,
        );
        expect(headingOf(apart, body, false)).toBeNull();
    });

    it("rejects a line of labelled values, however it is spaced", () => {
        const values = heading([
            ["FRONT:12", 100, 40],
            ["SIDE:9", 180, 30],
        ]);
        expect(headingOf(values, body, false)).toBeNull();
    });

    it("reads no heading from a line of italics at body size, but does from larger italics", () => {
        const italic = (size: number): TextLine => {
            const line = heading([["The Lamp Is Lit", 100, 80]], size);
            return { ...line, runs: line.runs.map((r) => ({ ...r, italic: true, font: "quote-italic" })) };
        };
        expect(headingOf(italic(body.size), body, false)).toBeNull();
        expect(headingOf(italic(16), body, false)?.text).toBe("The Lamp Is Lit");
    });

    it("reads a small capitals heading whose case the text layer scrambled", () => {
        const faces = new Set(["display|normal"]);
        const scrambled = heading([["STARTING wicks", 100, 70]], 8.5);
        expect(headingOf(scrambled, body, false, faces)?.text).toBe("STARTING wicks");
        const titled = heading([["Starting Wicks", 100, 70]], 8.5);
        expect(headingOf(titled, body, false, faces)).toBeNull();
        // Case lost only partly: scrambled inside a word, or title case beside capitals.
        const inWord = heading([["wICK Ward", 100, 70]], 8.5);
        expect(headingOf(inWord, body, false, faces)?.text).toBe("wICK Ward");
        const mixed = heading([["Wick AWARENESS", 100, 70]], 8.5);
        expect(headingOf(mixed, body, false, faces)?.text).toBe("Wick AWARENESS");
        const lowerFirst = heading([["sacred wick Burner", 100, 70]], 8.5);
        expect(headingOf(lowerFirst, body, false, faces)?.text).toBe("sacred wick Burner");
        // Display type with no capitals left may wrap on a function word.
        expect(headingOf(heading([["the lantern of", 100, 70]]), body, false)?.text).toBe("the lantern of");
        expect(headingOf(heading([["The Lantern of", 100, 70]]), body, false)).toBeNull();
    });

    it("reads small capitals in a bold heading face as a heading, but not a labelled value", () => {
        const faces = new Set(["display|bold"]);
        const bold = (text: string): TextLine => {
            const line = heading([[text, 100, 70]], 7.75);
            return { ...line, runs: line.runs.map((r) => ({ ...r, weight: "bold" as const })) };
        };
        expect(headingOf(bold("COUNTERSNIPE"), body, false, faces)?.text).toBe("COUNTERSNIPE");
        expect(headingOf(bold("CREW: DRIVER"), body, false, faces)).toBeNull();
    });

    it("reads a long display line with no capitals as a heading in a heading face", () => {
        const faces = new Set(["display|normal"]);
        const lost = heading([["tempest-class strike lantern", 100, 140]]);
        expect(headingOf(lost, body, false, faces)?.text).toBe("tempest-class strike lantern");
        // Elsewhere it reads as prose; at body size it is running text.
        expect(headingOf(lost, body, false)).toBeNull();
        const bodySize = heading([["tempest-class strike lantern", 100, 140]], 10);
        expect(headingOf(bodySize, body, false, faces)).toBeNull();
    });
});

describe("figures in the text column", () => {
    /** A one-run line at (x, y) on page 0, column 0, `width` wide, in `font` at `size`. */
    const line = (text: string, x: number, y: number, width: number, font = "body", size = 10): TextLine => ({
        pageIndex: 0,
        column: 0,
        y,
        runs: [{ ...irRun(text, 0, y), x, width, font, size }],
        text,
        right: x + width,
    });
    /** Body lines on the column edge (x 50), 12pt apart from `top`. */
    const body = (top: number, count: number): TextLine[] =>
        Array.from({ length: count }, (_, i) => line(`Body line ${i}`, 50, top - 12 * i, 240));

    it("drops freely placed labels mixing styles at uneven spacing", () => {
        const figure = [
            line("Lantern Rites", 110, 600, 150, "display", 27),
            line("Kindle", 90, 560, 40, "bold", 12),
            line("WILLPOWER 30", 150, 546, 60, "caps", 10),
            line("Light a wick", 70, 530, 60, "italic", 11.5),
            line("Banish Gloom", 200, 505, 70, "bold", 12),
            line("200 XP", 130, 497, 30, "caps", 10),
        ];
        const lines = [...body(700, 6), ...figure, ...body(470, 4)];
        const kept = withoutFigures(lines);
        expect(kept).toHaveLength(10);
        expect(kept.some((l) => figure.includes(l))).toBe(false);
    });

    it("keeps centred text, text wrapped round a picture, and inset sidebars", () => {
        const centred = [120, 100, 130, 90, 110].map((x, i) =>
            line(
                `Centred ${i}`,
                x,
                600 - 17 * i - (i % 2) * 9,
                2 * (150 - x),
                i % 2 ? "bold" : "caps",
                10 + i,
            ),
        );
        const wrapped = [70, 76, 83, 88, 95].map((x, i) =>
            line(`Wrapped ${i}`, x, 460 - 12 * i, 290 - x, ["a", "b", "c", "d", "e"][i], 10),
        );
        const inset = [80, 80, 80, 80, 80].map((x, i) =>
            line(`Inset ${i}`, x, 380 - 13 * i - (i % 2) * 7, 200, ["a", "b", "c", "d", "e"][i], 10),
        );
        const lines = [...body(700, 6), ...centred, ...body(520, 3), ...wrapped, ...body(400, 1), ...inset];
        expect(withoutFigures(lines)).toHaveLength(lines.length);
    });
});

describe("entry detection", () => {
    /** A run at (x, y) on page 0 in `font` at `size`. */
    const run = (text: string, y: number, font: string, size: number): IRTextRun => ({
        ...irRun(text, 0, y),
        x: 60,
        width: text.length * size * 0.5,
        font,
        size,
    });
    const body = "Lorem glow text that fills the body style with plenty of characters.";

    it("writes the document in the chosen target schema", () => {
        const ir = irOf(
            [0],
            [
                run("TRAITS", 700, "h", 14),
                run(body, 680, "b", 10),
                run("GLOW SIGHT", 660, "h", 12),
                run(body, 640, "b", 10),
            ],
        );
        const keyed = (line: Line) =>
            infer(ir, createLogger("error"), TARGETS[line]).graph.entities.map((e) => {
                const system = e.fields["system"];
                const game =
                    system !== null && typeof system === "object" && !Array.isArray(system) ? system : {};
                return [e.pack.split("-")[0], game["gameSystems"], Object.keys(Object(game["source"]))];
            });
        expect(keyed("rt")).toEqual([["rt", ["rt"], ["rt"]]]);
        expect(keyed("dh2")).toEqual([["dh2", ["dh2"], ["dh2"]]]);
    });

    it("keeps a table caption out of the heading chain", () => {
        const ir = irOf(
            [0],
            [
                run("GLOW SECTION", 700, "h", 14),
                run(body, 680, "b", 10),
                run("Table 9-2: Glow Rating", 660, "h", 14),
                run(body, 640, "b", 10),
                run("DIM GLOW", 620, "h", 12),
                run(body, 600, "b", 10),
            ],
        );
        const entries = detectEntries(ir, new Set());
        expect(entries.map((e) => e.heading.text)).toEqual(["GLOW SECTION", "DIM GLOW"]);
        expect(entries[1]?.sections).toEqual(["GLOW SECTION"]);
    });

    it("continues a field that reaches the text measure despite a stray run past it", () => {
        const label = "Requires:";
        const value = "Glow Lore (Lamps) +10 or Dim";
        const bodyRight = 60 + body.length * 5;
        const ir = irOf(
            [0],
            [
                run("DIM WARD", 720, "h", 14),
                ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                { ...run(label, 450, "b", 10), weight: "bold" },
                { ...run(value, 450, "b", 10), x: bodyRight - value.length * 5 },
                run("Lore (Wards)", 438, "b", 10),
                run(body, 426, "b", 10),
                { ...run("7", 300, "b", 10), x: bodyRight + 30 },
            ],
        );
        const entry = detectEntries(ir, new Set()).find((e) => e.heading.text === "DIM WARD");
        expect(entry?.fields).toEqual([["Requires", `${value} Lore (Wards)`]]);
    });

    it("reads ships as voidcraft, joining a header to a profile a sidebar split off", () => {
        const field = (text: string, y: number): IRTextRun => ({
            ...run(text, y, "b-bold", 10),
            weight: "bold",
        });
        const HEADER = ["Dimensions: 1 km", "Mass: 5 megatonnes", "Crew: 900 crew", "Accel: 4 gravities"];
        const header = (y: number): IRTextRun[] => HEADER.map((t, i) => field(t, y - 12 * i));
        const profile = (y: number, speed: number): IRTextRun[] =>
            [
                `Speed: ${speed} Manoeuvrability: +20`,
                "Detection: +15 Hull Integrity: 35",
                "Armour: 18 Turret Rating: 2",
                "Space: 40 SP: 40",
            ].map((t, i) => field(t, y - 12 * i));
        const ir = irOf(
            [0],
            [
                run("CRUISER HULLS", 780, "h", 18),
                run(body, 760, "b", 10),
                run("GLOW-CLASS CRUISER", 740, "h2", 14),
                ...header(720),
                run(body, 668, "b", 10),
                ...profile(656, 5),
                run("WICK-CLASS CRUISER", 590, "h2", 14),
                ...header(570),
                run(body, 518, "b", 10),
                run("USING THE WICK", 500, "h2", 14),
                run(body, 480, "b", 10),
                ...profile(468, 7),
                run(body, 400, "b", 10),
            ],
        );
        const ships = infer(ir, createLogger("error"), TARGETS.rt).graph.entities.filter(
            (e) => e.fields["type"] === "rt-voidcraft",
        );
        const summary = ships.map((e) => {
            const system = Object(e.fields["system"]);
            return [e.fields["name"], system["speed"], system["hullType"], system["mass"]];
        });
        expect(summary).toEqual([
            ["Glow-Class Cruiser", 5, "cruiser", "5 megatonnes"],
            ["Wick-Class Cruiser", 7, "cruiser", "5 megatonnes"],
        ]);
    });

    it("reads a short italic lead label as a field, not an italic sentence", () => {
        const italic = (text: string, y: number): IRTextRun => ({
            ...run(text, y, "b-italic", 10),
            italic: true,
        });
        const ir = irOf(
            [0],
            [
                run("DIM WARD", 720, "h", 14),
                ...Array.from({ length: 10 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                italic("Mass: 6 lamps approx.", 570),
                italic("Some of the old lamps: burn", 558),
                run(body, 546, "b", 10),
            ],
        );
        const entry = detectEntries(ir, new Set()).find((e) => e.heading.text === "DIM WARD");
        expect(entry?.fields).toEqual([["Mass", "6 lamps approx."]]);
        expect(entry?.body).toContain("Some of the old lamps: burn");
    });

    it("continues a field set in a panel narrower than its column", () => {
        // Full lines of the panel end 20pt short of the column's measure.
        const panel = (text: string, y: number): IRTextRun => ({ ...run(text, y, "b", 10), width: 320 });
        const ir = irOf(
            [0],
            [
                run("DIM WARD", 720, "h", 14),
                ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                run("WARD GRANTS", 440, "h2", 12),
                ...[0, 1, 2].map((i) =>
                    panel("Every warden of the dim begins play with these.", 420 - 12 * i),
                ),
                { ...run("Grants:", 384, "b", 10), weight: "bold" },
                { ...run("Glow Lore, Wick Lore, Lantern", 384, "b", 10), x: 100, width: 280 },
                panel("Lore (Reeds), Hush.", 372),
                run(body, 360, "b", 10),
                run(body, 348, "b", 10),
            ],
        );
        const entry = detectEntries(ir, new Set()).find((e) => e.heading.text === "WARD GRANTS");
        expect(entry?.fields).toEqual([["Grants", "Glow Lore, Wick Lore, Lantern Lore (Reeds), Hush."]]);
    });

    it("reads a label the document sets in bold as a field where its line lost the weight", () => {
        const ir = irOf(
            [0],
            [
                run("DIM WARD", 720, "h", 14),
                run(body, 700, "b", 10),
                { ...run("Grants:", 688, "b", 10), weight: "bold" },
                { ...run("Glow Lore.", 688, "b", 10), x: 100 },
                run("WICK WARD", 660, "h", 14),
                run(body, 640, "b", 10),
                run("Grants: Wick Lore.", 628, "b", 10),
                run("Unbolded: a sentence, not a field.", 616, "b", 10),
            ],
        );
        const entry = detectEntries(ir, new Set()).find((e) => e.heading.text === "WICK WARD");
        expect(entry?.fields).toEqual([["Grants", "Wick Lore."]]);
        expect(entry?.body).toContain("Unbolded: a sentence");
    });

    it("reads origins from a captioned step table, but none from an index of them", () => {
        const cell = (
            text: string,
            x: number,
            y: number,
            weight: "bold" | "normal" = "normal",
        ): IRTextRun => ({
            ...irRun(text, 0, y),
            x,
            width: text.length * 5,
            font: weight === "bold" ? "h" : "b",
            weight,
            size: 10,
        });
        const table = (headers: string[], extra: (y: number) => IRTextRun[]): IR =>
            irOf(
                [0],
                [
                    run(body, 760, "b", 10),
                    cell("Table 2-1: Divinations", 60, 720, "bold"),
                    ...headers.map((h, i) => cell(h, [60, 200, 460][i] ?? 0, 700, "bold")),
                    ...[
                        "The reeds remember.",
                        "Silence is a lantern.",
                        "Every wick ends.",
                        "Dark is a door.",
                        "Glow outlasts.",
                    ].flatMap((name, i) => [
                        cell(name, 60, 680 - 20 * i),
                        cell("Gain the Hush talent.", 200, 680 - 20 * i),
                        ...extra(680 - 20 * i),
                    ]),
                ],
            );
        const origins = (ir: IR): string[] =>
            infer(ir, createLogger("error"), TARGETS.dh2)
                .graph.entities.filter((e) => String(e.pack).includes("origins"))
                .map((e) => String(e.fields["name"]));
        expect(origins(table(["Divination", "Effect"], () => []))).toHaveLength(5);
        expect(origins(table(["Divination", "Effect", "Page"], (y) => [cell("44", 460, y)]))).toEqual([]);
    });

    it("reads no heading or body from a table's lines", () => {
        const header = run("WEIGHT", 660, "h", 14);
        const cells = [run("+2 kg", 640, "b", 10), run("+1 kg", 620, "b", 10)];
        const ir = irOf(
            [0],
            [
                run("GLOW SECTION", 700, "h", 14),
                run(body, 680, "b", 10),
                header,
                ...cells,
                run(body, 600, "b", 10),
            ],
        );
        expect(detectEntries(ir, new Set()).map((e) => e.heading.text)).toEqual(["GLOW SECTION", "WEIGHT"]);
        const entries = detectEntries(ir, new Set([header, ...cells]));
        expect(entries.map((e) => e.heading.text)).toEqual(["GLOW SECTION"]);
        expect(entries[0]?.body).not.toContain("kg");
    });
});

describe("entry fields", () => {
    it("treats a value ending on a separator or conjunction as wrapped", () => {
        expect(valueUnfinished("Glow Aura, Deep Ward,")).toBe(true);
        expect(valueUnfinished("Strength 40 or")).toBe(true);
        expect(valueUnfinished("Glow Aura, Deep Ward")).toBe(false);
        expect(valueUnfinished("Fervour")).toBe(false);
    });

    it("treats a value ending a sentence as complete", () => {
        expect(endsSentence("Agility 40, Acrobatics.")).toBe(true);
        expect(endsSentence("the lamp.”")).toBe(true);
        expect(endsSentence("Common Lore (Lamps) +10 or Glow")).toBe(false);
    });
});

describe("consolidation helpers", () => {
    it("treats nested empty values as blank", () => {
        expect(isBlank({ dh2: { value: "", chat: "" } })).toBe(true);
        expect(isBlank({ dh2: { value: "x" } })).toBe(false);
    });

    it("fills blanks from another reading without overwriting authored values", () => {
        const base = { system: { tier: 2, aptitudes: [] as string[] } };
        mergeInto(base, { system: { tier: 1, aptitudes: ["Agility"] } });
        expect(base).toEqual({ system: { tier: 2, aptitudes: ["Agility"] } });
    });

    it("cites a merged entity by the page its earliest reading is on", () => {
        const reading = (pageIndex: number, page: string): Entity => ({
            blockId: `b${pageIndex}`,
            documentType: "Item",
            group: DEFAULT_LINE,
            pack: "p",
            ordinal: pageIndex,
            fields: { name: "Lamp", system: { source: { dh2: { provenance: "raw", book: "b", page } } } },
            images: {},
            provenance: { pageIndex, y: 0 },
        });
        const prose = reading(12, "12");
        citeFirstPage(prose, [prose, reading(9, "9"), reading(15, "15")], DEFAULT_LINE);
        expect(prose.fields["system"]).toEqual({
            source: { dh2: { provenance: "raw", book: "b", page: "9" } },
        });

        const row = { ...reading(14, "14"), blockId: "table:trait" };
        citeFirstPage(prose, [prose, reading(9, "9"), row], DEFAULT_LINE);
        expect(prose.fields["system"]).toEqual({
            source: { dh2: { provenance: "raw", book: "b", page: "14" } },
        });
    });

    it("files an upgrade's table row with its entry's modification type", () => {
        const reading = (blockId: string, type: string, name: string): Entity => ({
            blockId,
            documentType: "Item",
            group: DEFAULT_LINE,
            pack: `${DEFAULT_LINE}-b-${type}`,
            ordinal: 0,
            fields: { name, type },
            images: {},
            provenance: { pageIndex: 0, y: 0 },
        });
        const row = reading("table:weaponModification", "weaponModification", "Glow Ward");
        const other = reading("table:weaponModification", "weaponModification", "Glow Edge");
        const entities = [row, other, reading("entry:armourModification", "armourModification", "GLOW WARD")];
        fitModifications(entities, DEFAULT_LINE, "b");
        expect([row.fields["type"], row.blockId, row.pack]).toEqual([
            "armourModification",
            "table:armourModification",
            packName(DEFAULT_LINE, "b", "items-armor-mods"),
        ]);
        expect(other.fields["type"]).toBe("weaponModification");
    });

    it("keys names so a summary listing meets its variable-level entry", () => {
        expect(nameKey("Glow Aura (X)")).toBe(nameKey("GLOW AURA"));
        expect(nameKey("Lamp (Brass)")).not.toBe(nameKey("Lamp"));
    });
});

describe("entry components", () => {
    it("finds the heading size a type's entries are usually set in", () => {
        const at = (size: number): Entry => ({
            heading: { text: "X", size, style: "h", pageIndex: 0 },
            sections: [],
            fields: [],
            body: "",
        });
        const modal = modalHeadingSizes([
            { entry: at(10.5), type: "trait" },
            { entry: at(10.5), type: "trait" },
            { entry: at(8.5), type: "trait" },
            { entry: at(12), type: "condition" },
        ]);
        expect(modal.get("trait")).toBe(10.5);
        expect(modal.get("condition")).toBe(12);
    });

    it("names a one-word sub-heading as a kind of its same-typed parent", () => {
        const sub = (text: string): Entry => ({
            heading: { text, size: 8.5, style: "h", pageIndex: 0 },
            sections: ["GEAR", "LANTERN"],
            fields: [],
            body: "Burns longer.",
        });
        expect(kindEntry(sub("SPIKED"), "cybernetic", "cybernetic")?.heading.text).toBe("SPIKED LANTERN");
        expect(kindEntry(sub("OIL RESERVOIR"), "cybernetic", "cybernetic")).toBeNull();
        expect(kindEntry(sub("WICK-GUARD"), "cybernetic", "cybernetic")).toBeNull();
        expect(kindEntry(sub("SPIKED"), "gear", "cybernetic")).toBeNull();
        expect(kindEntry(sub("SPIKED"), undefined, "cybernetic")).toBeNull();
    });
});

describe("statblock prose", () => {
    const heading = (text: string, pageIndex: number): Entry => ({
        heading: { text, size: 8, style: "h", pageIndex },
        sections: [],
        fields: [],
        body: `${text} prose.`,
    });

    it("takes the same-named heading on the statblock's page or the page before", () => {
        const entries = [heading("MIRE HOUND", 40), heading("MIRE HOUND", 71), heading("REED KING", 72)];
        expect(introducingEntry(entries, "Mire Hound", 72)?.heading.pageIndex).toBe(71);
        expect(introducingEntry(entries, "Mire Hound", 12)).toBeNull();
        expect(introducingEntry(entries, "Reed King", 71)).toBeNull();
    });

    it("takes the heading a caption shortens, never the caption line itself", () => {
        const entries = [
            heading("INDUSTRIAL or HEAVY LAMP SERVITOR", 72),
            heading("Lamp Servitor Profile", 72),
            heading("ESHA WICK, THE LANTERN BEARER", 72),
        ];
        expect(namingEntry(entries, "Lamp Servitor", "Lamp Servitor Profile", 72)?.heading.text).toBe(
            "INDUSTRIAL or HEAVY LAMP SERVITOR",
        );
        expect(namingEntry(entries, "Esha Wick’s", "Esha Wick’s Profile", 72)?.heading.text).toBe(
            "ESHA WICK, THE LANTERN BEARER",
        );
        expect(namingEntry(entries, "Reed King", "Reed King Profile", 72)).toBeNull();
    });
});

describe("schema", () => {
    it("builds physical items with the standard cost shape, provenance and state", () => {
        const doc = buildItem({
            type: "gear",
            name: "Lamp",
            line: DEFAULT_LINE,
            book: "b",
            page: "3",
            description: "<p>x</p>",
            system: {},
        });
        const system = doc["system"] as Record<string, unknown>;
        expect(system["cost"]).toEqual(costShape());
        expect(system["source"]).toEqual({ dh2: { provenance: "raw", book: "b", page: "3" } });
        expect(system["state"]).toEqual({ equipped: false, stowed: false, container: "" });
        expect(system["gameSystems"]).toEqual(["dh2"]);
    });

    it("gives XP-cost and affliction items no acquisition cost", () => {
        const doc = buildItem({
            type: "talent",
            name: "T",
            line: DEFAULT_LINE,
            book: "b",
            page: "1",
            description: "",
            system: {},
        });
        expect((doc["system"] as Record<string, unknown>)["cost"]).toBeUndefined();
    });

    it("names packs line-book-category and escapes HTML paragraphs", () => {
        expect(packName("dh2", "field-manual", "items-weapons")).toBe("dh2-field-manual-items-weapons");
        expect(toHtml("a < b\n\nc & d")).toBe("<p>a &lt; b</p><p>c &amp; d</p>");
    });
});
