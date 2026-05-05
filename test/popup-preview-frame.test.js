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

import {describe, expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';

const logError = vi.fn();

vi.mock('../ext/js/core/log.js', () => ({
    log: {
        error: logError,
    },
}));

const test = createDomTest();

describe('PopupPreviewFrame', () => {
    test('setCustomCss logs popup CSS update failures instead of rejecting', async () => {
        vi.resetModules();
        vi.clearAllMocks();

        const {PopupPreviewFrame} = await import('../ext/js/pages/settings/popup-preview-frame.js');
        const frame = /** @type {import('../ext/js/pages/settings/popup-preview-frame.js').PopupPreviewFrame} */ (Object.create(PopupPreviewFrame.prototype));
        Reflect.set(frame, '_frontend', {
            popup: {
                setCustomCss: vi.fn().mockRejectedValue(new Error('css failed')),
            },
        });

        frame._setCustomCss({css: '.test {}'});
        await Promise.resolve();
        await Promise.resolve();

        expect(logError).toHaveBeenCalled();
    });

    test('setCustomCss ignores disconnected popup frame races', async () => {
        vi.resetModules();
        vi.clearAllMocks();

        const {PopupPreviewFrame} = await import('../ext/js/pages/settings/popup-preview-frame.js');
        const frame = /** @type {import('../ext/js/pages/settings/popup-preview-frame.js').PopupPreviewFrame} */ (Object.create(PopupPreviewFrame.prototype));
        Reflect.set(frame, '_frontend', {
            popup: {
                setCustomCss: vi.fn().mockRejectedValue(new Error('Failed to invoke action displaySetCustomCss: frame state invalid')),
            },
        });

        frame._setCustomCss({css: '.test {}'});
        await Promise.resolve();
        await Promise.resolve();

        expect(logError).not.toHaveBeenCalled();
    });
});
