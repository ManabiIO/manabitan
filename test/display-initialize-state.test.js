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

import {expect, test, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';

test('initializeState exposes initial render completion without delaying frame readiness', async () => {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    /** @type {() => void} */
    let resolveState = () => {};
    const statePromise = new Promise((resolve) => {
        resolveState = resolve;
    });
    const signal = vi.fn();

    Reflect.set(display, '_frameEndpoint', {signal});
    Reflect.set(display, '_onStateChanged', () => statePromise);

    const completion = display.initializeState();
    let settled = false;
    void completion.then(() => {
        settled = true;
    });

    expect(signal).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveState();
    await completion;

    expect(settled).toBe(true);
    expect(signal).toHaveBeenCalledTimes(1);
});
