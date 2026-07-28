// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured stderr logger. Per spec §5.5, clock reads are permitted only for
 * stderr logging and never on the output path; per the workspace rules there
 * are no ad-hoc stdout prints — diagnostics go to stderr so stdout stays clean
 * for machine-consumable output. The output corpus is written to files, not
 * printed, so logging never contaminates determinism.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    child(prefix: string): Logger;
}

export function createLogger(minLevel: LogLevel = "info", prefix = ""): Logger {
    const emit = (level: LogLevel, message: string): void => {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
            return;
        }
        const tag = prefix ? `[${prefix}] ` : "";
        process.stderr.write(`${level}: ${tag}${message}\n`);
    };
    return {
        debug: (m): void => emit("debug", m),
        info: (m): void => emit("info", m),
        warn: (m): void => emit("warn", m),
        error: (m): void => emit("error", m),
        child: (childPrefix): Logger =>
            createLogger(minLevel, prefix ? `${prefix}:${childPrefix}` : childPrefix),
    };
}
