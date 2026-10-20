/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DisplayAudio} from '../ext/js/display/display-audio.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @returns {{player: DisplayAudio, save: import('vitest').Mock, state: {profileId: ?string, context: import('settings').OptionsContext}, notifications: import('vitest').Mock}}
 */
function setup() {
    vi.stubGlobal('document', {documentElement: {dataset: {}}});
    const state = {profileId: /** @type {?string} */ ('profile-a'), context: /** @type {import('settings').OptionsContext} */ ({depth: 0, url: 'https://example.test/', flags: ['clipboard']})};
    const save = vi.fn(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ targets) => targets.map(({value}) => ({result: value})));
    const notifications = vi.fn();
    const player = /** @type {DisplayAudio} */ (Object.create(DisplayAudio.prototype));
    Object.assign(player, {
        _audioPlaying: null,
        _audioPlayPending: false,
        _playbackToken: null,
        _playbackProgressToken: null,
        _autoPlayAudioTimer: null,
        _deferredAutoPlayIntent: false,
        _dataTransmissionConsentRequired: true,
        _dataTransmissionConsentState: 'unknown',
        _consentStateToken: {},
        _consentUpdatePromise: null,
        _display: {
            getOptions: () => ({audio: {enabled: false}}),
            getOptionsContext: () => state.context,
            getOptionsProfileId: () => state.profileId,
            progressIndicatorVisible: {clearOverride() {}},
            application: {api: {modifySettings: save, optionsGetFull: vi.fn().mockResolvedValue({global: {dataTransmissionConsentState: 'accepted'}})}},
        },
        _showNotification: notifications,
    });
    return {player, save, state, notifications};
}

test('audio consent delivery after a default-profile change modifies only the displayed profile', async () => {
    const {player, save} = setup();
    const options = {global: {dataTransmissionConsentState: 'unknown', dataTransmissionConsentShown: false},
        profileCurrent: 0,
        profiles: [
            {id: 'profile-a', conditionGroups: [], options: {audio: {enabled: false}}},
            {id: 'profile-b', conditionGroups: [], options: {audio: {enabled: false}}},
        ]};
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_getOptionsFull', () => options);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    save.mockImplementation(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ targets) => {
        options.profileCurrent = 1;
        return targets.map((target) => ({result: backend._modifySetting(target)}));
    });
    await player._updateDataTransmissionConsent('accepted', true);
    expect(options.profiles[0].options.audio.enabled).toBe(true);
    expect(options.profiles[1].options.audio.enabled).toBe(false);
    expect(save.mock.calls[0][0][2].profileId).toBe('profile-a');
});

for (const reply of [[], [{result: 'accepted'}, {result: true}], [{}, {}, {}], [{result: 'declined'}, {result: true}, {result: true}], [{result: 'accepted'}, {result: false}, {result: true}], [{result: 'accepted'}, {result: true}, {result: false}]]) {
    test('incomplete or mismatched audio consent acknowledgment cannot grant playback: ' + JSON.stringify(reply), async () => {
        const {player, save, notifications} = setup();
        save.mockResolvedValueOnce(reply);
        await player._updateDataTransmissionConsent('accepted', true);
        expect(player._canPlayAudio()).toBe(false);
        expect(notifications).toHaveBeenCalledOnce();
    });
}

test('audio consent refuses a profile-scoped write when displayed profile identity is unavailable', async () => {
    const {player, state, save, notifications} = setup();
    state.profileId = null;
    await player._updateDataTransmissionConsent('accepted', true);
    expect(save).not.toHaveBeenCalled();
    expect(player._canPlayAudio()).toBe(false);
    expect(notifications).toHaveBeenCalledOnce();
});

test('queued audio consent retains nested context flags from the click', async () => {
    const {player, state, save} = setup();
    const update = player._updateDataTransmissionConsent('accepted', true);
    state.context.flags?.splice(0, 1);
    await update;
    expect(save.mock.calls[0][0][2].optionsContext).toStrictEqual({depth: 0, url: 'https://example.test/', flags: ['clipboard']});
});
