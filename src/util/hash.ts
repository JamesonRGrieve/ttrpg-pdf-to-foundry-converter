// SPDX-License-Identifier: AGPL-3.0-or-later
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Content hashing and base62 encoding — the backbone of the engine's stable,
 * content-addressed identifiers (asset ids §6.1, document `_id`s §9.1, cache
 * keys §2.2). All of these must be byte-stable across platforms AND runtimes
 * (Node CLI and in-browser), so hashing is the pinned pure-JS SHA-256 and
 * base62 uses a locale-free alphabet.
 */

/** Fixed base62 alphabet. Ordering is part of the wire format — never reorder. */
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
    return sha256(typeof data === "string" ? utf8ToBytes(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
    return bytesToHex(sha256Bytes(data));
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
        out = BASE62_ALPHABET.charAt(rem) + out;
        value /= base;
    }

    return BASE62_ALPHABET.charAt(0).repeat(leadingZeros) + out;
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
    return encoded.slice(0, 16).padStart(16, BASE62_ALPHABET.charAt(0));
}
