// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured diagnostic logger. Lines go to a sink: stderr by default (so
 * stdout stays clean for machine-consumable output), or the page's log panel
 * in the browser. The output corpus is written as files, never printed, so
 * logging cannot contaminate determinism.
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

/** Where formatted log lines go. The default is the diagnostic (stderr) channel. */
export type LogSink = (level: LogLevel, line: string) => void;

const stderrSink: LogSink = (_level, line) => {
    console.error(line);
};

export function createLogger(minLevel: LogLevel = "info", prefix = "", sink: LogSink = stderrSink): Logger {
    const emit = (level: LogLevel, message: string): void => {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
            return;
        }
        const tag = prefix ? `[${prefix}] ` : "";
        sink(level, `${level}: ${tag}${message}`);
    };
    return {
        debug: (m): void => emit("debug", m),
        info: (m): void => emit("info", m),
        warn: (m): void => emit("warn", m),
        error: (m): void => emit("error", m),
        child: (childPrefix): Logger =>
            createLogger(minLevel, prefix ? `${prefix}:${childPrefix}` : childPrefix, sink),
    };
}
