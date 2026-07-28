// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate a minimal *encrypted* PDF fixture (spec §11 / gate G6). The document
// carries a Standard-security-handler /Encrypt entry in its trailer; the engine
// must REFUSE it (exit 3) without attempting decryption (C4). No real payload is
// encrypted — the /Encrypt marker alone is what a conformant reader keys on.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    // Standard security handler, V1/R2 (40-bit RC4). O/U are the required 32-byte
    // strings; P is the permissions flag. Presence of /Encrypt => refuse.
    "<< /Filter /Standard /V 1 /R 2 /O <" +
        "28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A" +
        "> /U <" +
        "A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00" +
        "> /P -44 >>",
];

let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
const offsets = [];
objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
});

const xrefStart = body.length;
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
}
const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const pdf = Buffer.from(body + xref + trailer, "latin1");
const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "rendered", "encrypted.pdf");
writeFileSync(out, pdf);
process.stdout.write(`wrote ${out} (${pdf.length} bytes)\n`);
