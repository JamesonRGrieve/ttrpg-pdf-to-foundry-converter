// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The command that runs the shipped CLI from source: the current Node with
 * tsx's loader, so it starts the same way on every platform (a package
 * manager's `.bin` shim is a shell script Windows cannot spawn directly).
 */
export function cliCommand(args) {
    return [process.execPath, ["--import", "tsx", "src/node/cli.ts", ...args]];
}
