// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { compilePattern } from "../dsl/regex.ts";
import { validateTransforms } from "../dsl/transforms.ts";
import type { BlockSpec, Profile } from "../types/profile.ts";
import { SUPPORTED_SCHEMA_MAJORS } from "../version.ts";

/**
 * Profile loading and validation (spec §8.1). Profiles are data: parsed from
 * YAML/JSON, structurally validated against the published JSON Schema, then
 * semantically checked (selector references resolve, patterns compile under
 * RE2, transforms are in the closed vocabulary). Any failure is a loud error
 * with a useful message (gate G7). No `eval`, no code, no I/O from the profile.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, "..", "..", "docs", "profile.schema.json");

let cachedValidator: ValidateFunction | null = null;

function validator(): ValidateFunction {
    if (cachedValidator !== null) {
        return cachedValidator;
    }
    // ajv/ajv-formats are CJS with an `export default` in their `.d.ts`; under
    // NodeNext the default import binds to the namespace, so the constructor and
    // plugin live on `.default` (present at runtime on both).
    const ajv = new AjvModule.default({ allErrors: true, strict: false });
    addFormatsModule.default(ajv);
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const compiled = ajv.compile(schema);
    cachedValidator = compiled;
    return compiled;
}

function semanticCheck(profile: Profile, source: string): void {
    const selectorNames = new Set(Object.keys(profile.selectors));
    const requireSelector = (name: string, ctx: string): void => {
        if (!selectorNames.has(name)) {
            throw new Error(`${source}: ${ctx} references undefined selector ${JSON.stringify(name)}`);
        }
    };

    const blockIds = new Set<string>();
    for (const block of profile.blocks) {
        if (blockIds.has(block.id)) {
            throw new Error(`${source}: duplicate block id ${JSON.stringify(block.id)}`);
        }
        blockIds.add(block.id);
        requireSelector(block.starts_at, `block ${block.id} starts_at`);
        requireSelector(
            "next" in block.ends_at ? block.ends_at.next : block.ends_at.selector,
            `block ${block.id} ends_at`,
        );
        checkBlockFields(block, requireSelector);
    }

    for (const rule of profile.emit) {
        if (!blockIds.has(rule.block)) {
            throw new Error(`${source}: emit rule references undefined block ${JSON.stringify(rule.block)}`);
        }
        if (!("name" in rule.map)) {
            throw new Error(`${source}: emit rule for block ${rule.block} must map a "name" field`);
        }
    }
}

function checkBlockFields(block: BlockSpec, requireSelector: (name: string, ctx: string) => void): void {
    for (const field of block.fields) {
        requireSelector(field.from, `block ${block.id} field ${field.name} from`);
        if (field.match !== undefined) {
            compilePattern(field.match); // throws on non-RE2 / invalid pattern
        }
        if (field.transform !== undefined) {
            validateTransforms(field.transform);
        }
    }
}

/** Parse + validate a single profile from disk. Throws on any error. */
export function loadProfile(path: string): Profile {
    const source = path;
    const text = readFileSync(path, "utf8");
    const parsed: unknown = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    const validate = validator();
    if (!validate(parsed)) {
        const messages = (validate.errors ?? [])
            .map((e) => `  - ${e.instancePath || "/"} ${e.message ?? "invalid"}`)
            .join("\n");
        throw new Error(`${source}: profile failed schema validation:\n${messages}`);
    }
    const profile = parsed as Profile;
    const major = Math.trunc(profile.schema_version);
    if (!SUPPORTED_SCHEMA_MAJORS.includes(major)) {
        throw new Error(
            `${source}: unsupported schema_version ${profile.schema_version}; engine supports majors ${SUPPORTED_SCHEMA_MAJORS.join(", ")}`,
        );
    }
    semanticCheck(profile, source);
    return profile;
}

/** Load every `*.yml`/`*.yaml`/`*.json` profile under a directory (non-recursive). */
export function loadProfilesDir(dir: string): Profile[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const profiles: Profile[] = [];
    for (const entry of entries.sort()) {
        const full = join(dir, entry);
        if (!statSync(full).isFile()) {
            continue;
        }
        if (/\.(ya?ml|json)$/.test(entry) && !entry.endsWith(".schema.json")) {
            profiles.push(loadProfile(full));
        }
    }
    return profiles;
}
