// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from "@playwright/test";

/** How long Foundry may take to be ready after a load or reload. */
export const READY_TIMEOUT_MS = 120_000;

/** The part of Foundry's client globals these helpers read. */
interface ReadyGame {
    game: { ready?: boolean };
}

/** Join the world as its Gamemaster and wait until Foundry is ready. */
export async function joinAsGamemaster(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        await page.goto("/join");
        if ((await page.locator('input[name="username"]').count()) > 0) {
            break;
        }
        await page.waitForTimeout(2_000);
    }
    await page.fill('input[name="username"]', "Gamemaster");
    await page.click('button[name="join"]');
    await page.waitForURL(/\/game/u);
    await page.waitForFunction(
        () => (globalThis as unknown as Partial<ReadyGame>).game?.ready === true,
        undefined,
        {
            timeout: READY_TIMEOUT_MS,
        },
    );
}

/**
 * Stop core's welcome tour: a fresh world starts it a moment after ready, and
 * its overlay swallows clicks. Its start is neutered, an active one exited
 * and its overlay removed (as the wh40k-rpg system's e2e suite does).
 */
export async function stopWelcomeTour(page: Page): Promise<void> {
    await page.evaluate(() => {
        const g = globalThis as unknown as {
            game?: { tours?: { get?: (id: string) => { start?: () => Promise<void> } | undefined } };
            foundry?: { nue?: { Tour?: { activeTour?: { exit?: () => void } | null } } };
            document: { querySelectorAll(selector: string): Iterable<{ remove(): void }> };
        };
        const welcome = g.game?.tours?.get?.("core.welcome");
        if (welcome !== undefined) {
            welcome.start = async (): Promise<void> => {
                await Promise.resolve();
            };
        }
        g.foundry?.nue?.Tour?.activeTour?.exit?.();
        for (const n of g.document.querySelectorAll(".tour-overlay, .tour-fadeout, .tour-center-step")) {
            n.remove();
        }
    });
}
