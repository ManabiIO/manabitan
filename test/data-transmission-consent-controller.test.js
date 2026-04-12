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

describe('DataTransmissionConsentController', () => {
    test('accept click logs consent-write failures instead of rejecting', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <button id="accept-data-transmission"></button>
            <button id="decline-data-transmission"></button>
        `;

        const {DataTransmissionConsentController} = await import('../ext/js/pages/settings/data-transmission-consent-controller.js');
        const settingsController = {
            modifySettings: vi.fn().mockRejectedValue(new Error('save failed')),
            getOptionsContext: vi.fn(() => ({})),
        };
        const modalController = {
            getModal: vi.fn(() => ({node: window.document.createElement('div')})),
        };
        const controller = new DataTransmissionConsentController(
            /** @type {any} */ (settingsController),
            /** @type {any} */ (modalController),
        );
        await controller.prepare();

        const button = /** @type {HTMLButtonElement} */ (window.document.querySelector('#accept-data-transmission'));
        button.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true}));
        await new Promise((resolve) => { window.setTimeout(resolve, 0); });

        expect(settingsController.modifySettings).toHaveBeenCalledOnce();
        expect(logError).toHaveBeenCalled();
    });
});
