/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
import {vi} from 'vitest';

/**
 *
 */
export function setupStubs() {
    vi.stubGlobal('manabitanRequireOpfs', false);
    vi.stubGlobal('self', {
        constructor: {
            name: 'Window',
        },
    });
    const sqlite3ApiConfig = /** @type {{warn?: ((...args: unknown[]) => void)}|undefined} */ (Reflect.get(globalThis, 'sqlite3ApiConfig'));
    /**
     * @param {...unknown} args
     * @returns {void}
     */
    const warn = (...args) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Ignoring inability to install OPFS sqlite3_vfs:')) {
            return;
        }
        if (typeof sqlite3ApiConfig?.warn === 'function') {
            sqlite3ApiConfig.warn(...args);
            return;
        }
        console.warn(...args);
    };
    Reflect.set(globalThis, 'sqlite3ApiConfig', {
        ...sqlite3ApiConfig,
        warn,
    });


    function Worker() {
        return {
            addEventListener: () => {},
            terminate: () => {},
        };
    }
    vi.stubGlobal('Worker', Worker);
}
