/*
 * Copyright (C) 2026  Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {AudioController} from '../ext/js/pages/settings/audio-controller.js';
import {DataTransmissionConsentController} from '../ext/js/pages/settings/data-transmission-consent-controller.js';

const domTest = createDomTest();

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {'accepted'|'declined'} decision
 * @param {boolean} failAudioWrite
 * @returns {Promise<{audio: AudioController, modal: {setVisible: ReturnType<typeof vi.fn>}, persisted: {consent: string, audioEnabled: boolean}, controller: DataTransmissionConsentController, application: {api: {optionsGetFull: ReturnType<typeof vi.fn>}}}>}
 */
async function runConsentSave(window, decision, failAudioWrite = false) {
    window.document.body.innerHTML = `
        <div id="audio-source-list"></div>
        <button id="audio-source-add"></button>
        <input id="text-to-speech-voice-test-text">
        <button id="accept-data-transmission"></button>
        <button id="decline-data-transmission"></button>
        <p id="data-transmission-consent-save-error" hidden></p>
    `;
    window.document.documentElement.dataset.browser = 'firefox';

    const persisted = {consent: 'unknown', audioEnabled: true};
    const optionsFull = () => ({
        global: {dataTransmissionConsentState: persisted.consent},
        profileCurrent: 0,
        profiles: [{id: 'default', options: {general: {language: 'ja'}, audio: {sources: [], enabled: persisted.audioEnabled}}}],
    });
    const application = {
        on: vi.fn(),
        api: {
            optionsGetFull: vi.fn(async () => optionsFull()),
            optionsGet: vi.fn(async () => optionsFull().profiles[0].options),
            modifySettings: vi.fn(async (targets) => {
                // Simulate backend notification suppression for this Settings source.
                for (const target of targets) {
                    if (target.path === 'global.dataTransmissionConsentState') { persisted.consent = target.value; }
                    if (target.path === 'audio.enabled') {
                        if (failAudioWrite) { return targets.map(() => ({error: {name: 'Error', message: 'audio write failed', stack: ''}})); }
                        persisted.audioEnabled = target.value;
                    }
                }
                return targets.map(() => ({result: null}));
            }),
        },
    };
    const settings = new SettingsController(/** @type {any} */ (application));
    settings._profileId = 'default';

    const modal = {setVisible: vi.fn()};
    const modalController = {getModal: vi.fn(() => modal)};
    const audio = new AudioController(settings, /** @type {any} */ ({getModal: () => null}));
    settings.on('optionsChanged', audio._onOptionsChanged.bind(audio));
    await settings.refresh();
    await vi.waitFor(() => expect(window.document.documentElement.dataset.audioConsentState).toBe('unknown'));

    const controller = new DataTransmissionConsentController(
        settings,
        /** @type {any} */ ({getModal: () => modal}),
    );
    await controller.prepare();
    const save = decision === 'accepted' ? controller._onAccept() : controller._onDecline();
    await (failAudioWrite ? expect(save).rejects.toThrow('audio write failed') : save);
    return {audio, modal, persisted, controller, application};
}

domTest('accepted and declined Settings consent saves update the audio consent UI state', async ({window}) => {
    const accepted = await runConsentSave(window, 'accepted');
    await vi.waitFor(() => expect(window.document.documentElement.dataset.audioConsentState).toBe('accepted'));
    expect(accepted.persisted).toEqual({consent: 'accepted', audioEnabled: true});
    expect(accepted.modal.setVisible).toHaveBeenCalledWith(false);

    const declined = await runConsentSave(window, 'declined');
    await vi.waitFor(() => expect(window.document.documentElement.dataset.audioConsentState).toBe('declined'));
    expect(declined.persisted).toEqual({consent: 'declined', audioEnabled: false});
    expect(declined.modal.setVisible).toHaveBeenCalledWith(false);
});

domTest('failed consent save reconciles partial persistence and keeps the modal open', async ({window}) => {
    const {audio, modal, persisted, application} = await runConsentSave(window, 'accepted', true);
    await vi.waitFor(() => expect(window.document.documentElement.dataset.audioConsentState).toBe('accepted'));
    expect(audio._dataTransmissionConsentState).toBe('accepted');
    expect(persisted).toEqual({consent: 'accepted', audioEnabled: true});
    expect(modal.setVisible).not.toHaveBeenCalled();
    expect(/** @type {HTMLElement} */ (window.document.querySelector('#data-transmission-consent-save-error')).hidden).toBe(false);
    expect(application.api.optionsGetFull).toHaveBeenCalledTimes(4);
});
