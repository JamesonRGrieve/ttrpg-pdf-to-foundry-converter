// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IR, IRTextRun } from "../types/ir.ts";

/** Baseline distance, in points, within which two runs share a line. */
const SAME_LINE = 3;
/** Line heights within which a misread line makes a heading's lines one stack. */
const STACKED_LINES = 1.5;
/** Fewest letters a set line needs before it is judged a copy of another. */
const MIN_COPY_LETTERS = 4;

const letters = (text: string): string => text.toLowerCase().replace(/[^\p{L}]+/gu, "");
const spelt = (runs: readonly IRTextRun[]): string =>
    letters(
        [...runs]
            .sort((a, b) => a.x - b.x)
            .map((r) => r.text)
            .join(""),
    );

/**
 * A heading may be set twice over itself in two faces: a decorative one in
 * whole words over a plain one whose capitals and small capitals split it
 * into fragments. Runs of two faces overlapping on one line form a group;
 * when both faces spell the same letters, the face set in fewer runs is that
 * group's overlaid copy. The face most groups find overlaid is the
 * document's overlay, and its copies go: each such line then reads once.
 * Two faces set in as many runs (a shadow) both stay.
 */
export function withoutOverlaidCopies(ir: IR): IR {
    const byPage = new Map<number, IRTextRun[]>();
    for (const r of ir.runs) {
        const list = byPage.get(r.pageIndex) ?? [];
        list.push(r);
        byPage.set(r.pageIndex, list);
    }
    // Groups of two faces spelling the same letters, each with the face set
    // in fewer runs (the overlaid copy, by that group alone).
    const copies: { faces: Map<string, IRTextRun[]>; fewer: string }[] = [];
    /** Groups whose two faces spell differently. */
    const garbled: IRTextRun[][] = [];
    for (const runs of byPage.values()) {
        const overlaps = (a: IRTextRun, b: IRTextRun): boolean =>
            a.font !== b.font &&
            Math.abs(a.y - b.y) <= SAME_LINE &&
            a.x < b.x + b.width &&
            b.x < a.x + a.width;
        const seen = new Set<IRTextRun>();
        for (const start of runs) {
            if (seen.has(start) || !runs.some((r) => overlaps(start, r))) {
                continue;
            }
            // The group: every run reached through overlaps of another face.
            const group: IRTextRun[] = [start];
            seen.add(start);
            for (let k = 0; k < group.length; k++) {
                const at = group[k];
                for (const r of runs) {
                    if (at !== undefined && !seen.has(r) && overlaps(at, r)) {
                        seen.add(r);
                        group.push(r);
                    }
                }
            }
            const faces = new Map<string, IRTextRun[]>();
            for (const r of group) {
                faces.set(r.font, [...(faces.get(r.font) ?? []), r]);
            }
            const [a, b] = [...faces.entries()];
            if (faces.size !== 2 || a === undefined || b === undefined) {
                continue;
            }
            const own = spelt(a[1]);
            if (own !== spelt(b[1])) {
                garbled.push(group);
            } else if (own.length >= MIN_COPY_LETTERS && a[1].length !== b[1].length) {
                copies.push({ faces, fewer: a[1].length < b[1].length ? a[0] : b[0] });
            }
        }
    }
    // A heading set over several lines, where one line's two faces spell
    // differently (a misread), is left as it is: dropping one face on its
    // other lines would join that face's misread line to them.
    const box = (g: readonly IRTextRun[]) => ({
        page: g[0]?.pageIndex,
        lo: Math.min(...g.map((r) => r.x)),
        hi: Math.max(...g.map((r) => r.x + r.width)),
        y: Math.min(...g.map((r) => r.y)),
        top: Math.max(...g.map((r) => r.y)),
        size: Math.max(...g.map((r) => r.size)),
    });
    const misread = garbled.map(box);
    const stacked = (g: readonly IRTextRun[]): boolean => {
        const own = box(g);
        return misread.some(
            (m) =>
                m.page === own.page &&
                // The misread line itself, or a line above or below it in the same span.
                ((m.y <= own.top + SAME_LINE && own.y <= m.top + SAME_LINE) ||
                    (m.lo < own.hi && own.lo < m.hi)) &&
                Math.min(Math.abs(m.y - own.top), Math.abs(own.y - m.top)) <=
                    STACKED_LINES * Math.max(m.size, own.size),
        );
    };
    for (let k = copies.length - 1; k >= 0; k--) {
        const c = copies[k];
        if (c !== undefined && stacked([...c.faces.values()].flat())) {
            copies.splice(k, 1);
        }
    }
    // The overlaid face is the document's: the one most groups set in fewer
    // runs. Only it goes, in every group, so each heading keeps one face.
    const tally = new Map<string, number>();
    for (const c of copies) {
        tally.set(c.fewer, (tally.get(c.fewer) ?? 0) + 1);
    }
    const overlay = [...tally.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
    const drop = new Set<IRTextRun>(
        copies.flatMap((c) => (overlay === undefined ? [] : (c.faces.get(overlay) ?? []))),
    );
    return drop.size === 0 ? ir : { ...ir, runs: ir.runs.filter((r) => !drop.has(r)) };
}
