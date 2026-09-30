// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate a permissions-only encrypted PDF fixture: the field manual saved
// with a Standard-security-handler /Encrypt entry, an owner password and an
// EMPTY user password — so it opens without a password in any viewer, as a
// publisher's copy-protected but freely readable PDF does. The engine must
// read it (not refuse it as encrypted).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";

const rendered = resolve(dirname(fileURLToPath(import.meta.url)), "..", "rendered");
/**
 * Owner password, an empty user password, and permissions denying copy and
 * edit. RC4 (not AES) so no random initialisation vectors enter the bytes.
 */
const SAVE_OPTIONS = "encrypt=rc4-128,owner-password=fixture-owner,user-password=,permissions=-3904";

const bytes = readFileSync(resolve(rendered, "field-manual.pdf"));
const pdf = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
if (pdf === null) {
    throw new Error("field-manual.pdf did not open as a PDF");
}
// A fixed file identifier: the encryption key derives from its first element,
// so a generated one would make every run's bytes differ.
const FIXED_ID = new Uint8Array(16).fill(0x5a);
const idArray = pdf.newArray();
idArray.push(pdf.newByteString(FIXED_ID));
idArray.push(pdf.newByteString(FIXED_ID));
pdf.getTrailer().put("ID", idArray);
const saved = Buffer.from(pdf.saveToBuffer(SAVE_OPTIONS).asUint8Array());

// The writer renews the identifier's second element (the revision id, which
// no key derives from) on every save; pin it to the first, same length.
const text = saved.toString("latin1");
const renewed = /\/ID\s*\[\(Z{16}\)<([0-9A-F]{32})>\]/u.exec(text);
if (renewed === null) {
    throw new Error("restricted.pdf: file identifier not found");
}
const fixedHex = Buffer.from(FIXED_ID).toString("hex").toUpperCase();
const pinned = Buffer.from(text.replace(renewed[0], renewed[0].replace(renewed[1], fixedHex)), "latin1");
const out = resolve(rendered, "restricted.pdf");
writeFileSync(out, pinned);
process.stdout.write(`wrote ${out} (${pinned.length} bytes)\n`);
