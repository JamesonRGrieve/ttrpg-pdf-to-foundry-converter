// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ImagePlacement } from "../types/ir.ts";

/**
 * Minimal PDF content-stream interpreter for image placement (spec §6.3).
 * Tracks the graphics-state CTM stack (`q`/`Q`/`cm`) and, on each `/Name Do`
 * that resolves to an image XObject, records the page-space bounding box of the
 * unit image square under the current CTM. Only the geometry operators are
 * interpreted; everything else is ignored. This is intentionally best-effort —
 * unresolved placement means "emit no image and warn" downstream, never a guess.
 */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Concatenation: apply `a` then `b` (row-vector convention, p·a·b). */
function mul(a: Matrix, b: Matrix): Matrix {
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Tokenize the ASCII operators/operands we care about from a content stream. */
function tokenize(content: Uint8Array): string[] {
    const text = Buffer.from(content).toString("latin1");
    const re = /\/[^\s/<>[\]()]+|-?\d*\.?\d+|[A-Za-z'"*]+/g;
    return [...text.matchAll(re)].map((m) => m[0]);
}

export function scanPlacements(
    content: Uint8Array,
    xobjectRefs: ReadonlyMap<string, string>,
    pageIndex: number,
): ImagePlacement[] {
    const out: ImagePlacement[] = [];
    const stack: Matrix[] = [];
    let ctm: Matrix = IDENTITY;
    const operands: number[] = [];
    let lastName: string | null = null;

    for (const token of tokenize(content)) {
        if (token.startsWith("/")) {
            lastName = token.slice(1);
            continue;
        }
        const num = Number(token);
        if (!Number.isNaN(num) && /^-?\d*\.?\d+$/.test(token)) {
            operands.push(num);
            continue;
        }
        switch (token) {
            case "q":
                stack.push(ctm);
                break;
            case "Q":
                ctm = stack.pop() ?? IDENTITY;
                break;
            case "cm":
                if (operands.length >= 6) {
                    const cm = operands.slice(-6) as Matrix;
                    ctm = mul(cm, ctm);
                }
                break;
            case "Do": {
                if (lastName !== null) {
                    const objectId = xobjectRefs.get(lastName);
                    if (objectId !== undefined) {
                        const corners = [
                            apply(ctm, 0, 0),
                            apply(ctm, 1, 0),
                            apply(ctm, 0, 1),
                            apply(ctm, 1, 1),
                        ];
                        const xs = corners.map((c) => c[0]);
                        const ys = corners.map((c) => c[1]);
                        out.push({
                            objectId,
                            pageIndex,
                            bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
                        });
                    }
                }
                break;
            }
            default:
                break;
        }
        operands.length = 0;
    }
    return out;
}
