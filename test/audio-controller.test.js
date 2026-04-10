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
import {AudioController} from '../ext/js/pages/settings/audio-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @returns {AudioController}
 */
function createControllerForInternalTests() {
    return /** @type {AudioController} */ (Object.create(AudioController.prototype));
}

describe('AudioController consent refresh', () => {
    test('clears the consent token when a refresh fails', async ({window}) => {
        window.document.documentElement.dataset.browser = 'firefox';
        const controller = createControllerForInternalTests();
        const getOptionsFull = vi.fn().mockRejectedValue(new Error('lookup failed'));
        const initialToken = {};
        Reflect.set(controller, '_settingsController', {
            getOptionsFull,
        });
        Reflect.set(controller, '_consentStateToken', initialToken);
        Reflect.set(controller, '_setDataTransmissionConsentState', vi.fn());

        const refreshDataTransmissionConsentState = /** @type {(this: AudioController) => Promise<void>} */ (
            Reflect.get(AudioController.prototype, '_refreshDataTransmissionConsentState')
        );

        await refreshDataTransmissionConsentState.call(controller);

        expect(getOptionsFull).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_consentStateToken')).not.toBe(initialToken);
    });
});
