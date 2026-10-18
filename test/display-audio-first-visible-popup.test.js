/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';
import {EventListenerCollection} from '../ext/js/core/event-listener-collection.js';
import {Popup} from '../ext/js/app/popup.js';
import {Display} from '../ext/js/display/display.js';
import {DisplayAudio} from '../ext/js/display/display-audio.js';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function setup({visible = false} = {}) {
    const display = /** @type {any} */ (new EventDispatcher());
    Object.assign(display, {
        _frameVisible: visible,
        _setContentToken: {},
        _publicationGenerations: new Map(),
        _activePublication: null,
        _cancelPendingScannerSearches() {},
        dictionaryEntries: [{type: 'term', headwords: [{term: '語', reading: 'ご'}]}],
        _isPublicationValid: Display.prototype._isPublicationValid,
        async setContent() {
            /** @type {any} */ (this).trigger('contentUpdateComplete', {type: 'terms'});
            return true;
        },
    });
    Object.defineProperty(display, 'frameVisible', {get() { return this._frameVisible; }});
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        audio: {enabled: true, autoPlay: true, fallbackSoundType: 'none', volume: 100, sources: [], enableDefaultAudioSources: false},
    }));
    display.getOptions = () => options;

    const player = /** @type {DisplayAudio} */ (Object.create(DisplayAudio.prototype));
    const playAudio = vi.fn(async () => {});
    Object.assign(player, {
        _display: display,
        _autoPlay: true,
        _autoPlayAudioDelay: 0,
        _autoPlayAudioTimer: null,
        _deferredAutoPlayIntent: false,
        _audioPlaying: null,
        _audioPlayPending: false,
        _playbackToken: null,
        _playbackProgressToken: null,
        _dataTransmissionConsentRequired: false,
        _dataTransmissionConsentState: 'accepted',
        _openMenus: new Set(),
        _eventListeners: new EventListenerCollection(),
        _audioSources: [],
        _cache: new Map(),
        _audioSourceTypeNames: new Map(),
        playAudio,
    });
    display.on('contentUpdateComplete', player._onContentUpdateComplete.bind(player));
    display.on('frameVisibilityChange', player._onFrameVisibilityChange.bind(player));

    const popup = /** @type {Popup} */ (Object.create(Popup.prototype));
    Object.assign(popup, {
        _optionsContext: {url: 'https://example.test'},
        _publicationGeneration: 0,
        _publicationSource: 'first-visible-audio-test',
        _cancelPendingPublication: null,
        _visible: {value: false},
        _visibleValue: false,
        _child: null,
        _hidePopupTimer: null,
        _frame: {dataset: {}, style: {setProperty() {}}},
        _displayMode: 'default',
        _displayModeIsFullWidth: false,
        _inject: vi.fn().mockResolvedValue(true),
        _getViewport: vi.fn().mockReturnValue({left: 0, top: 0, right: 1000, bottom: 1000}),
        _getPosition: vi.fn().mockReturnValue({left: 10, top: 10, width: 100, height: 100, after: false, below: true}),
        /** @param {boolean} value */
        _setVisible(value) {
            this._visible.value = value;
            Popup.prototype._onVisibleChange.call(this, {value});
        },
        _updateHostPageDebugState: vi.fn(),
        _incrementHostDebugCounter: vi.fn().mockReturnValue(1),
        /**
         * @param {string} action
         * @param {unknown} params
         */
        async _invokeSafe(action, params) {
            switch (action) {
                case 'displaySetContent':
                    await Display.prototype._onMessageSetContent.call(display, /** @type {any} */ (params));
                    break;
                case 'displayVisibilityChanged':
                    Display.prototype._onMessageVisibilityChanged.call(display, /** @type {any} */ (params));
                    break;
                case 'displayCancelPublication':
                    Display.prototype._onMessageCancelPublication.call(display, /** @type {any} */ (params));
                    break;
            }
        },
    });
    return {display, player, popup, playAudio};
}

const popupDetails = /** @type {import('popup').ContentDetails} */ (/** @type {unknown} */ ({
    optionsContext: null,
    sourceRects: [{left: 10, top: 10, right: 15, bottom: 15}],
    writingMode: 'horizontal-tb',
}));
const displayDetails = /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));

test('first visible popup lookup schedules autoplay after hidden content rendering', async () => {
    const {display, player, popup} = setup();

    await popup.showContent(popupDetails, displayDetails);

    // Popup.showContent awaits the real Display message handler before _show()
    // emits the visibility event. That handler completes content while hidden.
    expect(display.frameVisible).toBe(true);
    expect(player.playAudio).toHaveBeenCalledTimes(1);
});

test('already-visible popup updates and search-page style updates schedule autoplay', async () => {
    const {player, popup, playAudio} = setup({visible: true});

    await popup.showContent(popupDetails, displayDetails);
    expect(player.playAudio).toHaveBeenCalledTimes(1);

    playAudio.mockClear();
    player._display.trigger('contentUpdateComplete', {type: 'terms'});
    expect(playAudio).toHaveBeenCalledTimes(1);
});

test('hidden prewarm stays silent while hidden, then show autoplays current content once', async () => {
    vi.useFakeTimers();
    const {display, player, popup} = setup();

    await popup.prewarmContent(displayDetails);
    await vi.advanceTimersByTimeAsync(500);
    expect(player.playAudio).not.toHaveBeenCalled();

    await popup.showContent(popupDetails, displayDetails);
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    await vi.advanceTimersByTimeAsync(500);
    expect(player.playAudio).toHaveBeenCalledTimes(1);
});

test('hide before the autoplay delay fires clears pending playback', async () => {
    vi.useFakeTimers();
    const {display, player} = setup({visible: true});
    player._autoPlayAudioDelay = 100;

    display.trigger('contentUpdateComplete', {type: 'terms'});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: false});
    await vi.advanceTimersByTimeAsync(500);

    expect(player.playAudio).not.toHaveBeenCalled();
});

test('autoplay remains gated by audio consent', () => {
    const {display, player} = setup({visible: true});
    player._dataTransmissionConsentRequired = true;
    player._dataTransmissionConsentState = 'declined';

    display.trigger('contentUpdateComplete', {type: 'terms'});

    expect(player.playAudio).not.toHaveBeenCalled();
});

test('hidden autoplay intent is cancelled by stop and does not resume on show', async () => {
    const {display, player} = setup();
    display.trigger('contentUpdateComplete', {type: 'terms'});
    expect(player._deferredAutoPlayIntent).toBe(true);
    player.stopAudio();
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).not.toHaveBeenCalled();
});

test('hide before visibility cancels deferred autoplay', () => {
    const {display, player} = setup();
    display.trigger('contentUpdateComplete', {type: 'terms'});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: false});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).not.toHaveBeenCalled();
});

test('content clear cancels deferred autoplay before first visibility', () => {
    const {display, player} = setup();
    display.trigger('contentUpdateComplete', {type: 'terms'});
    expect(player._deferredAutoPlayIntent).toBe(true);

    player._onContentClear();
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).not.toHaveBeenCalled();
});

test('deferred first-show autoplay waits for the default-like delay and runs once', async () => {
    vi.useFakeTimers();
    const {display, player, playAudio} = setup();
    player._autoPlayAudioDelay = 100;

    display.trigger('contentUpdateComplete', {type: 'terms'});
    expect(player._deferredAutoPlayIntent).toBe(true);
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});

    await vi.advanceTimersByTimeAsync(99);
    expect(playAudio).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(playAudio).toHaveBeenCalledTimes(1);

    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    await vi.advanceTimersByTimeAsync(500);
    expect(playAudio).toHaveBeenCalledTimes(1);
});

test('content replacement retains only eligible current content autoplay', () => {
    const {display, player} = setup();
    display.trigger('contentUpdateComplete', {type: 'terms'});
    display.dictionaryEntries = [];
    display.trigger('contentUpdateComplete', {type: 'terms'});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).not.toHaveBeenCalled();

    display._frameVisible = false;
    display.dictionaryEntries = [{type: 'term', headwords: [{term: '新', reading: 'しん'}]}];
    display.trigger('contentUpdateComplete', {type: 'terms'});
    display.dictionaryEntries = [{type: 'term', headwords: [{term: '現', reading: 'げん'}]}];
    display.trigger('contentUpdateComplete', {type: 'terms'});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).toHaveBeenCalledTimes(1);

    display._frameVisible = false;
    display.dictionaryEntries = [{type: 'term', headwords: [{term: '語', reading: 'ご'}]}];
    display.trigger('contentUpdateComplete', {type: 'terms'});
    display.dictionaryEntries = [{type: 'kanji', headwords: [{character: '語'}]}];
    display.trigger('contentUpdateComplete', {type: 'terms'});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).toHaveBeenCalledTimes(1);
});

test('options disabling autoplay cancels deferred intent', () => {
    vi.stubGlobal('document', {documentElement: {dataset: {}}});
    const {display, player} = setup();
    display.trigger('contentUpdateComplete', {type: 'terms'});
    expect(player._deferredAutoPlayIntent).toBe(true);

    const options = display.getOptions();
    options.audio.autoPlay = false;
    player._onOptionsUpdated({options});
    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).not.toHaveBeenCalled();
});

test('consent revocation cancels deferred intent after consent is reaccepted', () => {
    vi.stubGlobal('document', {documentElement: {dataset: {}}});
    const {display, player} = setup();
    display.trigger('contentUpdateComplete', {type: 'terms'});
    expect(player._deferredAutoPlayIntent).toBe(true);

    player._dataTransmissionConsentRequired = true;
    player._dataTransmissionConsentState = 'accepted';
    player._setDataTransmissionConsentState('declined');
    player._setDataTransmissionConsentState('accepted');

    Display.prototype._onMessageVisibilityChanged.call(display, {value: true});
    expect(player.playAudio).not.toHaveBeenCalled();
});

test('delayed playback is cancelled when popup hides before the delay', async () => {
    vi.useFakeTimers();
    const {display, player, popup} = setup();
    player._autoPlayAudioDelay = 100;
    await popup.showContent(popupDetails, displayDetails);
    Display.prototype._onMessageVisibilityChanged.call(display, {value: false});
    await vi.advanceTimersByTimeAsync(500);
    expect(player.playAudio).not.toHaveBeenCalled();
});
