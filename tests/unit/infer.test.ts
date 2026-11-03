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
    joinRuns,
    runningHeads,
    type TextLine,
    valueUnfinished,
    withoutFigures,
    withoutShadows,
} from "../../src/infer/detect-entries.ts";
import {
    detectNumericGrids,
    panelBlocks,
    splitBannerText,
    trimToCapitals,
} from "../../src/infer/detect-grids.ts";
import { groupByKeyAnchors, joinContinuations, tableBody } from "../../src/infer/detect-titled-tables.ts";
import {
    activationType,
    entryItem,
    entryType,
    focusPowerTest,
    powerActivation,
    powerAttackProfile,
    powerProseDamage,
    targetType,
    headingKindTag,
    isSustained,
    joinPactGroups,
    joinSkillCharacteristics,
    mutationCategory,
    powerXpCost,
    printedDiscipline,
    skillSpecialisations,
    splitTalentLists,
    structuredPrerequisites,
    typeNamedBy,
    withDisciplines,
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
    reinforcementTerms,
    rejoinSmallCaps,
    sizeOf,
    tidyList,
    specialAbilities,
    splitFields,
} from "../../src/infer/npc.ts";
import { inferPageNumbering, printedPage } from "../../src/infer/page-numbers.ts";
import {
    ROLLED_ROW,
    citeFirstPage,
    embedNpcItems,
    fitModifications,
    givenNames,
    infer,
    splitNumberFromText,
    enclosingEntry,
    introducingEntry,
    isUnmarkedSectionRow,
    keyedByBands,
    namingEntry,
    listsCaption,
    weaponProfileText,
    weaponsPartRules,
    vehicleParts,
    ownProfileText,
    isBlank,
    actionGroupsOf,
    criticalEffects,
    honourGroupsOf,
    kindEntry,
    characteristicClassItem,
    kindNamed,
    mergeInto,
    preferTableBenefit,
    modalHeadingSizes,
    carriedSections,
    headedProse,
    nameKey,
    qualifiedBySection,
    siblingKinds,
    singularKey,
    type TableRecord,
    distinguishRepeats,
    withSubProfiles,
} from "../../src/infer/pipeline.ts";
import { mergeContinuationRows } from "../../src/infer/row-merge.ts";
import { mapRow, type RowCells } from "../../src/infer/rows.ts";
import { buildItem, costShape, DEFAULT_LINE, type Line, packName, toHtml } from "../../src/infer/schema.ts";
import { TARGETS } from "../../src/infer/targets.ts";
import type { DetectedTable, TableRow } from "../../src/infer/types.ts";
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

describe("distinguishRepeats", () => {
    const record = (name: string, itemType: TableRecord["itemType"], cells: RowCells): TableRecord => ({
        name,
        itemType,
        cells,
        mapped: mapRow(itemType, cells),
    });

    it("names a record a table repeats with other values by the first cell that differs", () => {
        const out = distinguishRepeats([
            record("Wick Lamp", "shipComponent", { name: "Wick Lamp", hullTypes: "Small", space: "1" }),
            record("Wick Lamp", "shipComponent", { name: "Wick Lamp", hullTypes: "Large", space: "2" }),
            record("Oil Lamp", "shipComponent", { name: "Oil Lamp", hullTypes: "Small", space: "1" }),
            record("Oil Lamp", "shipComponent", { name: "Oil Lamp", hullTypes: "Small", space: "1" }),
            record("Lamp Gun", "weapon", { name: "Lamp Gun", range: "10m" }),
            record("Lamp Gun", "weapon", { name: "Lamp Gun", range: "20m" }),
        ]);
        expect(out.map((r) => r.name)).toEqual([
            "Wick Lamp",
            "Wick Lamp (Large)",
            "Oil Lamp",
            "Oil Lamp",
            "Lamp Gun",
            "Lamp Gun",
        ]);
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
        expect(headerRole("Weight per location")).toBe("weight");
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

    it("keeps a key-only line set at the row pitch, wider than line leading, apart", () => {
        // Rows 14 pt apart in 8 pt type: a wrapped name would follow at ~10 pt.
        const rows = [
            textLine(200, ["Wick Engine", "Small", "3"]),
            textLine(186, ["Lamp Engine", "Large", "4"]),
            textLine(172, ["Glow Fields", "", ""]),
            textLine(158, ["Glow Field", "All", "1"]),
            textLine(144, ["Dim Hull", "All", "1"]),
        ];
        expect(mergeContinuationRows(rows, shape).map((r) => shape.cells(r)[0])).toEqual([
            "Wick Engine",
            "Lamp Engine",
            "Glow Fields",
            "Glow Field",
            "Dim Hull",
        ]);
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
            { name: "Hatred", type: "talent", specialization: "Moths, Gnats" },
        ]);
        const weapons = listedItems(
            "Wick Lance (1d10+2 R; Pen 2), Lamp Staff: (1d5 I). Trailing prose.",
            "weapon",
        );
        expect(weapons.map((w) => w.name)).toEqual(["Wick Lance", "Lamp Staff"]);
        // A profile printed in the brackets is the weapon's own.
        const lance = weapons[0]?.system;
        expect([lance?.["class"], Object(lance?.["damage"])["formula"]]).toEqual(["melee", "1d10"]);
        expect(weapons[1]?.system).toBeUndefined();
        // A trait's rating is its level, bracketed (perhaps with its short label) or set
        // after its name; any other parenthetical is its specialisation.
        expect(
            listedItems("Dim Sight (+2); lantern; Glow (Bright); Wick Sense (WR 4); Dread 3", "trait"),
        ).toEqual([
            { name: "Dim Sight", type: "trait", system: { level: 2 } },
            { name: "lantern", type: "trait" },
            { name: "Glow", type: "trait", specialization: "Bright" },
            { name: "Wick Sense", type: "trait", system: { level: 4 } },
            { name: "Dread", type: "trait", system: { level: 3 } },
        ]);
    });

    it("resolves a trait named for one characteristic to the document's trait for any", () => {
        const doc = (name: string): Entity => ({
            blockId: name,
            documentType: "Item",
            group: "g",
            pack: "p",
            ordinal: 0,
            fields: { name, type: "trait", system: { hasLevel: true } },
            images: {},
            provenance: { pageIndex: 0, y: 0 },
        });
        const items = [doc("Glowing Characteristic (X)"), doc("Dim Sight")];
        expect(characteristicClassItem("Glowing Strength", items)).toMatchObject({
            name: "Glowing Characteristic",
            specialization: "Strength",
        });
        expect(characteristicClassItem("Glowing Weapon Skill", items)?.specialization).toBe("Weapon Skill");
        expect(characteristicClassItem("Glowing Lamp", items)).toBeNull();
        expect(characteristicClassItem("Dim Strength", items)).toBeNull();
    });

    it("takes a count set before a listed weapon's or gear's name as its quantity", () => {
        expect(listedItems("Wick Pistol, 3 glim bombs", "weapon")).toEqual([
            { name: "Wick Pistol", type: "weapon" },
            { name: "glim bombs", type: "weapon", system: { quantity: 3 } },
        ]);
        expect(listedItems("2× oil flasks, 1d5 lamp coins, 2nd-best cloak", "gear")).toEqual([
            { name: "oil flasks", type: "gear", system: { quantity: 2 } },
            { name: "1d5 lamp coins", type: "gear" },
            { name: "2nd-best cloak", type: "gear" },
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
                { name: "Patched Coats", type: "gear" },
                { name: "Short Lance", type: "gear" },
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
            // Gear the document defines nowhere, named on a noun only its armour
            // closes on, is worn armour; one its gear closes on stays gear.
            ["Patched Coats", "armour", undefined],
            ["Short Lance", "gear", undefined],
        ]);
        expect(items.every((i) => typeof i["_id"] === "string" && String(i["_id"]).length === 16)).toBe(true);
        expect(Object(actor.fields["system"])["weapons"]).toEqual({ mode: "embedded", simple: [] });
    });

    it("restores a statblock list's spacing around brackets", () => {
        expect(tidyList("Glow Lore(Int)+10, Dodge (Ag ) +20,  Wick ( Lamps) (Int) -10")).toBe(
            "Glow Lore (Int) +10, Dodge (Ag) +20, Wick (Lamps) (Int) -10",
        );
    });

    it("reads the creature's size from its listed Size trait", () => {
        expect(sizeOf(listedItems("Dim Sight, Size (Hulking), Glow", "trait"))).toBe(5);
        expect(sizeOf(listedItems("Size (Puny)", "trait"))).toBe(2);
        expect(sizeOf(listedItems("Size (7)", "trait"))).toBe(7);
        expect(sizeOf(listedItems("Size (Vast)", "trait"))).toBeNull();
        expect(sizeOf(listedItems("Dim Sight", "trait"))).toBeNull();
        expect(sizeOf(listedItems("Size (Hulking)", "talent"))).toBeNull();
    });

    it("reads a reinforcement's call terms from its introduction", () => {
        expect(
            reinforcementTerms(
                "Influence Minimum: 40 Influence Cost: 6 Peer (LampWardens) talent lowers Influence Cost by 1d5\nProse.",
            ),
        ).toEqual({
            influenceMinimum: 40,
            influenceCost: 6,
            peerDiscount: { peer: "Lamp Wardens", amount: "1d5" },
        });
        expect(
            reinforcementTerms(
                "Influence Minimum: 50 Influence Cost: 5 The PC who calls it must possess the Gloom Lore (Moths) skill at the Trained level, and gains 1d5 Corruption points.",
            ),
        ).toEqual({
            influenceMinimum: 50,
            influenceCost: 5,
            caller: { skill: "gloomLore", specialization: "Moths", rank: 2, corruption: "1d5" },
        });
        // Rules prose naming the terms prints no figures for them.
        expect(reinforcementTerms("Each one has an Influence Minimum and an Influence Cost.")).toBeNull();
        expect(reinforcementTerms("Influence Minimum: 40")).toBeNull();
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
        const [found] = detectNumericGrids(ir);
        const blocks = found?.blocks ?? [];
        expect(blocks.map((b) => [b.label, b.pageIndex])).toEqual([
            ["Skills", 0],
            ["Talents", 0],
            ["Ember Rule", 1],
        ]);
        // The panel's own box is no running prose; text carried elsewhere may share its column with prose.
        const panel = new Set(found?.panelRuns?.map((r) => r.text));
        expect(panel.has("and more awareness")).toBe(true);
        expect(panel.has("and a keener eye")).toBe(false);
    });

    it("gives a label whose column was mistaken to the statblock it sits under", () => {
        const at = (text: string, x: number, y: number, column: number, bold = false): IRTextRun => ({
            ...irRun(text, 0, y),
            x,
            width: 6 * text.length,
            size: bold ? 13 : 9,
            weight: bold ? "bold" : "normal",
            column,
        });
        const label = (text: string, value: string, x: number, y: number, column: number) => [
            { ...at(text, x, y, column), weight: "bold" as const },
            at(value, x + 6 * text.length + 4, y, column),
        ];
        const gridAt = (x0: number, column: number, values: number[]): IRTextRun[] =>
            values.map((v, i) =>
                at(String(v), x0 + 30 * (i % 3), 600 - 25 * Math.floor(i / 3), column, true),
            );
        const ir = irOf(
            [0],
            [
                ...gridAt(160, 0, [31, 42, 27, 35, 30, 18, 33, 29, 12]),
                at("LAMP", 100, 640, 0, true),
                at("WARDEN", 140, 640, 0, true),
                ...gridAt(420, 1, [41, 22, 37, 25, 40, 28, 23, 39, 22]),
                at("WICK", 360, 640, 1, true),
                at("KEEPER", 400, 640, 1, true),
                // The second statblock's label, read into the first column, sits
                // higher than the first statblock's own text section.
                { ...at("Skills:", 316, 500, 0), weight: "bold" as const },
                at("Dodge, Parry", 360, 500, 1),
                ...label("Skills:", "Awareness", 60, 470, 0),
            ],
        );
        const skills = detectNumericGrids(ir).map(
            (g) => g.blocks.find((b) => b.label === "Skills")?.text ?? null,
        );
        expect(skills).toEqual(["Awareness", "Dodge, Parry"]);
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
        // The schema's sustained is a boolean: a printed "No" is false.
        expect(entryItem(sustain, "psychicPower").system["sustained"]).toBe(false);
        // A power printing no Effect field states its effect as its text; one that does, as that field.
        expect(entryItem(sustain, "psychicPower").variantized["effect"]).toBe("<p>Prose.</p>");
        const printed = entry("SPARK", [
            ["Threshold", "8"],
            ["Effect", "A spark leaps."],
        ]);
        expect(entryItem(printed, "psychicPower").variantized["effect"]).toBe("<p>A spark leaps.</p>");
        expect(entryType(entry("CLIMB (AGILITY)", [["Aptitudes", "Agility"]]))).toBe("skill");
    });

    it("types an ability bought with experience, its use and effect printed, as a talent", () => {
        const bought = entry(
            "LAMP-BEARER",
            [
                ["Type", "Passive"],
                ["Cost", "250 xp"],
                ["Effect", "The lamp never goes out."],
            ],
            ["Creation", "Lamplighter"],
            "",
        );
        expect(entryType(bought)).toBe("talent");
        const system = entryItem(bought, "talent").system;
        expect([system["cost"], system["isPassive"], system["benefit"]]).toEqual([
            250,
            true,
            "<p>The lamp never goes out.</p>",
        ]);
        // A price alone, or a type that is no use, types nothing.
        expect(
            entryType(
                entry("WICK", [
                    ["Cost", "250 xp"],
                    ["Effect", "Burns."],
                ]),
            ),
        ).toBe(null);
        expect(
            entryType(
                entry("WICK", [
                    ["Type", "Tallow"],
                    ["Cost", "250 xp"],
                    ["Effect", "Burns."],
                ]),
            ),
        ).toBe(null);
    });

    it("reads a printed Focus Power test into the schema's focusPower object", () => {
        const base = {
            characteristic: "willpower",
            modifier: 0,
            threshold: null,
            opposed: false,
            opposedCharacteristic: "",
            skill: "",
        };
        expect(focusPowerTest("Willpower", undefined)).toEqual(base);
        expect(focusPowerTest("Difficult (–10) Willpower test", undefined)).toEqual({
            ...base,
            modifier: -10,
        });
        expect(focusPowerTest("Opposed (+0) Willpower test", undefined)).toEqual({ ...base, opposed: true });
        expect(
            focusPowerTest("Opposed (−10) Willpower test, opposed by the target's Toughness", undefined),
        ).toEqual({ ...base, modifier: -10, opposed: true, opposedCharacteristic: "toughness" });
        expect(focusPowerTest("Challenging (+0) Perception test", undefined)).toEqual({
            ...base,
            characteristic: "perception",
        });
        // A single other word tested is a skill, keyed in lower camel case.
        expect(focusPowerTest("Ordinary (+10) Lampsense test", undefined)).toEqual({
            ...base,
            modifier: 10,
            skill: "lampsense",
        });
        // A line printing its threshold apart.
        expect(focusPowerTest(undefined, "8")).toEqual({ ...base, threshold: 8 });
        const item = entryItem(
            entry("SPARK", [
                ["Threshold", "9"],
                ["Focus Power", "Hard (–20) Willpower test"],
            ]),
            "psychicPower",
        );
        expect(item.system["focusPower"]).toEqual({ ...base, modifier: -20, threshold: 9 });
        expect(
            mapRow("psychicPower", { name: "Spark", focusPower: "Willpower" }).system["focusPower"],
        ).toEqual(base);
    });

    it("types a power by its Focus Power Test field, never a heading naming a discipline or a group", () => {
        const fields: [string, string][] = [
            ["Value", "100 xp"],
            ["Focus Power Test", "Willpower"],
        ];
        expect(entryType(entry("Glow Bolt", fields, ["Psychic Powers"]))).toBe("psychicPower");
        expect(entryType(entry("The Lampcraft Discipline", fields, ["Psychic Powers"]))).toBeNull();
        expect(entryType(entry("Psychic Techniques", fields, ["Psychic Powers"]))).toBeNull();
    });

    it("reads an item's effect from an Effects field as from an Effect field", () => {
        const rounds = entry(
            "LAMP ROUNDS",
            [
                ["Effects", "The weapon's Glow increases to 8."],
                ["Used With", "All lamps."],
            ],
            ["Armoury", "Special Ammunition"],
        );
        expect(entryItem(rounds, "ammunition").variantized["effect"]).toBe(
            "<p>The weapon's Glow increases to 8.</p>",
        );
    });

    it("types an oath by its name and effect under a section about oaths", () => {
        const oath = entry(
            "OATH OF THE LAMP",
            [
                ["Prerequisite", "Lamplighter"],
                ["Effect", "The lamp never goes out."],
            ],
            ["Preparation", "OATH-TAKING"],
        );
        expect(entryType(oath)).toBe("oath");
        const item = entryItem(oath, "oath");
        expect(item.system["requirement"]).toBe("<p>Lamplighter</p>");
        expect(item.variantized["effect"]).toBe("<p>The lamp never goes out.</p>");
        expect(entryType(entry("OATH PREREQUISITE", [], ["OATH-TAKING"]))).toBeNull();
    });

    it("types a ritual by its requirement and effect fields under a section of rituals", () => {
        const ritual = entry(
            "SUMMON THE LAMPLIGHTER",
            [
                ["Requirements", "A circle of candles."],
                ["Effects", "A lamplighter appears."],
                ["Cost", "One candle."],
                ["The Price of Failure", "The candles go out."],
            ],
            ["Rites and Rituals", "Example Rituals"],
        );
        expect(entryType(ritual)).toBe("ritual");
        expect(entryItem(ritual, "ritual").system).toEqual({
            requirements: "<p>A circle of candles.</p>",
            effect: "<p>A lamplighter appears.</p>",
            costs: "<p>One candle.</p>",
            failure: "<p>The candles go out.</p>",
        });
        expect(entryType({ ...ritual, sections: ["Gear"] })).toBeNull();
    });

    it("reads a heading listing talents as run-in name lines into one talent per line", () => {
        const sections = ["Allies", "WARDEN CAPTAIN"];
        const split = splitTalentLists([
            entry(
                "WARDEN VIGIL TALENTS",
                [
                    ["Lantern Ward", "Allies within 5 metres ignore darkness."],
                    ["The Quiet Step", "Movement makes no sound."],
                ],
                sections,
                "Spend a point to use one.",
            ),
        ]);
        expect(split.map((e) => e.heading.text)).toEqual([
            "WARDEN VIGIL TALENTS",
            "Lantern Ward",
            "The Quiet Step",
        ]);
        const [list, first] = split;
        if (list === undefined || first === undefined) {
            throw new Error("three entries expected");
        }
        expect(list.fields).toEqual([]);
        expect(list.body).toBe("Spend a point to use one.");
        expect(entryType(first)).toBe("talent");
        expect(first.sections).toEqual([...sections, "WARDEN VIGIL TALENTS"]);
        const item = entryItem(first, "talent");
        expect(item.name).toBe("Lantern Ward");
        expect(item.system["benefit"]).toBe("<p>Allies within 5 metres ignore darkness.</p>");
    });

    it("keeps a talents heading whose lines are fields, steps or a table header", () => {
        const unsplit = (fields: [string, string][]): number =>
            splitTalentLists([entry("STARTING TALENTS", fields)]).length;
        expect(
            unsplit([
                ["Prerequisites", "None."],
                ["Aptitudes", "Finesse"],
            ]),
        ).toBe(1);
        expect(
            unsplit([
                ["Starting Skills", "Awareness"],
                ["Starting Talents", "Dodge"],
            ]),
        ).toBe(1);
        expect(
            unsplit([
                ["NAME", "x"],
                ["RNG", "y"],
            ]),
        ).toBe(1);
        expect(unsplit([["Lantern Ward", "One alone is no list."]])).toBe(1);
        expect(
            splitTalentLists([
                entry("WARDEN TRAITS", [
                    ["Lantern Ward", "a"],
                    ["Quiet Step", "b"],
                ]),
            ]).length,
        ).toBe(1);
    });

    it("types pacts under a dark pacts section, their boons folded in from the sub-heading", () => {
        const sections = ["Lore", "dark pacts", "pacts and their effects"];
        const joined = joinPactGroups([
            entry("pact OF EMBERS", [], sections, "A pact for warmth."),
            entry("BOOns", [["Warm Hands", "Never cold."]], [...sections, "pact OF EMBERS"], "Banes text."),
            entry("DRAWING ATTENTION", [], ["Lore", "dark pacts"]),
        ]);
        expect(joined.map((e) => e.heading.text)).toEqual(["pact OF EMBERS", "DRAWING ATTENTION"]);
        const [pact, other] = joined;
        if (pact === undefined || other === undefined) {
            throw new Error("two entries expected");
        }
        expect(entryType(pact)).toBe("darkPact");
        expect(entryType(other)).toBeNull();
        expect(entryItem(pact, "darkPact").system["boons"]).toEqual([
            {
                identifier: "warm-hands",
                name: "Warm Hands",
                description: "<p>Never cold.</p>",
                modifiers: {},
                grants: [],
            },
        ]);
    });

    it("types medals with what they are awarded for and their squad bonus", () => {
        const sections = ["Rewards", "MEDALS AND HONOURS"];
        const medal = entry(
            "Lantern Star",
            [
                ["Description", "A brass star on a black ribbon."],
                ["Awarded for", "Holding the line in darkness."],
                ["Squad Bonus", "+10 to Fear Tests."],
            ],
            sections,
            "The star is rarely awarded.",
        );
        expect(entryType(medal)).toBe("medal");
        const item = entryItem(medal, "medal");
        expect(item.system["awardedFor"]).toBe("<p>Holding the line in darkness.</p>");
        expect(item.system["squadBonus"]).toBe("<p>+10 to Fear Tests.</p>");
        expect(item.description).toBe(
            "<p>A brass star on a black ribbon.</p><p>The star is rarely awarded.</p>",
        );
        expect(entryItem(entry("Wick Cross", [], ["Campaign Medals"]), "medal").system["honourType"]).toBe(
            "campaign",
        );
    });

    it("reads a skill's use time and, where it lists them as fields, its specialisations", () => {
        const lore = entryItem(
            entry(
                "LAMP LORE (INTELLIGENCE)",
                [
                    ["Aptitudes", "Intelligence, General"],
                    ["Skill Use", "Free Action."],
                    ["Reeds", "Knowledge of reeds."],
                    ["Tides", "Knowledge of tides."],
                    ["Wicks", "Knowledge of wicks."],
                ],
                ["Skills"],
            ),
            "skill",
        );
        expect(lore.system["useTime"]).toBe("Free Action");
        expect(lore.system["specialist"]).toBe(true);
        expect(lore.system["specializations"]).toEqual(["Reeds", "Tides", "Wicks"]);
        // A stray label (a sidebar's numeral) or two makes no specialist skill.
        expect(
            skillSpecialisations([
                ["Aptitudes", "Fellowship"],
                ["Skill Use", "Full Action."],
                ["VIII", "x"],
                ["Glow", "y"],
            ]),
        ).toEqual([]);
        // The label introducing the list of groups is none of them.
        expect(
            skillSpecialisations([
                ["Skill Groups", "Reeds, Tides, Wicks"],
                ["Reeds", "x"],
                ["Tides", "y"],
                ["Wicks", "z"],
            ]),
        ).toEqual(["Reeds", "Tides", "Wicks"]);
    });

    it("types vehicle traits apart from traits, and nothing under an umbrella naming a fielded kind", () => {
        const vehicles = ["Armoury", "Vehicles", "VEHICLE TRAITS"];
        expect(entryType(entry("HOVERING", [], vehicles))).toBe("vehicleTrait");
        expect(entryItem(entry("PLATED (X)", [], vehicles), "vehicleTrait").system["hasLevel"]).toBe(true);
        // "Talents and Traits" heads both kinds: its other headings are no traits.
        expect(entryType(entry("CREATING FOLLOWERS", [], ["Talents and Traits", "Followers"]))).toBeNull();
        expect(entryType(entry("GLOWING", [], ["Talents and Traits", "Traits", "Trait Descriptions"]))).toBe(
            "trait",
        );
    });

    it("types navigator powers with their mastery levels; a heading closing on the section's plural is furniture", () => {
        const sections = ["Navigators", "Navigator Powers"];
        const glance = entry(
            "The Long GLANCE",
            [
                ["Novice", "See far."],
                ["Adept", "See farther."],
                ["Master", "See all."],
            ],
            sections,
        );
        expect(entryType(glance)).toBe("navigatorPower");
        expect(entryItem(glance, "navigatorPower").system["levels"]).toEqual({
            novice: { effect: "<p>See far.</p>" },
            adept: { effect: "<p>See farther.</p>" },
            master: { effect: "<p>See all.</p>" },
        });
        expect(entryType(entry("Initial Powers", [], sections))).toBeNull();
        expect(entryType(entry("Usingnavigator Powers", [], ["Navigators"]))).toBeNull();
    });

    it("reads a navigator power's test from the first characteristic test its novice text asks for", () => {
        const sections = ["Navigators", "Navigator Powers"];
        const power = (novice: string) =>
            entryItem(entry("Lamp Gaze", [["Novice", novice]], sections), "navigatorPower").system["test"];
        // A test of something else first (a single test, the target's) is passed over.
        expect(power("Make a single test. On a Difficult (–10) Willpower Test, he glows.")).toEqual({
            characteristic: "willpower",
            modifier: -10,
            opposed: false,
            opposedCharacteristic: "",
        });
        // An opposed test of one characteristic is opposed by the same.
        expect(power("He then makes an Opposed Willpower test with the target.")).toEqual({
            characteristic: "willpower",
            modifier: 0,
            opposed: true,
            opposedCharacteristic: "willpower",
        });
        expect(power("With a successful Perception Test, he sees.")).toEqual({
            characteristic: "perception",
            modifier: 0,
            opposed: false,
            opposedCharacteristic: "",
        });
        // A characteristic the schema's test does not take is no test of the power.
        expect(power("He makes a Toughness Test or is slain.")).toBeUndefined();
    });

    it("types a ship's actions and an orders section's entries as orders", () => {
        const ship = ["Starships", "Starship Combat", "ACtions"];
        expect(entryType(entry("drift slowly", [], ship))).toBe("order");
        expect(entryType(entry("EXTENDED ACTIONS", [], ship))).toBeNull();
        // Actions outside a section about ships are no orders.
        expect(entryType(entry("DUCK", [], ["Combat", "Actions"]))).toBeNull();
        const comrades = ["Combat", "Comrades", "Orders", "Generic Orders"];
        expect(entryType(entry("Hold Still (Comrade Half Action)", [], comrades))).toBe("order");
        const order = entryItem(entry("Hold Still (Comrade Half Action)", [], comrades), "order");
        expect(order.name).toBe("Hold Still");
        expect(order.system["typeAndAction"]).toBe("Comrade Half Action");
    });

    it("types entries under a weapon qualities section, case-lost headings included", () => {
        const sections = ["Armoury", "WEAPONSPECIAL QUALITIES"];
        expect(entryType(entry("GLARING", [], sections))).toBe("weaponQuality");
        expect(entryType(entry("dazzle (x)", [], sections))).toBe("weaponQuality");
        expect(entryType(entry("glArE", [], sections))).toBe("weaponQuality");
        // A heading that is only a kind word is the section's furniture.
        expect(entryType(entry("TALENT", [], sections))).toBeNull();
        // Mixed case breaking off like prose stays prose.
        expect(entryType(entry("and Glare", [], sections))).toBeNull();
        const rated = entryItem(entry("DAZZLE (X)", [], sections, "Blinds the target."), "weaponQuality");
        expect(rated.system["hasLevel"]).toBe(true);
        expect(rated.variantized["effect"]).toBe("<p>Blinds the target.</p>");
        expect(entryItem(entry("GLARING", [], sections), "weaponQuality").system["hasLevel"]).toBe(false);
    });

    it("types a section headed by the gift category's label as mutations, with their riders", () => {
        const gift = entry(
            "GLOWING VEINS",
            [
                ["Khorne", "The veins burn red."],
                ["Note", "Not a rider."],
            ],
            ["Corruption", "Gifts of the Gods"],
            "The character's veins shine through his skin.",
        );
        expect(entryType(gift)).toBe("mutation");
        const item = entryItem(gift, "mutation");
        expect(item.system["category"]).toBe("gift");
        expect(item.system["gift"]).toEqual({
            riders: [{ alignment: "khorne", description: "<p>The veins burn red.</p>" }],
        });
        expect(mutationCategory(["Mutations", "Major Mutations"])).toBe("major");
        expect(mutationCategory(["Mutations"])).toBeNull();
        expect(entryItem(entry("SCALES", [], ["Mutations"]), "mutation").system["category"]).toBeUndefined();
    });

    it("gives a power the discipline its section prints, or none", () => {
        expect(printedDiscipline(["Chapter Six", "Psychic Powers", "LAMPCRAFT"])).toBe("Lampcraft");
        // A heading within a discipline groups some of its powers: the discipline is still the outer one.
        expect(printedDiscipline(["Psychic Disciplines", "Wick Lore", "Wick Rites"])).toBe("Wick Lore");
        // A display title set above the chapter's heading closes the catalogue section; a section
        // naming a discipline's powers stands in for it.
        expect(printedDiscipline(["Chapter Six", "Wick Powers"])).toBe("Wick");
        expect(printedDiscipline(["Chapter Six", "Wick Powers", "LAMPCRAFT", "Steady the flame"])).toBe(
            "Lampcraft",
        );
        // Printed straight under the catalogue, or outside one: no discipline, never the schema's default.
        expect(printedDiscipline(["Chapter Six", "Psychic Powers"])).toBe("");
        // A doubled display initial still names the catalogue; "… Powers" names its discipline.
        expect(printedDiscipline(["PPsychic Disciplines", "LAMPCRAFT"])).toBe("Lampcraft");
        expect(printedDiscipline(["Psychic Powers", "Wick Powers"])).toBe("Wick");
        // A section of disciplines is a catalogue; a catalogue qualified by its powers' kind is their discipline.
        expect(printedDiscipline(["the Lamp disciplines", "bright LAMPCRAFT"])).toBe("Bright Lampcraft");
        expect(printedDiscipline(["Lesser Psychic Powers", "Lesser Psychic Power Descriptions"])).toBe(
            "Lesser Psychic Powers",
        );
        expect(printedDiscipline(["Equipment"])).toBe("");
        // A section naming its discipline as such names it by the words before the word.
        expect(printedDiscipline(["Psychic Disciplines", "Lampcraft Discipline: Wick Techniques"])).toBe(
            "Lampcraft",
        );
        const spark = entryItem(
            entry("SPARK", [["Focus Power", "Willpower"]], ["Psychic Powers", "Lampcraft"]),
            "psychicPower",
        );
        expect(spark.system["discipline"]).toBe("Lampcraft");
    });

    it("reads a power's printed attack profile as its damage", () => {
        expect(powerAttackProfile("WICK LASH PSYCHIC BOLT RNG 5M X PR DMG 1D10+5+3XPR (E) PEN 2XPR")).toEqual(
            {
                formula: "1d10+3xPR",
                type: "energy",
                bonus: 5,
                penetration: 0,
            },
        );
        expect(powerAttackProfile("Rng 20m x Pr Dmg Pr (i) Pen 2")).toEqual({
            formula: "PR",
            type: "impact",
            bonus: 0,
            penetration: 2,
        });
        expect(powerAttackProfile("The lamp deals 1d10 Energy damage.")).toBeNull();
        const glare = entryItem(
            entry(
                "GLARE",
                [["Focus Power", "Willpower"]],
                ["Psychic Powers", "Lampcraft"],
                "Light. RNG 10M DMG 2D10 (E) PEN 0",
            ),
            "psychicPower",
        );
        expect(glare.system["damage"]).toEqual({ formula: "2d10", type: "energy", bonus: 0, penetration: 0 });
        expect(glare.system["isAttack"]).toBe(true);
    });

    it("reads a power whose text deals rolled damage as an attack, without a damage profile", () => {
        const flare = entryItem(
            entry(
                "FLARE",
                [["Focus Power", "Willpower"]],
                ["Psychic Powers", "Lampcraft"],
                "A gout of light deals 1d10+PR Energy damage to the target.",
            ),
            "psychicPower",
        );
        expect(flare.system["isAttack"]).toBe(true);
        expect(flare.system).not.toHaveProperty("damage");
        const calm = entryItem(
            entry(
                "CALM",
                [["Focus Power", "Willpower"]],
                ["Psychic Powers", "Lampcraft"],
                "The target heals 1d5 wounds.",
            ),
            "psychicPower",
        );
        expect(calm.system).not.toHaveProperty("isAttack");
    });

    it("reads a skill a `Focus Power Test:` label's value names as the test's", () => {
        const scry = entryItem(
            entry("SCRY", [["Focus Power Test", "Lampsight"]], ["Psychic Powers", "Lampcraft"]),
            "psychicPower",
        );
        expect(scry.system["focusPower"]).toMatchObject({ skill: "lampsight", characteristic: "willpower" });
    });

    it("reads the damage a power's text states, as a profile box's", () => {
        expect(
            powerProseDamage(
                "The lash deals 1d10+2 Energy Damage, +2 per point of Psy Rating, with a Pen of 3.",
            ),
        ).toEqual({ formula: "1d10+2xPR", type: "energy", bonus: 2, penetration: 3 });
        expect(powerProseDamage("Each mote suffers 1d10 + Psy Rating Explosive Damage with Pen 0.")).toEqual({
            formula: "1d10+PR",
            type: "explosive",
            bonus: 0,
            penetration: 0,
        });
        expect(
            powerProseDamage("The wick deals 2d10 Rending Damage, plus 1 per point of your Willpower Bonus."),
        ).toEqual({ formula: "2d10+WPB", type: "rending", bonus: 0, penetration: 0 });
        expect(
            powerProseDamage("Its attackers suffer Energy Damage equal to the psyker’s Psy Rating."),
        ).toEqual({
            formula: "PR",
            type: "energy",
            bonus: 0,
            penetration: 0,
        });
        // A penetration in a later sentence is not this damage's.
        expect(powerProseDamage("It deals 1d10 Impact Damage. The ward has a Pen of 2.")).toEqual({
            formula: "1d10",
            type: "impact",
            bonus: 0,
            penetration: 0,
        });
        expect(powerProseDamage("The target heals 1d5 wounds.")).toBeNull();
        const glow = entryItem(
            entry(
                "GLOW BOLT",
                [["Focus Power", "Willpower"]],
                ["Psychic Powers", "Lampcraft"],
                "The bolt deals 1d10 + Psy Rating Energy Damage with a Pen of 4.",
            ),
            "psychicPower",
        );
        expect(glow.system["damage"]).toEqual({
            formula: "1d10+PR",
            type: "energy",
            bonus: 0,
            penetration: 4,
        });
        expect(glow.system["isAttack"]).toBe(true);
    });

    it("gives powers the discipline an earlier heading under the catalogue names as such", () => {
        // The discipline's heading heads a panel of its basic rules, set smaller
        // than the groups of powers after it, so it is on none of their stacks.
        const catalogue = ["Psychic Powers", "Psychic Disciplines"];
        const read = withDisciplines([
            entry("The Lampcraft Discipline", [["Activation Time", "Free Action"]], catalogue),
            entry("Wick Techniques", [], catalogue),
            entry("Spark", [["Focus Power Test", "Willpower"]], [...catalogue, "Wick Techniques"]),
            entry("Iron Discipline", [["Prerequisites", "Willpower 30"]], ["Talents"]),
            entry("Glare", [["Focus Power Test", "Willpower"]], [...catalogue, "Glare Techniques"]),
        ]);
        expect(read.map((e) => e.discipline)).toEqual([
            "Lampcraft",
            "Lampcraft",
            "Lampcraft",
            undefined,
            undefined,
        ]);
        const [, , spark, , glare] = read;
        expect(spark === undefined ? null : entryItem(spark, "psychicPower").system["discipline"]).toBe(
            "Lampcraft",
        );
        // Leaving the catalogue (a talent's heading) ends it: the group heading names the next.
        expect(glare === undefined ? null : entryItem(glare, "psychicPower").system["discipline"]).toBe(
            "Glare Techniques",
        );
    });

    it("reads a power's Sustained line as the schema's boolean", () => {
        expect(isSustained("No")).toBe(false);
        expect(isSustained("—")).toBe(false);
        expect(isSustained("")).toBe(false);
        expect(isSustained("Yes")).toBe(true);
        expect(isSustained("Free Action")).toBe(true);
        expect(isSustained("Half Action")).toBe(true);
    });

    it("reads a power's printed experience cost into system.cost, keeping it out of the text", () => {
        const spark = entry(
            "SPARK",
            [
                ["Value", "300 xp"],
                ["Prerequisites", "Willpower 40"],
                ["Focus Power", "Challenging (+0) Willpower test"],
                ["Sustained", "No"],
            ],
            [],
            "A spark leaps from the hand of the psyker.",
        );
        const item = entryItem(spark, "psychicPower");
        expect(item.system["cost"]).toBe(300);
        // The description is the printed text, never the cost line (content#30).
        expect(item.description).toBe("<p>A spark leaps from the hand of the psyker.</p>");
        expect(powerXpCost(new Map([["xp cost", "1,200"]]))).toBe(1200);
        expect(powerXpCost(new Map([["cost", "200 xp"]]))).toBe(200);
        // A cost in coin is not experience.
        expect(powerXpCost(new Map([["cost", "50"]]))).toBeNull();
        expect(powerXpCost(new Map([["value", "rare"]]))).toBeNull();
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
        expect(item.system["prerequisites"]).toEqual({
            text: "Perception 30",
            characteristics: { perception: 30 },
            skills: [],
            talents: [],
            talentsAny: [],
            alignment: "",
            thresholds: {},
        });
    });

    it("structures a prerequisite line's gates in the schema's own keys (#673, #675)", () => {
        const read = (s: string): ReturnType<typeof structuredPrerequisites> => structuredPrerequisites(s);
        expect(read("Willpower 40").prerequisites["characteristics"]).toEqual({ willpower: 40 });
        expect(read("WP 50+, Psy Rating 4")).toEqual({
            prerequisites: {
                text: "WP 50+, Psy Rating 4",
                characteristics: { willpower: 50 },
                skills: [],
                talents: [],
                talentsAny: [],
                alignment: "",
                thresholds: {},
            },
            psyRating: 4,
        });
        expect(read("Corruption 30+, Psy Rating 4").prerequisites["thresholds"]).toEqual({ corruption: 30 });
        expect(read("5+ Insanity points").prerequisites["thresholds"]).toEqual({ insanity: 5 });
        expect(read("10 Corruption points").prerequisites["thresholds"]).toEqual({ corruption: 10 });
        expect(read("Rank 3").prerequisites["thresholds"]).toEqual({ rank: 3 });
        expect(read("Aligned Nurgle, Willpower 45").prerequisites).toMatchObject({
            alignment: "nurgle",
            characteristics: { willpower: 45 },
        });
        // A skill's rank is a skill gate, not the actor's rank; skills and talents stay text.
        expect(read("Lamp Lore rank 2").prerequisites["thresholds"]).toEqual({});
        // A part offering an alternative cannot be held by the shape: text only.
        expect(read("Fellowship 30 or 20+ Insanity").prerequisites).toMatchObject({
            characteristics: {},
            thresholds: {},
        });
        // "None" or a dash is the line as printed; it gates nothing.
        expect(read("None.").prerequisites).toMatchObject({
            text: "None",
            characteristics: {},
            thresholds: {},
        });
        expect(read("—").prerequisites["text"]).toBe("—");
    });

    it("gates a talent on its threshold only, never granting the stat (#691)", () => {
        const item = entryItem(
            entry("ASH SOUL", [["Prerequisites", "10 Corruption points"]], ["Talents"]),
            "talent",
        );
        expect(item.system["prerequisites"]).toMatchObject({ thresholds: { corruption: 10 } });
        expect(item.system).not.toHaveProperty("modifiers");
    });

    it("structures a power's prerequisites and reads the Psy Rating it needs as prCost", () => {
        const item = entryItem(
            entry("SPARK", [
                ["Prerequisites", "Willpower 40, Psy Rating 3"],
                ["Focus Power", "Willpower"],
            ]),
            "psychicPower",
        );
        expect(item.system["prerequisites"]).toMatchObject({
            text: "Willpower 40, Psy Rating 3",
            characteristics: { willpower: 40 },
        });
        expect(item.system["prCost"]).toBe(3);
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
        // A word a text layer ran on to one in capitals.
        expect(typeNamedBy("ODDAmmo")).toBe("ammunition");
        expect(typeNamedBy("Lampmutations")).toBeNull();
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

describe("power activation", () => {
    it("reads a printed action or focus time as the schema's activation type", () => {
        expect(activationType("Half Action")).toBe("half-action");
        expect(activationType("Full Action (Sustained)")).toBe("full-action");
        expect(activationType("Reaction")).toBe("reaction");
        expect(activationType("Free Action")).toBe("free-action");
        expect(activationType("2 Full Actions")).toBeNull();
    });

    it("reads the target a printed range implies", () => {
        expect(targetType("Self")).toBe("self");
        expect(targetType("You")).toBe("self");
        expect(targetType("5 metres x Psy Rating radius")).toBe("area");
        expect(targetType("20 metres x psy rating")).toBe("special");
    });

    it("writes activation and target only where printed", () => {
        expect(powerActivation("Half Action", "Self")).toEqual({
            activation: { type: "half-action" },
            target: { type: "self" },
        });
        expect(powerActivation(undefined, "—")).toEqual({});
    });
});

describe("unmarked section rows", () => {
    const row = (...texts: string[]): DetectedTable["rows"][number] => ({
        cells: texts.map((text, colIndex) => ({ colIndex, text, isHeader: false })),
        isHeaderRow: false,
        isSectionHeader: false,
        sectionName: null,
    });

    it("reads a words-only row filling one or two cells of a wide table as a section row", () => {
        expect(isUnmarkedSectionRow(row("Lamp Weapons"), 8)).toBe(true);
        expect(isUnmarkedSectionRow(row("Glow Projectile", "Weapons", "", ""), 8)).toBe(true);
    });

    it("keeps records, figures and narrow tables as they are", () => {
        expect(isUnmarkedSectionRow(row("Glow Pistol", "Pistol", "30m"), 8)).toBe(false);
        expect(isUnmarkedSectionRow(row("Glow Pistol", "30m"), 8)).toBe(false);
        expect(isUnmarkedSectionRow(row("Lamp Weapons"), 3)).toBe(false);
    });
});

describe("table benefits", () => {
    const reading = (blockId: string, benefit: string): Entity => ({
        blockId,
        documentType: "Item",
        group: "g",
        pack: "p",
        ordinal: 0,
        fields: { name: "Lamp Sense", type: "talent", system: { benefit } },
        images: {},
        provenance: { pageIndex: 0, y: 0 },
    });

    it("keeps a summary table's one-line benefit over the entry's longer prose", () => {
        const entry = reading("entry:talent", "<p>A long account of how the lamp sense works in play.</p>");
        const row = reading("table:talent", "<p>Sense lamps.</p>");
        preferTableBenefit(entry, [entry, row]);
        expect(entry.fields["system"]).toEqual({ benefit: "<p>Sense lamps.</p>" });
    });

    it("keeps the entry's benefit when no table prints one", () => {
        const entry = reading("entry:talent", "<p>Prose.</p>");
        preferTableBenefit(entry, [entry, reading("table:talent", "")]);
        expect(entry.fields["system"]).toEqual({ benefit: "<p>Prose.</p>" });
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

    it("reads a line of values under a keyed row, with no key of its own, as that key's variant row", () => {
        const at = (text: string, x: number, y: number): IRTextRun => ({ ...irRun(text, 0, y), x });
        // Lamps by size: the second size of the Wick Lamp prints only its own values.
        const rows = groupByKeyAnchors(
            [
                {
                    y: 472,
                    runs: [
                        at("Wick Lamp", 20, 472),
                        at("Small, Medium", 100, 472),
                        at("1", 200, 472),
                        at("-", 250, 472),
                    ],
                },
                { y: 458, runs: [at("Large", 100, 458), at("2", 200, 458), at("-", 250, 458)] },
                {
                    y: 444,
                    runs: [
                        at("Oil Lamp", 20, 444),
                        at("Small", 100, 444),
                        at("2", 200, 444),
                        at("+1", 250, 444),
                    ],
                },
                { y: 430, runs: [at("Large", 100, 430), at("3", 200, 430), at("+1", 250, 430)] },
            ],
            [0, 80, 180, 240],
        );
        expect(rows.map((r) => r.runs.map((x) => x.text))).toEqual([
            ["Wick Lamp", "Small, Medium", "1", "-"],
            ["Wick Lamp", "Large", "2", "-"],
            ["Oil Lamp", "Small", "2", "+1"],
            ["Oil Lamp", "Large", "3", "+1"],
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

    it("keeps a display title that wraps on a connecting word, not running text that does", () => {
        const title = heading(
            [
                ["Rules", 100, 70],
                ["of", 175, 25],
                ["the", 205, 40],
            ],
            30,
        );
        expect(headingOf(title, body, false)?.text).toBe("Rules of the");
        const subheading = heading([
            ["Rules", 100, 30],
            ["of", 134, 10],
            ["the", 148, 20],
        ]);
        expect(headingOf(subheading, body, false)).toBeNull();
    });

    it("keeps a capitals heading whose case was lost breaking off on a comma, not running text", () => {
        // Small capitals the text layer read in scrambled case, or in capitals
        // beside lower case, wrap their bracketed tags onto the next line.
        const scrambled = heading([["wiCK-Use (advanced,", 100, 90]]);
        expect(headingOf(scrambled, body, false)?.text).toBe("wiCK-Use (advanced,");
        const capitals = heading([["lantern (advanced, CRAFTING,", 100, 120]]);
        expect(headingOf(capitals, body, false)?.text).toBe("lantern (advanced, CRAFTING,");
        const prose = heading([["The Lantern, the Wick,", 100, 100]]);
        expect(headingOf(prose, body, false)).toBeNull();
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

    it("runs a field value on into a line opening in lower case, wherever that line starts", () => {
        const bold = (text: string, y: number, x: number): IRTextRun => ({
            ...run(text, y, "b", 10),
            x,
            weight: "bold",
        });
        const value = (text: string, y: number, x: number): IRTextRun => ({ ...run(text, y, "b", 10), x });
        const ir = irOf(
            [0],
            [
                run("GLOW SECTION", 700, "h", 14),
                run(body, 680, "b", 10),
                run("LAMP ROUNDS", 660, "h", 12),
                run(body, 640, "b", 10),
                // A short value line (a text layer under-reporting its width),
                // its sentence carried on by a line back at the margin.
                bold("Effects:", 620, 71),
                value("Glow Tests to see shots made", 620, 115),
                run("with lamp rounds suffer a penalty of ten.", 608, "b", 10),
                bold("Used With:", 590, 71),
                value("All lamps.", 590, 125),
                run(body, 578, "b", 10),
                // A finished list of names, or small capitals in lost case, is no open sentence.
                run("WICK WARD", 540, "h", 12),
                bold("Req:", 520, 71),
                value("Toughness 40", 520, 95),
                run("for as long as the ward lasts.", 508, "b", 10),
                bold("Special:", 490, 71),
                value("flame, spray", 490, 115),
                run("wICK lAnTErn Class hEAVy", 478, "b", 10),
            ],
        );
        const entries = detectEntries(ir, new Set());
        expect(entries.find((e) => e.heading.text === "LAMP ROUNDS")?.fields).toEqual([
            ["Effects", "Glow Tests to see shots made with lamp rounds suffer a penalty of ten."],
            ["Used With", "All lamps."],
        ]);
        expect(entries.find((e) => e.heading.text === "WICK WARD")?.fields).toEqual([
            ["Req", "Toughness 40"],
            ["Special", "flame, spray"],
        ]);
    });

    it("joins a heading broken off inside a bracket to its closing line set further below", () => {
        const ir = irOf(
            [0],
            [
                run("GLOW SECTION", 700, "h", 14),
                run(body, 680, "b", 10),
                run("WICK (ADVANCED,", 620, "h", 12),
                run("CRAFTING)", 597, "h", 12),
                run(body, 580, "b", 10),
                run("LAMP", 540, "h", 12),
                run("WARD", 517, "h", 12),
                run(body, 500, "b", 10),
            ],
        );
        const entries = detectEntries(ir, new Set());
        // A closed heading is not continued from as far.
        expect(entries.map((e) => e.heading.text)).toEqual([
            "GLOW SECTION",
            "WICK (ADVANCED, CRAFTING)",
            "LAMP",
            "WARD",
        ]);
    });

    it("reads a line sharing a baseline with a table's runs without them", () => {
        // A table header's second line ("Time") on the heading's baseline, and a
        // table cell on a field's.
        const time = { ...run("Time", 621, "t", 10), x: 400, weight: "bold" as const };
        const cell = { ...run("Half Action", 589, "t", 10), x: 400 };
        const ir = irOf(
            [0],
            [
                run("GLOW SECTION", 700, "h", 14),
                ...Array.from({ length: 6 }, (_, i) => run(body, 680 - 10 * i, "b", 10)),
                run("WICK WARD", 620, "h", 12),
                time,
                { ...run("Threshold:", 600, "b", 10), weight: "bold" },
                { ...run("12", 600, "b", 10), x: 140 },
                { ...run("Focus Time:", 588, "b", 10), weight: "bold" },
                { ...run("Free Action", 588, "b", 10), x: 140 },
                cell,
                run(body, 570, "b", 10),
            ],
        );
        const entry = detectEntries(ir, new Set([time, cell])).find((e) => e.heading.text === "WICK WARD");
        expect(entry?.fields).toEqual([
            ["Threshold", "12"],
            ["Focus Time", "Free Action"],
        ]);
    });

    it("reads the text on each side of a table set between columns as the column it carries on", () => {
        // Two columns above; below, one band holds the left column's text, a
        // table and the right column's text on shared baselines.
        const at = (text: string, x: number, y: number, column: number, size = 10): IRTextRun => ({
            ...run(text, y, size === 10 ? "b" : "h", size),
            x,
            width: text.length * size * 0.5,
            column,
        });
        const left = [
            "lamps are lit at dusk",
            "and burn until the",
            "watch is changed at",
            "the second bell.",
        ];
        const right = ["the wick is trimmed", "short so that it", "smoulders without", "any flame at all."];
        const cells = [
            ["Name", "Glow"],
            ["Tallow", "3"],
            ["Oil", "5"],
            ["Glass", "7"],
        ];
        const table = cells.flatMap(([name, glow], i) => [
            at(name ?? "", 240, 590 - 12 * i - 3, 2),
            at(glow ?? "", 320, 590 - 12 * i - 3, 2),
        ]);
        const ir = irOf(
            [0],
            [
                at("DIM GLOW", 60, 700, 0, 12),
                ...["a dim glow is the", "least of lamps, and", "the lamp is cheap."].map((t, i) =>
                    at(t, 60, 680 - 12 * i, 0),
                ),
                at("WICK WARD", 400, 700, 1, 12),
                ...["a ward keeps the", "lamp from going out", "when the wind rises,"].map((t, i) =>
                    at(t, 400, 680 - 12 * i, 1),
                ),
                ...left.map((t, i) => at(t, 60, 590 - 12 * i, 2)),
                ...right.map((t, i) => at(t, 400, 590 - 12 * i, 2)),
                ...table,
            ],
        );
        const entries = detectEntries(ir, new Set(table));
        const dim = entries.find((e) => e.heading.text === "DIM GLOW");
        const ward = entries.find((e) => e.heading.text === "WICK WARD");
        expect(dim?.body).toContain(
            "lamps are lit at dusk and burn until the watch is changed at the second bell.",
        );
        expect(dim?.body).not.toContain("wick is trimmed");
        expect(ward?.body).toContain(
            "the wick is trimmed short so that it smoulders without any flame at all.",
        );
        expect(ward?.body).not.toContain("lamps are lit");
    });

    it("ends a block of values set apart in their own column at the line back at the margin", () => {
        const bodyRight = 60 + body.length * 5;
        const field = (label: string, value: string, y: number): IRTextRun[] => [
            { ...run(label, y, "b", 10), weight: "bold" },
            { ...run(value, y, "b", 10), x: bodyRight - value.length * 5 },
        ];
        const ir = irOf(
            [0],
            [
                run("DIM WARD", 720, "h", 14),
                ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                ...field("Focus Time:", "Half Action", 450),
                ...field("Sustained:", "No", 438),
                ...field("Range:", "You", 426),
                run("You dim every lamp in sight.", 414, "b", 10),
            ],
        );
        const entry = detectEntries(ir, new Set()).find((e) => e.heading.text === "DIM WARD");
        expect(entry?.fields).toEqual([
            ["Focus Time", "Half Action"],
            ["Sustained", "No"],
            ["Range", "You"],
        ]);
        expect(entry?.body).toContain("You dim every lamp in sight.");
    });

    it("reads a heading a page sets twice over itself once", () => {
        const display = { ...run("LAMPCRAFT", 700, "h", 20), x: 100 };
        const shadow = { ...display, x: 104, y: 698, size: 18, width: 9 * 9, weight: "bold" as const };
        const word = { ...run("LAMPCRAFT", 700, "h", 20), x: 300 };
        expect(withoutShadows([display, shadow, word])).toEqual([display, word]);
    });

    it("opens a word at a small-caps initial the text layer set without a space", () => {
        // "THE LAMP" in small capitals: each word's initial a larger run, the
        // space between the words left out, the gap under a word space.
        const at = (text: string, x: number, size: number): IRTextRun => ({
            ...run(text, 700, "h", size),
            x,
            width: text.length * size * 0.5,
        });
        const t = at("T", 80, 16);
        const he = at("he", 88, 11);
        const l = at("L", 100.5, 16);
        const amp = at("amp", 108.5, 11);
        expect(joinRuns([t, he, l, amp])).toBe("The Lamp");
        // A smaller capital after a larger one, or figures, run on.
        expect(joinRuns([at("Mk", 80, 11), at("II", 91, 11)])).toBe("MkII");
    });

    it("continues a field set to a measure narrower than its column", () => {
        // Inset lines all 39 characters (195 points) wide, the column's own measure far wider:
        // the field's line is as full as its neighbours.
        const inset = (text: string, y: number): IRTextRun => run(text.padEnd(39, " "), y, "b", 10);
        const ir = irOf(
            [0],
            [
                run("DIM WARD", 720, "h", 14),
                ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                inset("A medal for those who keep the lamps", 450),
                inset("burning when all the others have gone", 438),
                inset("out across the whole of the marshland", 426),
                { ...run("Awarded for:", 414, "b", 10), weight: "bold" },
                { ...run("Keeping a lamp lit through", 414, "b", 10), x: 125 },
                inset("the longest night of the whole winter", 402),
                run("in the reeds.", 390, "b", 10),
                run("Then the next paragraph starts.", 378, "b", 10),
            ],
        );
        const entry = detectEntries(ir, new Set()).find((e) => e.heading.text === "DIM WARD");
        expect(entry?.fields[0]?.[1]).toBe(
            "Keeping a lamp lit through the longest night of the whole winter in the reeds.",
        );
    });

    it("continues a field whose sentence ends at a full line when the next line closes up under it", () => {
        const full = (text: string, y: number): IRTextRun => run(text.padEnd(body.length, " "), y, "b", 10);
        const fielded = (rest: IRTextRun[]): Entry | undefined =>
            detectEntries(
                irOf(
                    [0],
                    [
                        run("DIM WARD", 720, "h", 14),
                        ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                        { ...run("Effect:", 450, "b", 10), weight: "bold" },
                        { ...run("The lamp dims until the end of the night.", 450, "b", 10), x: 100 },
                        ...rest,
                    ],
                ),
                new Set(),
            ).find((e) => e.heading.text === "DIM WARD");
        // The value's line reaches the measure (padded), the next follows at line spacing.
        const ended = { ...run("Effect:", 450, "b", 10), weight: "bold" as const };
        const value = {
            ...run("The lamp dims until the end of the night.".padEnd(body.length - 15, " "), 450, "b", 10),
            x: 135,
        };
        const entry = detectEntries(
            irOf(
                [0],
                [
                    run("DIM WARD", 720, "h", 14),
                    ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                    ended,
                    value,
                    run("When it does, each ally sees.", 438, "b", 10),
                ],
            ),
            new Set(),
        ).find((e) => e.heading.text === "DIM WARD");
        expect(entry?.fields[0]?.[1]).toBe(
            "The lamp dims until the end of the night. When it does, each ally sees.",
        );
        // After a paragraph's gap, or under a short line, the text is the entry's own.
        const apart = fielded([full("A new paragraph of the entry's own text begins.", 420)]);
        expect(apart?.fields[0]?.[1]).toBe("The lamp dims until the end of the night.");
        expect(apart?.body).toContain("A new paragraph");
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

    it("ends a finished list of names at its line when the entry's own sentences follow at its edge", () => {
        const bodyRight = 60 + body.length * 5;
        const fielded = (value: string, next: string[]): Entry | undefined => {
            const ir = irOf(
                [0],
                [
                    run("DIM WARD", 720, "h", 14),
                    ...Array.from({ length: 20 }, (_, i) => run(body, 700 - 12 * i, "b", 10)),
                    { ...run("Requires:", 450, "b", 10), weight: "bold" },
                    // The value's line fills the measure: it wraps.
                    { ...run(value, 450, "b", 10), x: bodyRight - value.length * 5 },
                    ...next.map((t, i) =>
                        run(t.padEnd(i < next.length - 1 ? body.length : 0), 438 - 12 * i, "b", 10),
                    ),
                ],
            );
            return detectEntries(ir, new Set()).find((e) => e.heading.text === "DIM WARD");
        };
        const ranOn = fielded("Glow Lore (Lamps), Steady Hand 40", [
            "The bearer keeps a lamp lit through the longest of",
            "nights, and every ally near him sees by it.",
        ]);
        expect(ranOn?.fields).toEqual([["Requires", "Glow Lore (Lamps), Steady Hand 40"]]);
        expect(
            ranOn?.body.endsWith(
                "characters. The bearer keeps a lamp lit through the longest of nights, and every ally near him sees by it.",
            ),
        ).toBe(true);
        // More names, even closed by a full stop, stay the field's.
        const names = fielded("Glow Lore (Lamps), Steady Hand 40, Dim", ["Wick Lore."]);
        expect(names?.fields).toEqual([["Requires", "Glow Lore (Lamps), Steady Hand 40, Dim Wick Lore."]]);
        // A name broken inside its bracket runs on.
        const open = fielded("Glow Lore (Lamps), Steady Hand (Wick", ["Lamps) Tests made in the dark."]);
        expect(open?.fields).toEqual([
            ["Requires", "Glow Lore (Lamps), Steady Hand (Wick Lamps) Tests made in the dark."],
        ]);
        // Prose broken before a capital is no list: it runs on.
        const prose = fielded("The bearer may keep his Steady Hand", ["Tests until dawn."]);
        expect(prose?.fields).toEqual([
            ["Requires", "The bearer may keep his Steady Hand Tests until dawn."],
        ]);
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

    it("reads an ammunition table's Used With column as the weapons it loads", () => {
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
        const ir = irOf(
            [0],
            [
                run(body, 760, "b", 10),
                cell("Table 5-9: Special Ammunition", 60, 720, "bold"),
                ...["Name", "Can Upgrade", "Availability"].map((h, i) =>
                    cell(h, [60, 200, 400][i] ?? 0, 700, "bold"),
                ),
                ...[
                    ["Glow Rounds", "Any Las weapon"],
                    ["Wick Shells", "Any Bolt weapon"],
                    ["Hush Darts", "Any Flame weapon"],
                    ["Dim Pellets", "Any Las or Bolt weapon"],
                ].flatMap(([name, fits], i) => [
                    cell(name ?? "", 60, 680 - 20 * i),
                    cell(fits ?? "", 200, 680 - 20 * i),
                    cell("Scarce", 400, 680 - 20 * i),
                ]),
            ],
        );
        const loads = infer(ir, createLogger("error"), TARGETS.dh2)
            .graph.entities.filter((e) => e.fields["type"] === "ammunition")
            .map((e) => [e.fields["name"], Object(e.fields["system"])["weaponTypes"]]);
        expect(loads).toEqual([
            ["Glow Rounds", ["las"]],
            ["Wick Shells", ["bolt"]],
            ["Hush Darts", ["flame"]],
            ["Dim Pellets", ["las", "bolt"]],
        ]);
    });

    it("flags the components a caption names essential", () => {
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
        const components = (caption: string): JsonValue[] => {
            const kind = caption.split(" ")[0] ?? "";
            const ir = irOf(
                [0],
                [
                    run(body, 760, "b", 10),
                    cell(`Table 8-3: ${caption}`, 60, 720, "bold"),
                    ...[`${kind} Components`, "Hull Types", "Power", "Space", "SP"].map((h, i) =>
                        cell(h, [60, 220, 340, 400, 460][i] ?? 0, 700, "bold"),
                    ),
                    ...["Lamp Bridge", "Wick Quarters", "Glow Drive", "Hush Array"].flatMap((name, i) => [
                        cell(name, 60, 680 - 20 * i),
                        cell("All Ships", 220, 680 - 20 * i),
                        cell(String(i + 1), 340, 680 - 20 * i),
                        cell("2", 400, 680 - 20 * i),
                        cell("1", 460, 680 - 20 * i),
                    ]),
                ],
            );
            return infer(ir, createLogger("error"), TARGETS.rt)
                .graph.entities.filter((e) => e.fields["type"] === "shipComponent")
                .map((e) => (e.fields["system"] as JsonObject | undefined)?.["essential"] ?? null);
        };
        expect(components("Essential Components")).toEqual([true, true, true, true]);
        expect(components("Supplemental Components")).toEqual([null, null, null, null]);
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

    it("treats a value breaking off on an article or preposition as wrapped", () => {
        expect(valueUnfinished("As a Full Action, the lamp makes an")).toBe(true);
        expect(valueUnfinished("He glows for a number of")).toBe(true);
        // A name's capital letter is no article.
        expect(valueUnfinished("Lamp Class A")).toBe(false);
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

        // A roll table's row points to the entity: its own entry is cited.
        const entry = reading(16, "16");
        const rolled = { ...reading(14, "14"), blockId: `table:mutation${ROLLED_ROW}` };
        citeFirstPage(entry, [entry, rolled], DEFAULT_LINE);
        expect(entry.fields["system"]).toEqual({
            source: { dh2: { provenance: "raw", book: "b", page: "16" } },
        });
        // Read nowhere else, the row is cited.
        const alone = { ...reading(14, "14"), blockId: `table:mutation${ROLLED_ROW}` };
        citeFirstPage(alone, [alone], DEFAULT_LINE);
        expect(alone.fields["system"]).toEqual({
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

    it("takes a heading setting a word of the name in the plural when none prints it exactly", () => {
        const plural = heading("REED KINGS GUARD", 72);
        expect(introducingEntry([plural], "Reed King Guard", 72)).toBe(plural);
        const exact = heading("REED KING GUARD", 72);
        expect(introducingEntry([exact, plural], "Reed King Guard", 72)).toBe(exact);
    });

    it("finds the entry an entry sits under, within reach", () => {
        const outer = heading("MIRE HOUND", 71);
        const inner = { ...heading("Mire Hound Profile", 71), sections: ["MIRE HOUND"] };
        const far = { ...heading("Mire Hound Profile", 75), sections: ["MIRE HOUND"] };
        expect(enclosingEntry([outer, inner, far], inner)).toBe(outer);
        expect(enclosingEntry([outer, inner, far], far)).toBeNull();
        expect(enclosingEntry([outer], outer)).toBeNull();
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

    it("reads a craft's boxed weapon profile entry as panel lines, each weapon's qualities after it", () => {
        const entry: Entry = {
            heading: { text: "Twin Lamp Gun CLASS HEAVY", size: 13, style: "w", pageIndex: 0 },
            sections: [],
            fields: [
                ["SPECIAL", "FLAME"],
                ["SPECIAL", "TEARING"],
                ["Wick Upgrades", "The craft may take a wick."],
            ],
            body: "RNG 30M ROF S/-/- DMG 1D10 + 5 (E)\n\nPEN 4 CLIP 20 RLD 2 FULL\n\nG l o w C a n n o n CLASS HEAVY\n\nRNG 60M ROF S/-/- DMG 2D10 (E)",
        };
        expect(weaponProfileText(entry).split("\n")).toEqual([
            "Twin Lamp Gun CLASS HEAVY",
            "RNG 30M ROF S/-/- DMG 1D10 + 5 (E)",
            "PEN 4 CLIP 20 RLD 2 FULL",
            "SPECIAL: FLAME",
            "G l o w C a n n o n CLASS HEAVY",
            "RNG 60M ROF S/-/- DMG 2D10 (E)",
            "SPECIAL: TEARING",
        ]);
    });

    it("deals a weapons heading's Special lines to the profiles it prints, its other fields rules", () => {
        const part: Entry = {
            heading: { text: "weapons", size: 9, style: "craft", pageIndex: 0 },
            sections: [],
            fields: [
                ["Special", "FLAME"],
                ["Special", "TEARING"],
                ["Huge Wheels", "It crosses anything."],
            ],
            body: "It carries two guns:\n\nGlow Gun Class HEAVY\n\nRNG 30M DMG 1D10 (E)\n\nWick Gun Class HEAVY\n\nRNG 20M DMG 1D5 (E)",
        };
        expect(weaponsPartRules(part)).toEqual([
            [
                "weapons",
                "It carries two guns:\nGlow Gun Class HEAVY\nRNG 30M DMG 1D10 (E)\nSpecial: FLAME\nWick Gun Class HEAVY\nRNG 20M DMG 1D5 (E)\nSpecial: TEARING",
            ],
            ["Huge Wheels", "It crosses anything."],
        ]);
        expect(weaponsPartRules({ ...part, fields: [] })).toEqual([["weapons", part.body]]);
    });

    it("takes a craft's weapons heading, even set like its name, and the weapon profiles headed under it", () => {
        const entry = (text: string, style: string, body = "", fields: [string, string][] = []): Entry => ({
            heading: { text, size: 9, style, pageIndex: 0 },
            sections: [],
            fields,
            body,
        });
        const entries = [
            entry("LAMP CRAWLER", "craft", "A lumbering lamp.\n\nFRONT: 12 SIDE: 10 REAR: 8"),
            entry("weapons", "craft", "One hull-mounted gun:"),
            entry("Glow Gun CLASS HEAVY", "profile", "RNG 30M ROF S/-/- DMG 1D10 (E)", [
                ["SPECIAL", "FLAME"],
            ]),
            entry("WICK CRAWLER", "craft", "Another lamp."),
        ];
        expect(vehicleParts(entries, 0, new Set()).map((e) => e.heading.text)).toEqual([
            "weapons",
            "Glow Gun CLASS HEAVY",
        ]);
        // A weapons heading set like the craft's name but after another part ends the parts.
        const later = [entries[0], entry("Wick Rules", "rule"), entries[1]].filter((e) => e !== undefined);
        expect(vehicleParts(later, 0, new Set()).map((e) => e.heading.text)).toEqual(["Wick Rules"]);
        // A profile in the craft's own text.
        const own = entry(
            "LAMP CRAWLER",
            "craft",
            "A lumbering lamp.\n\nGlow Gun CLASS HEAVY\n\nRNG 30M ROF S/-/-",
        );
        expect(ownProfileText(own)).toBe("Glow Gun CLASS HEAVY\nRNG 30M ROF S/-/-");
        expect(ownProfileText(entries[3] ?? own)).toBeNull();
    });

    it("knows a heading listing several creatures names none of them more fully", () => {
        expect(listsCaption("LAMP ENGINE AND WICK PARASITE ENGINE", "Lamp Engine (Elite)")).toBe(true);
        expect(listsCaption("Mire Dok & Reedbork", "Mire Dok")).toBe(true);
        // "or" offers one creature's other names; a single name lists nothing.
        expect(listsCaption("INDUSTRIAL or HEAVY LAMP SERVITOR", "Lamp Servitor")).toBe(false);
        expect(listsCaption("ESHA WICK, THE LANTERN BEARER", "Esha Wick")).toBe(false);
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

    it("sets a printed price as the target line's own acquisition currency", () => {
        const priced = (line: Line): unknown =>
            (
                buildItem({
                    type: "gear",
                    name: "Lamp",
                    line,
                    book: "b",
                    page: "3",
                    description: "",
                    system: { cost: 20 },
                })["system"] as Record<string, unknown>
            )["cost"];
        expect((priced("dh1") as Record<string, Record<string, unknown>>)["dh1"]?.["throneGelt"]).toBe(20);
        expect((priced("dw") as Record<string, Record<string, unknown>>)["dw"]?.["requisition"]).toBe(20);
        // Every other line keeps its fields empty.
        expect((priced("dw") as Record<string, Record<string, unknown>>)["dh1"]?.["throneGelt"]).toBeNull();
        expect(headerRole("Req")).toBe("cost");
    });

    it("stores a heavy weapon two-handed, as the system wields it", () => {
        const twoHanded = (system: JsonObject): unknown =>
            (
                buildItem({
                    type: "weapon",
                    name: "Lamp Cannon",
                    line: "dh2",
                    book: "b",
                    page: "3",
                    description: "",
                    system,
                })["system"] as Record<string, unknown>
            )["twoHanded"];
        expect(twoHanded({ class: "heavy" })).toBe(true);
        expect(twoHanded({ class: "pistol" })).toBeUndefined();
        // A printed flag stands.
        expect(twoHanded({ class: "heavy", twoHanded: false })).toBe(false);
    });

    it("stores a printed dash for damage as the schema's no-damage profile", () => {
        const damage = (formula: string): unknown =>
            (
                buildItem({
                    type: "weapon",
                    name: "Glim Bomb",
                    line: "dh2",
                    book: "b",
                    page: "3",
                    description: "",
                    system: { damage: { formula, type: "impact", bonus: 0, penetration: 0 } },
                })["system"] as Record<string, unknown>
            )["damage"];
        expect(damage("-")).toEqual({ formula: "", none: true, type: "impact", bonus: 0, penetration: 0 });
        expect(damage("—")).toMatchObject({ formula: "", none: true });
        expect(damage("1d10")).toEqual({ formula: "1d10", type: "impact", bonus: 0, penetration: 0 });
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

describe("section-qualified table names", () => {
    const row = (cells: string[]): TableRow => ({
        cells: cells.map((text, colIndex) => ({ text, colIndex, isHeader: false })),
        isHeaderRow: false,
        isSectionHeader: false,
        sectionName: null,
    });
    const section = (name: string): TableRow => ({
        cells: [],
        isHeaderRow: false,
        isSectionHeader: true,
        sectionName: name,
    });
    const table = (rows: TableRow[]): DetectedTable => ({
        pageIndex: 0,
        headers: ["Type", "Cost"],
        rows,
        tableTitle: "Lamp Services",
    });

    it("groups medals under the nearest honour-type heading beside them", () => {
        const at = (text: string, sections: string[], fields: [string, string][] = []): Entry => ({
            heading: { text, size: 11, style: "h", pageIndex: 0 },
            sections,
            fields,
            body: "",
        });
        const awards = ["Rewards", "Medals"];
        const first = at("Lamp Star", awards, [["Awarded for", "Bravery."]]);
        const second = at("Wick Cross", awards, [["Awarded for", "Wit."]]);
        const elsewhere = at("Oil Rules", ["Rules"]);
        const groups = honourGroupsOf([
            at("IMPERIAL HONOURS", awards),
            first,
            at("CAMPAIGN HONOURS", [...awards, "Lamp Star"]),
            second,
            elsewhere,
        ]);
        expect([groups.get(first), groups.get(second), groups.get(elsewhere)]).toEqual([
            "imperial",
            "campaign",
            undefined,
        ]);
        // Orders take their action type from a group heading the same way, fields or none.
        const steer = at("Steer Wide", ["Ships", "Actions"]);
        const actions = actionGroupsOf([
            at("MANOEUVRE ACTIONS", ["Ships", "Actions"], [["Note", "Tests may be modified."]]),
            steer,
        ]);
        expect(actions.get(steer)).toBe("maneuver-action");
    });

    it("reads a severity table into a critical injury's graded effects", () => {
        const severity = {
            ...table([
                row(["1", "The wick sputters."]),
                row(["2", "The wick smokes."]),
                row(["3", "Permanently lose a finger."]),
            ]),
            tableTitle: "Energy Critical Effects - Arm",
        };
        expect(criticalEffects(severity)).toEqual({
            damageType: "energy",
            bodyPart: "arm",
            severity: 1,
            effects: {
                "1": { text: "<p>The wick sputters.</p>", permanent: false },
                "2": { text: "<p>The wick smokes.</p>", permanent: false },
                "3": { text: "<p>Permanently lose a finger.</p>", permanent: true },
            },
        });
        // Rows not keyed by single damage figures are no graded effects.
        expect(criticalEffects(table([row(["01-30", "A"]), row(["31-60", "B"]), row(["61-00", "C"])]))).toBe(
            null,
        );
    });

    it("names a grade repeated under each section by its section", () => {
        const low = row(["Low Grade (Tallow, Rush)", "5"]);
        const high = row(["High Grade", "50"]);
        const lowOil = row(["Low Grade", "2"]);
        const names = qualifiedBySection(
            table([section("Candles"), low, high, section("Oil"), lowOil, row(["High Grade", "20"])]),
            0,
        );
        expect([names.get(low), names.get(high), names.get(lowOil)]).toEqual([
            "Candles: Low Grade",
            "Candles: High Grade",
            "Oil: Low Grade",
        ]);
    });

    it("keeps each heading's prose by its name, for items a table lists without text", () => {
        const at = (heading: string, body: string): Entry => ({
            heading: { text: heading, size: 11, style: "h", pageIndex: 0 },
            sections: [],
            fields: [],
            body,
        });
        const prose = headedProse([
            at("GLOW-LAMP/LANTERN", "A small lamp that burns for a whole night on one wick."),
            at("Glow-Lamp/Lantern", "A later mention of the same lamp, in other words entirely."),
            at("WICK", "Short."),
        ]);
        expect(prose.get(nameKey("Glow-Lamp/Lantern"))).toBe(
            "<p>A small lamp that burns for a whole night on one wick.</p>",
        );
        expect(prose.has(nameKey("Wick"))).toBe(false);
    });

    it("carries a section row closing one part of a split table to the next part", () => {
        const first = table([row(["Glow Gun", "5"]), section("Ember Weapons")]);
        const second = table([row(["Ember Gun", "6"])]);
        const other = { ...table([row(["Wick", "1"])]), tableTitle: "Wicks" };
        const carried = carriedSections([first, second, other]);
        expect(carried.get(second)).toBe("Ember Weapons");
        expect(carried.has(first)).toBe(false);
        expect(carriedSections([first, other]).size).toBe(0);
        // A captioned table's sub-table may set fewer columns of its own.
        const narrower = { ...table([row(["Spark", "1"])]), headers: ["Name", "Cost"] };
        expect(carriedSections([first, narrower]).get(narrower)).toBe("Ember Weapons");
    });

    it("names a variety under a kind section by the full name the document prints", () => {
        const text = "the wick grenade burns; a fire pot is thrown. two glow grenades lit.";
        expect(kindNamed("Wick", "grenade", text)).toBe("Wick Grenade");
        expect(kindNamed("Glow", "grenade", text)).toBe("Glow Grenade");
        expect(kindNamed("Fire Pot", "grenade", text)).toBe("Fire Pot");
        expect(kindNamed("Ember Grenade", "grenade", text)).toBe("Ember Grenade");
        expect(kindNamed("Wick", "las", text)).toBe("Wick");
    });

    it("leaves a catalogue that repeats a name or two", () => {
        const names = qualifiedBySection(
            table([
                section("Wicks"),
                row(["Glow Wick", "5"]),
                row(["Long Wick", "6"]),
                row(["Twin Wick", "7"]),
                section("Lamps"),
                row(["Glow Wick", "5"]),
                row(["Hood Lamp", "9"]),
                row(["Brass Lamp", "9"]),
            ]),
            0,
        );
        expect(names.size).toBe(0);
    });
});
