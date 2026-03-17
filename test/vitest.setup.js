/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {webcrypto} from 'node:crypto';

if (typeof globalThis.crypto === 'undefined') {
    Reflect.set(globalThis, 'crypto', webcrypto);
}

const benchmarkConsolePatchedFlag = Symbol.for('manabitan.benchmarkConsolePatched');
const benchmarkLifecycleEvents = new Set(['bench', 'bench:watch']);

/**
 * @returns {boolean}
 */
function isBenchmarkRun() {
    const lifecycleEvent = process.env.npm_lifecycle_event ?? '';
    return benchmarkLifecycleEvents.has(lifecycleEvent) || process.argv.includes('bench');
}

/**
 * @param {unknown[]} args
 * @returns {boolean}
 */
function shouldSuppressBenchmarkConsoleMessage(args) {
    const first = args[0];
    if (typeof first !== 'string') {
        return false;
    }
    return (
        first.startsWith('SQL TRACE #') ||
        first.startsWith('Ignoring inability to install OPFS sqlite3_vfs:')
    );
}

if (isBenchmarkRun() && Reflect.get(globalThis, benchmarkConsolePatchedFlag) !== true) {
    for (const methodName of /** @type {const} */ (['log', 'warn', 'error'])) {
        const original = console[methodName].bind(console);
        console[methodName] = (...args) => {
            if (shouldSuppressBenchmarkConsoleMessage(args)) {
                return;
            }
            original(...args);
        };
    }
    Reflect.set(globalThis, benchmarkConsolePatchedFlag, true);
}
