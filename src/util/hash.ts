// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

/**
 * Content hashing and base62 encoding — the backbone of the engine's stable,
 * content-addressed identifiers (asset ids §6.1, document `_id`s §9.1, cache
 * keys §2.2). All of these must be byte-stable across platforms, so we depend
 * only on the pinned `node:crypto` SHA-256 and a locale-free base62 alphabet.
 */

/** Fixed base62 alphabet. Ordering is part of the wire format — never reorder. */
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function sha256Hex(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
    return new Uint8Array(createHash("sha256").update(data).digest());
}

/**
 * Encode bytes as a base62 string via big-endian base conversion. Leading
 * zero bytes are preserved as leading `0` characters so the mapping stays
 * injective (two distinct digests never collide through lost leading zeros).
 */
export function base62Encode(bytes: Uint8Array): string {
    let leadingZeros = 0;
    for (const b of bytes) {
        if (b === 0) {
            leadingZeros += 1;
        } else {
            break;
        }
    }

    let value = 0n;
    for (const b of bytes) {
        value = value * 256n + BigInt(b);
    }

    let out = "";
    const base = 62n;
    while (value > 0n) {
        const rem = Number(value % base);
        out = BASE62_ALPHABET[rem] + out;
        value /= base;
    }

    return BASE62_ALPHABET[0]!.repeat(leadingZeros) + out;
}

/**
 * A 16-character base62 identifier derived from a SHA-256 digest. Used for
 * asset ids and, with a distinct hash preimage, Foundry document `_id`s
 * (which are additionally constrained to `/^[a-zA-Z0-9]{16}$/`, a subset of
 * the base62 alphabet).
 */
export function id16(preimage: Uint8Array | string): string {
    const digest = sha256Bytes(preimage);
    const encoded = base62Encode(digest);
    return encoded.slice(0, 16).padStart(16, BASE62_ALPHABET[0]!);
}
