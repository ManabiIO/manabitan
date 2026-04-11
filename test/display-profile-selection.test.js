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

import {describe, expect, test, vi} from 'vitest';
import {DisplayProfileSelection} from '../ext/js/display/display-profile-selection.js';

describe('DisplayProfileSelection options refresh handling', () => {
    test('options updates log refresh failures instead of escaping', async () => {
        const selection = /** @type {DisplayProfileSelection} */ (/** @type {unknown} */ (Object.create(DisplayProfileSelection.prototype)));
        Reflect.set(selection, '_source', 'local');
        Reflect.set(selection, '_profileListNeedsUpdate', false);
        Reflect.set(selection, '_profilePanel', {isVisible: vi.fn().mockReturnValue(true)});
        Reflect.set(selection, '_updateProfileList', vi.fn().mockRejectedValue(new Error('refresh failed')));
        Reflect.set(selection, '_updateCurrentProfileName', vi.fn());
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const onOptionsUpdatedEvent = /** @type {(details: {source: string}) => void} */ (Reflect.get(DisplayProfileSelection.prototype, '_onOptionsUpdatedEvent'));
        onOptionsUpdatedEvent.call(selection, {source: 'external'});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(Reflect.get(selection, '_profileListNeedsUpdate')).toBe(true);
        expect(Reflect.get(selection, '_updateProfileList')).toHaveBeenCalledTimes(1);
        expect(Reflect.get(selection, '_updateCurrentProfileName')).not.toHaveBeenCalled();
        expect(logErrorSpy).toHaveBeenCalled();
    });
});
