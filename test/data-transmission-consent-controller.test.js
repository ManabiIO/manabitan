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
    test('consent modal stays open when the backend reports a per-target error', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <button id="accept-data-transmission"></button>
            <button id="decline-data-transmission"></button>
            <p id="data-transmission-consent-save-error" hidden></p>
        `;
        const {DataTransmissionConsentController} = await import('../ext/js/pages/settings/data-transmission-consent-controller.js');
        const modal = {setVisible: vi.fn()};
        const settingsController = {
            modifySettings: vi.fn().mockResolvedValue([
                {result: null}, {result: null},
                {error: {name: 'Error', message: 'audio update denied', stack: ''}},
            ]),
            getOptionsContext: vi.fn(() => ({})),
        };
        const controller = new DataTransmissionConsentController(
            /** @type {any} */ (settingsController),
            /** @type {any} */ ({getModal: () => modal}),
        );
        await controller.prepare();

        await expect(controller._onAccept()).rejects.toThrow('audio update denied');
        expect(modal.setVisible).not.toHaveBeenCalled();
        const errorNode = /** @type {HTMLElement} */ (window.document.querySelector('#data-transmission-consent-save-error'));
        expect(errorNode.hidden).toBe(false);
        expect(errorNode.textContent).toContain('Could not save');
        expect(/** @type {HTMLButtonElement} */ (window.document.querySelector('#accept-data-transmission')).disabled).toBe(false);
        expect(/** @type {HTMLButtonElement} */ (window.document.querySelector('#decline-data-transmission')).disabled).toBe(false);
    });

    test('consent options remain locked until persistence completes and close only on success', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <button id="accept-data-transmission"></button>
            <button id="decline-data-transmission"></button>
            <p id="data-transmission-consent-save-error" hidden></p>
        `;
        const {DataTransmissionConsentController} = await import('../ext/js/pages/settings/data-transmission-consent-controller.js');
        const pending = /** @type {PromiseWithResolvers<Array<{result: null}>>} */ (Promise.withResolvers());
        const settingsController = {
            modifySettings: vi.fn(() => pending.promise),
            getOptionsContext: vi.fn(() => ({})),
        };
        const modal = {setVisible: vi.fn()};
        const controller = new DataTransmissionConsentController(
            /** @type {any} */ (settingsController),
            /** @type {any} */ ({getModal: () => modal}),
        );
        await controller.prepare();

        const save = controller._onDecline();
        const accept = /** @type {HTMLButtonElement} */ (window.document.querySelector('#accept-data-transmission'));
        const decline = /** @type {HTMLButtonElement} */ (window.document.querySelector('#decline-data-transmission'));
        expect(accept.disabled).toBe(true);
        expect(decline.disabled).toBe(true);
        expect(modal.setVisible).not.toHaveBeenCalled();
        await controller._onAccept();
        expect(settingsController.modifySettings).toHaveBeenCalledOnce();

        pending.resolve([{result: null}, {result: null}, {result: null}]);
        await save;
        expect(modal.setVisible).toHaveBeenCalledOnce();
        expect(modal.setVisible).toHaveBeenCalledWith(false);
        expect(accept.disabled).toBe(false);
        expect(decline.disabled).toBe(false);
        expect(settingsController.modifySettings.mock.calls[0][0][0]).toMatchObject({
            path: 'global.dataTransmissionConsentState', value: 'declined',
        });
    });

    test('incomplete consent update cannot dismiss the modal', async ({window}) => {
        vi.resetModules();
        vi.clearAllMocks();
        window.document.body.innerHTML = `
            <button id="accept-data-transmission"></button>
            <button id="decline-data-transmission"></button>
        `;
        const {DataTransmissionConsentController} = await import('../ext/js/pages/settings/data-transmission-consent-controller.js');
        const modal = {setVisible: vi.fn()};
        const controller = new DataTransmissionConsentController(
            /** @type {any} */ ({modifySettings: vi.fn().mockResolvedValue([{result: null}]), getOptionsContext: () => ({})}),
            /** @type {any} */ ({getModal: () => modal}),
        );
        await controller.prepare();
        await expect(controller._onDecline()).rejects.toThrow('incomplete response');
        expect(modal.setVisible).not.toHaveBeenCalled();
    });

});
