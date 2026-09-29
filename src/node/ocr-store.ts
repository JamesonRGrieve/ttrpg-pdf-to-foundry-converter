// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OcrPageStore } from "../ocr/recognize.ts";
import type { OcrWord } from "../ocr/types.ts";

/** OCR page store on disk: `<cacheDir>/ocr/<key>/p<NNNNN>.json`. */
export class FileOcrPageStore implements OcrPageStore {
    constructor(private readonly cacheDir: string) {}

    #path(key: string, pageIndex: number): string {
        return join(this.cacheDir, "ocr", key, `p${String(pageIndex).padStart(5, "0")}.json`);
    }

    async read(key: string, pageIndex: number): Promise<OcrWord[] | null> {
        const path = this.#path(key, pageIndex);
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as OcrWord[]) : null;
    }

    async write(key: string, pageIndex: number, words: OcrWord[]): Promise<void> {
        const path = this.#path(key, pageIndex);
        mkdirSync(join(this.cacheDir, "ocr", key), { recursive: true });
        // Write-then-rename so an interrupted run never leaves a torn entry.
        writeFileSync(`${path}.tmp`, JSON.stringify(words));
        renameSync(`${path}.tmp`, path);
    }
}
