/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DisplayAudio} from '../ext/js/display/display-audio.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => { throw new Error('Uninitialized deferred'); };
    /** @type {(reason: unknown) => void} */
    let reject = () => { throw new Error('Uninitialized deferred'); };
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @param {'unknown'|'accepted'|'declined'} [initial]
 * @returns {{player: DisplayAudio, reads: ReturnType<typeof deferred>[], writes: {targets: import('settings-modifications').ScopedModificationSet[], gate: ReturnType<typeof deferred>}[], notifications: string[], context: {index: number, depth: number, url: string}, stats: {active: number, maxActive: number}, finishReads: (state: 'unknown'|'accepted'|'declined') => void, finishWrites: () => Promise<void>}}
 */
function setup(initial = 'unknown') {
    vi.stubGlobal('document', {documentElement: {dataset: {}}});
    /** @type {ReturnType<typeof deferred>[]} */
    const reads = [];
    /** @type {{targets: import('settings-modifications').ScopedModificationSet[], gate: ReturnType<typeof deferred>}[]} */
    const writes = [];
    /** @type {string[]} */
    const notifications = [];
    const context = {index: 1, depth: 0, url: 'https://example.test/'};
    const stats = {active: 0, maxActive: 0};
    const player = /** @type {DisplayAudio} */ (Object.create(DisplayAudio.prototype));
    Object.assign(player, {
        _audioPlaying: null,
        _audioPlayPending: false,
        _playbackToken: null,
        _playbackProgressToken: null,
        _autoPlayAudioTimer: null,
        _dataTransmissionConsentRequired: true,
        _dataTransmissionConsentState: initial,
        _consentStateToken: {},
        _consentUpdatePromise: null,
        _display: {
            getOptions: () => ({audio: {enabled: true}}),
            getOptionsContext: () => context,
            progressIndicatorVisible: {clearOverride() {}},
            application: {api: {
                optionsGetFull() {
                    const gate = deferred();
                    reads.push(gate);
                    return gate.promise;
                },
                /**
                 * @param {import('settings-modifications').ScopedModificationSet[]} targets
                 * @returns {Promise<unknown>}
                 */
                modifySettings(targets) {
                    const gate = deferred();
                    // Extension messages serialize their payload on dispatch.
                    writes.push({targets: structuredClone(targets), gate});
                    ++stats.active;
                    stats.maxActive = Math.max(stats.maxActive, stats.active);
                    return gate.promise.finally(() => { --stats.active; });
                },
            }},
        },
        /** @param {string} message */
        _showNotification: (message) => { notifications.push(message); },
    });
    /** @param {'unknown'|'accepted'|'declined'} state */
    const finishReads = (state) => {
        for (const gate of reads) { gate.resolve({global: {dataTransmissionConsentState: state}}); }
    };
    /** @returns {Promise<void>} */
    const finishWrites = async () => {
        for (let i = 0; i < 8; ++i) {
            for (const {gate} of writes) { gate.resolve([]); }
            await flush();
        }
    };
    return {player, reads, writes, notifications, context, stats, finishReads, finishWrites};
}

for (const [stored, chosen] of /** @type {const} */ ([['accepted', 'declined'], ['unknown', 'accepted']])) {
    test(`an old ${stored} read cannot overwrite a saved ${chosen} decision`, async () => {
        const {player, reads, writes, finishReads} = setup(stored);
        const refresh = player._refreshDataTransmissionConsentState();
        const oldRead = reads[0];
        const update = player._updateDataTransmissionConsent(chosen, chosen === 'accepted');
        await flush();
        writes[0].gate.resolve([]);
        await update;
        oldRead.resolve({global: {dataTransmissionConsentState: stored}});
        await refresh;
        const allowed = player._canPlayAudio();
        finishReads(chosen);
        await flush();
        expect(allowed).toBe(chosen === 'accepted');
    });
}

test('decline immediately retires playback even while its settings save is pending', async () => {
    const {player, writes, finishReads} = setup('accepted');
    const token = {};
    Reflect.set(player, '_playbackToken', token);
    const update = player._updateDataTransmissionConsent('declined', false);
    const allowedWhileSaving = player._canPlayAudio();
    const retainedRequest = Reflect.get(player, '_playbackToken') === token;
    await flush();
    writes[0].gate.resolve([]);
    await update;
    finishReads('declined');
    await flush();
    expect(allowedWhileSaving).toBe(false);
    expect(retainedRequest).toBe(false);
});

test('accept followed by decline is serialized and cannot be re-enabled by a late acceptance response', async () => {
    const {player, writes, stats, finishReads} = setup('accepted');
    const first = player._updateDataTransmissionConsent('accepted', true);
    await flush();
    const last = player._updateDataTransmissionConsent('declined', false);
    await flush();
    const sentBeforeFirstAcknowledgement = writes.length;
    const allowedWhileSaving = player._canPlayAudio();
    // Expose out-of-order responses on the old implementation without making
    // the corrected serial queue depend on a response it has not requested.
    if (writes.length > 1) { writes[1].gate.resolve([]); }
    writes[0].gate.resolve([]);
    await first;
    await flush();
    writes[1].gate.resolve([]);
    await last;
    const allowed = player._canPlayAudio();
    finishReads('declined');
    await flush();
    expect(sentBeforeFirstAcknowledgement).toBe(1);
    expect(stats.maxActive).toBe(1);
    expect(allowedWhileSaving).toBe(false);
    expect(allowed).toBe(false);
});

test('a failed older save does not poison the newer decision or show an obsolete error', async () => {
    const {player, writes, notifications, finishReads} = setup();
    const first = player._updateDataTransmissionConsent('accepted', true);
    await flush();
    const last = player._updateDataTransmissionConsent('declined', false);
    writes[0].gate.reject(new Error('Older transport failed'));
    await first;
    await flush();
    writes[1].gate.resolve([]);
    await last;
    finishReads('declined');
    await flush();
    expect(player._canPlayAudio()).toBe(false);
    expect(notifications.length).toBe(0);
});

test('a failed decline stays locally denied, reports the failure, and allows a later retry', async () => {
    const {player, writes, notifications, finishReads} = setup('accepted');
    const failed = player._updateDataTransmissionConsent('declined', false);
    await flush();
    writes[0].gate.reject(new Error('Settings unavailable'));
    await failed;
    const allowedAfterFailure = player._canPlayAudio();
    const retry = player._updateDataTransmissionConsent('accepted', true);
    await flush();
    writes[1].gate.resolve([]);
    await retry;
    finishReads('accepted');
    await flush();
    expect(allowedAfterFailure).toBe(false);
    expect(notifications.length).toBe(1);
    expect(player._canPlayAudio()).toBe(true);
});

test('superseded queued decisions are not sent to persistent settings', async () => {
    const {player, writes, stats, finishWrites, finishReads} = setup();
    const first = player._updateDataTransmissionConsent('declined', false);
    await flush();
    const obsolete = player._updateDataTransmissionConsent('accepted', true);
    const last = player._updateDataTransmissionConsent('declined', false);
    await finishWrites();
    await Promise.all([first, obsolete, last]);
    const states = writes.map(({targets}) => targets[0].value);
    finishReads('declined');
    await flush();
    expect(states).toEqual(['declined', 'declined']);
    expect(stats.maxActive).toBe(1);
    expect(player._canPlayAudio()).toBe(false);
});

test('options broadcasts during a save cannot publish its earlier stored consent', async () => {
    const {player, reads, writes, finishReads} = setup('accepted');
    const update = player._updateDataTransmissionConsent('declined', false);
    await flush();
    const refresh = player._refreshDataTransmissionConsentState();
    const readsDuringSave = reads.length;
    finishReads('accepted');
    await refresh;
    const allowedWhileSaving = player._canPlayAudio();
    writes[0].gate.resolve([]);
    await update;
    finishReads('declined');
    await flush();
    expect(readsDuringSave).toBe(0);
    expect(allowedWhileSaving).toBe(false);
    expect(player._canPlayAudio()).toBe(false);
});

test('after the final successful save, consent is reconciled with other settings contexts', async () => {
    const {player, reads, writes, finishReads} = setup();
    const update = player._updateDataTransmissionConsent('accepted', true);
    await flush();
    writes[0].gate.resolve([]);
    await update;
    // Another settings page revoked consent while this response was in transit.
    const refreshed = reads.length;
    finishReads('declined');
    await flush();
    expect(refreshed).toBe(1);
    expect(player._canPlayAudio()).toBe(false);
});

test('a queued decision retains the profile context captured at the click', async () => {
    const {player, writes, context, finishWrites, finishReads} = setup();
    const first = player._updateDataTransmissionConsent('declined', false);
    await flush();
    const second = player._updateDataTransmissionConsent('accepted', true);
    context.index = 2;
    context.url = 'https://elsewhere.test/';
    await finishWrites();
    await Promise.all([first, second]);
    finishReads('accepted');
    await flush();
    expect(writes[1].targets[2].optionsContext).toEqual({index: 1, depth: 0, url: 'https://example.test/'});
});

test('a partial settings error does not grant consent and does not block a later update', async () => {
    const {player, writes, reads, notifications, finishReads} = setup();
    const first = player._updateDataTransmissionConsent('accepted', true);
    await flush();
    writes[0].gate.resolve([{error: 'Rejected modification'}]);
    await first;
    const allowedAfterError = player._canPlayAudio();
    const readsAfterError = reads.length;
    const next = player._updateDataTransmissionConsent('declined', false);
    await flush();
    writes[1].gate.resolve([]);
    await next;
    finishReads('declined');
    await flush();
    expect(allowedAfterError).toBe(false);
    expect(readsAfterError).toBe(0);
    expect(notifications.length).toBe(1);
    expect(player._canPlayAudio()).toBe(false);
});

test('newest ordinary consent refresh still wins out-of-order reads', async () => {
    const {player, reads} = setup();
    const first = player._refreshDataTransmissionConsentState();
    const last = player._refreshDataTransmissionConsentState();
    reads[1].resolve({global: {dataTransmissionConsentState: 'declined'}});
    await last;
    reads[0].resolve({global: {dataTransmissionConsentState: 'accepted'}});
    await first;
    expect(player._canPlayAudio()).toBe(false);
});
