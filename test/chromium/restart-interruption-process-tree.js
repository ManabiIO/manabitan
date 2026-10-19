/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * @param {string} output
 * @returns {{pid: number, ppid: number, startedAt: string, command: string}[]}
 */
export function parseProcessRows(output) {
    return output.split('\n').map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/u.exec(line);
        return match ? {pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3], command: match[4]} : null;
    }).filter((row) => row !== null);
}

/**
 * Select the unique browser process owning the dedicated profile and every
 * descendant, including helpers that omit Chromium's profile argument.
 * @param {{pid: number, ppid: number, startedAt: string, command: string}[]} rows
 * @param {string} profilePath
 * @param {string} expectedExecutable
 * @param {boolean} [allowMacCodeSignClone]
 * @returns {{pid: number, ppid: number, startedAt: string, command: string}[]}
 */
export function selectOwnedProcessTree(rows, profilePath, expectedExecutable, allowMacCodeSignClone = false) {
    const profileMarker = `--user-data-dir=${profilePath}`;
    const roots = rows.filter(({command}) => {
        const markerIndex = command.indexOf(profileMarker);
        const markerEnd = markerIndex + profileMarker.length;
        const exactProfileArgument = markerIndex >= 0 && (markerEnd === command.length || command[markerEnd] === ' ');
        const exactExecutable = (command.startsWith(`${expectedExecutable} `) && !command.startsWith(`${expectedExecutable} (`)) ||
        (allowMacCodeSignClone && command.startsWith(`${expectedExecutable} (`) && command.includes(') --user-data-dir='));
        return exactProfileArgument && exactExecutable && !/--type=|crashpad_handler/u.test(command);
    });
    if (roots.length !== 1) {
        throw new Error(`Expected one Chromium root for the owned profile, found ${roots.length}`);
    }
    const [root] = roots;
    const selected = new Set([root.pid]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const {pid, ppid} of rows) {
            if (selected.has(ppid) && !selected.has(pid)) {
                selected.add(pid);
                changed = true;
            }
        }
    }
    return rows.filter(({pid}) => selected.has(pid));
}
