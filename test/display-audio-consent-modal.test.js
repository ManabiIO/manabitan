/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {readFile} from 'node:fs/promises';
import {expect, vi} from 'vitest';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {ModalController} from '../ext/js/pages/settings/modal-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Promise<{player: DisplayAudio, modal: import('../ext/js/pages/settings/modal.js').Modal, save: import('vitest').Mock, notify: import('vitest').Mock}>}
 */
async function setup(window) {
    const source = await readFile(new URL('../ext/templates-modals.html', import.meta.url), 'utf8');
    const container = window.document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property -- Trusted shipped modal markup.
    container.innerHTML = source;
    const template = /** @type {HTMLTemplateElement} */ (container.querySelector('#settings-modals-template'));
    const modalNode = /** @type {HTMLElement} */ (template.content.querySelector('#firefox-data-transmission-consent-modal'));
    window.document.body.appendChild(modalNode.cloneNode(true));
    const menus = window.document.createElement('div');
    menus.id = 'popup-menus';
    window.document.body.appendChild(menus);
    const modals = new ModalController([]);
    await modals.prepare();
    const modal = modals.getModal('firefox-data-transmission-consent');
    if (modal === null) { throw new Error('Missing shipped modal'); }
    const save = vi.fn(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ targets) => targets.map(({value}) => ({result: value})));
    const player = new DisplayAudio(/** @type {any} */ ({
        getOptions: () => ({audio: {enabled: true}}),
        getOptionsProfileId: () => 'profile-a',
        getOptionsContext: () => ({depth: 0, url: 'https://example.test/'}),
        progressIndicatorVisible: {clearOverride() {}},
        application: {api: {modifySettings: save, optionsGetFull: vi.fn().mockResolvedValue({global: {dataTransmissionConsentState: 'unknown'}})}},
    }), modals);
    player._dataTransmissionConsentRequired = true;
    player._firefoxDataTransmissionModal = modal;
    const notify = vi.spyOn(player, '_showNotification').mockImplementation(() => {});
    player._prepareDataTransmissionConsentModal();
    modal.setVisible(true, false);
    return {player, modal, save, notify};
}

for (const state of /** @type {const} */ (['accepted', 'declined'])) {
    test('popup consent closes its forced modal only after saved ' + state, async ({window}) => {
        const {modal, save} = await setup(window);
        const pending = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
        save.mockReturnValueOnce(pending.promise);
        const id = state === 'accepted' ? 'accept-data-transmission' : 'decline-data-transmission';
        /** @type {HTMLButtonElement} */ (window.document.getElementById(id)).click();
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        expect(modal.isVisible()).toBe(true);
        pending.resolve(save.mock.calls[0][0].map((/** @type {import('settings-modifications').ScopedModificationSet} */ {value}) => ({result: value})));
        await vi.waitFor(() => expect(modal.isVisible()).toBe(false));
    });
}

test('popup consent keeps its modal available for retry after an invalid acknowledgment', async ({window}) => {
    const {modal, save, notify} = await setup(window);
    save.mockResolvedValueOnce([]);
    /** @type {HTMLButtonElement} */ (window.document.getElementById('accept-data-transmission')).click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(modal.isVisible()).toBe(true);
});

test('a superseded consent completion cannot close the modal while the newest choice is pending', async ({window}) => {
    const {player, modal, save} = await setup(window);
    const first = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
    const last = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
    save.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const older = player._updateDataTransmissionConsent('accepted', true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const newer = player._updateDataTransmissionConsent('declined', false);
    first.resolve(save.mock.calls[0][0].map((/** @type {import('settings-modifications').ScopedModificationSet} */ {value}) => ({result: value})));
    await older;
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(modal.isVisible()).toBe(true);
    last.resolve(save.mock.calls[1][0].map((/** @type {import('settings-modifications').ScopedModificationSet} */ {value}) => ({result: value})));
    await newer;
    expect(modal.isVisible()).toBe(false);
});
