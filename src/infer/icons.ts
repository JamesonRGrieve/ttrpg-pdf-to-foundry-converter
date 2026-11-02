// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entity, JsonObject, JsonValue } from "../types/entity.ts";

/**
 * Default art for a document the PDF gives no image: a game-icons.net icon
 * (CC BY 3.0) chosen by the document's FUNCTION — its type, a weapon's
 * type/class or generic kind of arm, an armour's type, a talent's first
 * aptitude or category, a power's discipline — hotlinked from the jsDelivr
 * CDN, as the wh40k-rpg system's own packs do. The system replaces such
 * default icons freely; it never treats them as curated art.
 *
 * PROVENANCE: copied from the wh40k-rpg system's reviewed table
 * `scripts/pack-icon-map.json` (resolver `scripts/pack-icon-map.mjs`), system
 * repo commit d33428f8d (the table last changed in 3b185d570), 2026-11-01.
 * Kept to the system's role names and rule order so the two can be diffed.
 * Left out, because they are keyed by names printed in books rather than by
 * schema structure (this engine ships no content vocabulary): the table's
 * condition-name rules and its condition icons, and the psychic-discipline
 * patterns naming setting-specific disciplines. A document no rule covers
 * keeps Foundry's own default.
 *
 * Icon authors (credited by the system in `src/icons/ATTRIBUTION.md`):
 * Delapouite, Lorc, Skoll, John Colburn, Carl Olsen — game-icons.net, CC BY 3.0.
 */

export const ICON_CDN = "https://cdn.jsdelivr.net/gh/game-icons/icons@master";

/** Role → game-icons path (`<author>/<name>`, no extension). */
export const ICONS: Readonly<Record<string, string>> = {
    "weapon.default": "lorc/crossed-swords",
    "weapon.las": "lorc/ray-gun",
    "weapon.bolt": "lorc/bolter-gun",
    "weapon.plasma": "lorc/plasma-bolt",
    "weapon.melta": "lorc/laserburn",
    "weapon.flame": "delapouite/flamethrower",
    "weapon.launcher": "delapouite/missile-launcher",
    "weapon.grenade": "lorc/grenade",
    "weapon.explosive": "lorc/fire-bomb",
    "weapon.chain": "delapouite/chainsaw",
    "weapon.power": "lorc/lightning-saber",
    "weapon.shock": "lorc/electric-whip",
    "weapon.force": "lorc/rune-sword",
    "weapon.shield": "lorc/checked-shield",
    "weapon.pistol": "john-colburn/pistol-gun",
    "weapon.basic": "skoll/winchester-rifle",
    "weapon.heavy": "skoll/machine-gun",
    "weapon.mounted": "lorc/sentry-gun",
    "weapon.thrown": "lorc/thrown-daggers",
    "weapon.melee": "lorc/broadsword",
    "weapon.shotgun": "delapouite/sawed-off-shotgun",
    "weapon.bow": "delapouite/bow-arrow",
    "weapon.crossbow": "carl-olsen/crossbow",
    "weapon.axe": "lorc/battle-axe",
    "weapon.knife": "lorc/broad-dagger",
    "weapon.spear": "lorc/barbed-spear",
    "weapon.hammer": "delapouite/warhammer",
    "weapon.mace": "lorc/spiked-mace",
    "weapon.club": "delapouite/wood-club",
    "weapon.staff": "lorc/wizard-staff",
    "weapon.whip": "lorc/whip",
    "weapon.flail": "delapouite/flail",
    "weapon.claw": "lorc/claw-slashes",
    "weapon.bite": "lorc/bestial-fangs",
    "weapon.unarmed": "lorc/fist",
    "armour.default": "delapouite/chest-armor",
    "armour.flak": "lorc/armor-vest",
    "armour.mesh": "lorc/layered-armor",
    "armour.carapace": "delapouite/chest-armor",
    "armour.power": "delapouite/overlord-helm",
    "armour.void": "lorc/space-suit",
    "armour.primitive": "delapouite/leather-armor",
    "armour.xenos": "lorc/armoured-shell",
    "armour.force-field": "lorc/energy-shield",
    "talent.default": "delapouite/star-medal",
    "talent.weapon-skill": "lorc/sword-clash",
    "talent.ballistic-skill": "delapouite/crosshair",
    "talent.strength": "delapouite/biceps",
    "talent.toughness": "lorc/turtle-shell",
    "talent.agility": "lorc/sprint",
    "talent.intelligence": "lorc/brain",
    "talent.perception": "delapouite/eye-target",
    "talent.willpower": "lorc/aura",
    "talent.fellowship": "delapouite/shaking-hands",
    "talent.offence": "lorc/bloody-sword",
    "talent.defence": "lorc/bordered-shield",
    "talent.finesse": "lorc/laser-precision",
    "talent.leadership": "lorc/laurel-crown",
    "talent.knowledge": "lorc/open-book",
    "talent.psyker": "lorc/psychic-waves",
    "talent.fieldcraft": "lorc/compass",
    "talent.tech": "lorc/gears",
    "talent.social": "lorc/conversation",
    "talent.chaos": "lorc/daemon-skull",
    "talent.faith": "lorc/prayer",
    "psychic.default": "lorc/psychic-waves",
    "psychic.telepathy": "lorc/telepathy",
    "psychic.pyromancy": "lorc/fireball",
    "psychic.biomancy": "lorc/anatomy",
    "psychic.divination": "delapouite/all-seeing-eye",
    "psychic.telekinesis": "lorc/glowing-hands",
    "psychic.cryokinesis": "lorc/frozen-orb",
    "psychic.chaos": "lorc/gooey-daemon",
    "psychic.daemonology": "lorc/pentagram-rose",
    "psychic.sorcery": "lorc/book-aura",
    "psychic.divine": "lorc/prayer",
    "trait.default": "lorc/dna1",
    "weaponQuality.default": "delapouite/swords-power",
    "weaponModification.default": "delapouite/reload-gun-barrel",
    "armourModification.default": "delapouite/armor-upgrade",
    "ammunition.default": "lorc/bullets",
    "originPath.default": "lorc/interstellar-path",
    "darkPact.default": "skoll/pentacle",
    "medal.default": "delapouite/star-medal",
    "order.default": "delapouite/megaphone",
    "navigatorPower.default": "lorc/third-eye",
    "ritual.default": "lorc/pentagram-rose",
    "criticalInjury.default": "lorc/broken-bone",
    "forceField.default": "lorc/energy-shield",
    "shipComponent.default": "delapouite/spaceship",
    "shipComponent.drive": "delapouite/rocket-thruster",
    "shipComponent.shields": "lorc/bolt-shield",
    "shipWeapon.default": "delapouite/laser-turret",
    "shipRole.default": "delapouite/captain-hat-profile",
    "shipUpgrade.default": "lorc/mighty-spanner",
    "vehicleTrait.default": "skoll/tank-tread",
    "vehicleUpgrade.default": "lorc/spanner",
    "vehicle.default": "lorc/tank",
};

type PatternRule = readonly [RegExp, string];

/** The system's rules, in its order; a document takes the first that applies to its type. */
const RULES = {
    itemTypeDefault: {
        weapon: "weapon.default",
        armour: "armour.default",
        talent: "talent.default",
        psychicPower: "psychic.default",
        trait: "trait.default",
        weaponQuality: "weaponQuality.default",
        weaponModification: "weaponModification.default",
        armourModification: "armourModification.default",
        ammunition: "ammunition.default",
        originPath: "originPath.default",
        darkPact: "darkPact.default",
        medal: "medal.default",
        order: "order.default",
        navigatorPower: "navigatorPower.default",
        ritual: "ritual.default",
        criticalInjury: "criticalInjury.default",
        forceField: "forceField.default",
        shipComponent: "shipComponent.default",
        shipWeapon: "shipWeapon.default",
        shipRole: "shipRole.default",
        shipUpgrade: "shipUpgrade.default",
        vehicleTrait: "vehicleTrait.default",
        vehicleUpgrade: "vehicleUpgrade.default",
    } as Readonly<Record<string, string>>,
    actorTypeSuffixDefault: { terracraft: "vehicle.default", aircraft: "vehicle.default" } as Readonly<
        Record<string, string>
    >,
    weaponNaturalName: [
        [/\b(claws?|talons?|scything)\b/iu, "weapon.claw"],
        [/\b(bite|teeth|fangs?|jaws?|mandibles?|maw)\b/iu, "weapon.bite"],
        [/\b(unarmed|fists?|punch)\b/iu, "weapon.unarmed"],
    ] as readonly PatternRule[],
    weaponType: {
        las: "weapon.las",
        bolt: "weapon.bolt",
        plasma: "weapon.plasma",
        melta: "weapon.melta",
        flame: "weapon.flame",
        launcher: "weapon.launcher",
        grenade: "weapon.grenade",
        chain: "weapon.chain",
        power: "weapon.power",
        shock: "weapon.shock",
        force: "weapon.force",
        shield: "weapon.shield",
    } as Readonly<Record<string, string>>,
    weaponExplosive: { thrown: "weapon.grenade", otherwise: "weapon.explosive" },
    weaponName: [
        [/launcher/iu, "weapon.launcher"],
        [/grenades?\b/iu, "weapon.grenade"],
        [/crossbows?\b/iu, "weapon.crossbow"],
        [/\b(bows?|longbows?|shortbows?)\b/iu, "weapon.bow"],
        [/shotguns?\b/iu, "weapon.shotgun"],
        [/shields?\b/iu, "weapon.shield"],
        [/(axes?|hatchet|cleaver)\b/iu, "weapon.axe"],
        [/(knife|knives|daggers?|stiletto|dirk|shiv)\b/iu, "weapon.knife"],
        [/\b(spears?|lance|pike|halberd|glaive|trident|polearm|javelin)\b/iu, "weapon.spear"],
        [/(hammers?|maul)\b/iu, "weapon.hammer"],
        [/maces?\b/iu, "weapon.mace"],
        [/\b(club|cudgel|bludgeon|baton|truncheon)\b/iu, "weapon.club"],
        [/\b(staff|stave)\b/iu, "weapon.staff"],
        [/(whips?|lash)\b/iu, "weapon.whip"],
        [/flails?\b/iu, "weapon.flail"],
        [/(swords?|blades?|sabre|saber|falchion|scimitar|katana|rapier|cutlass)\b/iu, "weapon.melee"],
    ] as readonly PatternRule[],
    weaponClass: {
        pistol: "weapon.pistol",
        basic: "weapon.basic",
        heavy: "weapon.heavy",
        vehicle: "weapon.mounted",
        mounted: "weapon.mounted",
        thrown: "weapon.thrown",
        melee: "weapon.melee",
    } as Readonly<Record<string, string>>,
    armourType: {
        flak: "armour.flak",
        mesh: "armour.mesh",
        carapace: "armour.carapace",
        power: "armour.power",
        void: "armour.void",
        primitive: "armour.primitive",
        xenos: "armour.xenos",
        "force-field": "armour.force-field",
    } as Readonly<Record<string, string>>,
    talentAptitude: [
        [/^(weapon skill|ws)\b/iu, "talent.weapon-skill"],
        [/^(ballistic skill|bs)\b/iu, "talent.ballistic-skill"],
        [/^strength/iu, "talent.strength"],
        [/^toughness/iu, "talent.toughness"],
        [/^agility/iu, "talent.agility"],
        [/^intelligence/iu, "talent.intelligence"],
        [/^perception/iu, "talent.perception"],
        [/^willpower/iu, "talent.willpower"],
        [/^fellowship/iu, "talent.fellowship"],
        [/^offen[cs]e/iu, "talent.offence"],
        [/^defen[cs]e/iu, "talent.defence"],
        [/^finesse/iu, "talent.finesse"],
        [/^leadership/iu, "talent.leadership"],
        [/^knowledge/iu, "talent.knowledge"],
        [/^psyker/iu, "talent.psyker"],
        [/^fieldcraft/iu, "talent.fieldcraft"],
        [/^tech/iu, "talent.tech"],
        [/^social/iu, "talent.social"],
        [/^(khorne|nurgle|slaanesh|tzeentch)/iu, "talent.chaos"],
    ] as readonly PatternRule[],
    talentCategory: {
        combat: "talent.offence",
        offence: "talent.offence",
        psychic: "talent.psyker",
        social: "talent.social",
        knowledge: "talent.knowledge",
        leadership: "talent.leadership",
        tech: "talent.tech",
        mechanicus: "talent.tech",
        perception: "talent.perception",
        faith: "talent.faith",
    } as Readonly<Record<string, string>>,
    // The system's discipline rules, less the patterns naming setting-specific disciplines.
    psychicDiscipline: [
        [/divine|sanctic/iu, "psychic.divine"],
        [/daemonology|malefic/iu, "psychic.daemonology"],
        [/chaos|nurgle|tzeentch|slaanesh|khorne|daemon/iu, "psychic.chaos"],
        [/telepath/iu, "psychic.telepathy"],
        [/pyromanc/iu, "psychic.pyromancy"],
        [/biomanc/iu, "psychic.biomancy"],
        [/divination/iu, "psychic.divination"],
        [/telekine|psychokine/iu, "psychic.telekinesis"],
        [/cryokine/iu, "psychic.cryokinesis"],
        [/sorcery/iu, "psychic.sorcery"],
    ] as readonly PatternRule[],
    shipComponentType: {
        plasmaDrive: "shipComponent.drive",
        voidShields: "shipComponent.shields",
    } as Readonly<Record<string, string>>,
} as const;

const isObject = (v: JsonValue | undefined): v is JsonObject =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** A field authored plainly or in a per-line container: its first concrete value. */
function firstConcrete(value: JsonValue | undefined): JsonValue | undefined {
    if (!isObject(value)) {
        return value;
    }
    for (const [key, v] of Object.entries(value)) {
        if (!key.startsWith("__")) {
            return firstConcrete(v);
        }
    }
    return undefined;
}

function lowerString(value: JsonValue | undefined): string {
    const v = firstConcrete(value);
    return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function firstPatternRole(rules: readonly PatternRule[], text: string): string | null {
    return text === "" ? null : (rules.find(([re]) => re.test(text))?.[1] ?? null);
}

function weaponRole(system: JsonObject, name: string): string {
    const natural = firstPatternRole(RULES.weaponNaturalName, name);
    if (natural !== null) {
        return natural;
    }
    const type = lowerString(system["type"]);
    const cls = lowerString(system["class"]);
    const byType = RULES.weaponType[type];
    if (byType !== undefined) {
        return byType;
    }
    if (type === "explosive") {
        return cls === "thrown" ? RULES.weaponExplosive.thrown : RULES.weaponExplosive.otherwise;
    }
    return firstPatternRole(RULES.weaponName, name) ?? RULES.weaponClass[cls] ?? "weapon.default";
}

function talentRole(system: JsonObject): string {
    const aptitudes = firstConcrete(system["aptitudes"]);
    const first = Array.isArray(aptitudes) ? aptitudes[0] : aptitudes;
    return (
        firstPatternRole(RULES.talentAptitude, typeof first === "string" ? first.trim() : "") ??
        RULES.talentCategory[lowerString(system["category"])] ??
        "talent.default"
    );
}

/** The icon role for a document body (`name`, `type`, `system`), or null where no rule covers its type. */
export function iconRoleFor(doc: JsonObject): string | null {
    const type = typeof doc["type"] === "string" ? doc["type"] : "";
    const name = typeof doc["name"] === "string" ? doc["name"] : "";
    const system = isObject(doc["system"]) ? doc["system"] : {};
    if (type === "") {
        return null;
    }
    for (const [suffix, role] of Object.entries(RULES.actorTypeSuffixDefault)) {
        if (type === suffix || type.endsWith(`-${suffix}`)) {
            return role;
        }
    }
    switch (type) {
        case "weapon":
            return weaponRole(system, name);
        case "armour":
            return RULES.armourType[lowerString(system["type"])] ?? "armour.default";
        case "talent":
            return talentRole(system);
        case "psychicPower":
            return (
                firstPatternRole(RULES.psychicDiscipline, lowerString(system["discipline"])) ??
                "psychic.default"
            );
        case "shipComponent": {
            const kind = firstConcrete(system["componentType"]);
            return (
                (typeof kind === "string" ? RULES.shipComponentType[kind] : undefined) ??
                "shipComponent.default"
            );
        }
        default:
            return RULES.itemTypeDefault[type] ?? null;
    }
}

/** The game-icons hotlink for a document body, or null where no rule covers it. */
export function iconFor(doc: JsonObject): string | null {
    const role = iconRoleFor(doc);
    const path = role === null ? undefined : ICONS[role];
    return path === undefined ? null : `${ICON_CDN}/${path}.svg`;
}

/** A document body given its default icon when it has no image of its own. */
function withIcon(doc: JsonObject): JsonObject {
    if (typeof doc["img"] === "string" && doc["img"] !== "") {
        return doc;
    }
    const icon = iconFor(doc);
    return icon === null ? doc : { ...doc, img: icon };
}

/**
 * Give every Item and Actor without an image of its own — a document, or an
 * item embedded in an actor — its default icon. An image the PDF supplies
 * (placed by asset) always wins.
 */
export function applyDefaultIcons(entities: readonly Entity[]): void {
    for (const e of entities) {
        if (e.documentType !== "Item" && e.documentType !== "Actor") {
            continue;
        }
        const items = e.fields["items"];
        if (Array.isArray(items)) {
            e.fields["items"] = items.map((item) => (isObject(item) ? withIcon(item) : item));
        }
        if (e.images["img"] === undefined) {
            const icon = withIcon(e.fields as JsonObject)["img"];
            if (typeof icon === "string") {
                e.fields["img"] = icon;
            }
        }
    }
}
