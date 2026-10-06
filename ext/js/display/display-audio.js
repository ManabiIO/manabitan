/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {PopupMenu} from '../dom/popup-menu.js';
import {querySelectorNotNull} from '../dom/query-selector.js';
import {
    getDataTransmissionConsentStateFromOptionsFull,
    getDataTransmissionConsentUpdateTargets,
    isDataTransmissionConsentRequiredBrowser,
    normalizeDataTransmissionConsentState,
} from '../data/data-transmission-consent-util.js';
import {getRequiredAudioSourceList} from '../media/audio-downloader.js';
import {AudioSystem} from '../media/audio-system.js';
import {toError} from '../core/to-error.js';

export class DisplayAudio {
    /**
     * @param {import('./display.js').Display} display
     * @param {?import('../pages/settings/modal-controller.js').ModalController} [modalController]
     */
    constructor(display, modalController = null) {
        /** @type {import('./display.js').Display} */
        this._display = display;
        /** @type {?import('../pages/settings/modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {?import('display-audio').GenericAudio} */
        this._audioPlaying = null;
        /** @type {boolean} */
        this._audioPlayPending = false;
        /** @type {?import('core').TokenObject} */
        this._playbackToken = null;
        /** @type {?import('core').TokenString} */
        this._playbackProgressToken = null;
        /** @type {import('core').TokenObject} */
        this._primaryCardAudioToken = {};
        /** @type {AudioSystem} */
        this._audioSystem = new AudioSystem(this._display.application.api);
        /** @type {number} */
        this._playbackVolume = 1;
        /** @type {boolean} */
        this._autoPlay = false;
        /** @type {import('settings').FallbackSoundType} */
        this._fallbackSoundType = 'none';
        /** @type {?import('core').Timeout} */
        this._autoPlayAudioTimer = null;
        /** @type {number} */
        this._autoPlayAudioDelay = 400;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {Map<string, import('display-audio').CacheItem>} */
        this._cache = new Map();
        /** @type {number} */
        this._cacheMaxSize = 256;
        /** @type {Element} */
        this._menuContainer = querySelectorNotNull(document, '#popup-menus');
        /** @type {import('core').TokenObject} */
        this._entriesToken = {};
        /** @type {Set<PopupMenu>} */
        this._openMenus = new Set();
        /** @type {import('display-audio').AudioSource[]} */
        this._audioSources = [];
        /** @type {Map<import('settings').AudioSourceType, string>} */
        this._audioSourceTypeNames = new Map([
            ['jpod101', 'JapanesePod101'],
            ['language-pod-101', 'LanguagePod101'],
            ['jisho', 'Jisho.org'],
            ['lingua-libre', 'Lingua Libre'],
            ['wiktionary', 'Wiktionary'],
            ['text-to-speech', 'Text-to-speech'],
            ['text-to-speech-reading', 'Text-to-speech (Kana reading)'],
            ['custom', 'Custom URL'],
            ['custom-json', 'Custom URL (JSON)'],
        ]);
        /** @type {?boolean} */
        this._enableDefaultAudioSources = null;
        /** @type {boolean} */
        this._dataTransmissionConsentRequired = false;
        /** @type {'unknown'|'accepted'|'declined'} */
        this._dataTransmissionConsentState = 'unknown';
        /** @type {import('core').TokenObject} */
        this._consentStateToken = {};
        /** @type {?Promise<boolean>} */
        this._consentUpdatePromise = null;
        /** @type {?import('../pages/settings/modal.js').Modal} */
        this._firefoxDataTransmissionModal = null;
        /** @type {?HTMLButtonElement} */
        this._acceptDataTransmissionButton = null;
        /** @type {?HTMLButtonElement} */
        this._declineDataTransmissionButton = null;
        /** @type {?import('./display-notification.js').DisplayNotification} */
        this._notification = null;
        /** @type {?import('core').Timeout} */
        this._notificationHideTimer = null;
        /** @type {number} */
        this._notificationHideTimeout = 5000;
        /** @type {(event: MouseEvent) => void} */
        this._onAudioPlayButtonClickBind = this._onAudioPlayButtonClick.bind(this);
        /** @type {(event: MouseEvent) => void} */
        this._onAudioPlayButtonContextMenuBind = this._onAudioPlayButtonContextMenu.bind(this);
        /** @type {(event: import('popup-menu').MenuCloseEvent) => void} */
        this._onAudioPlayMenuCloseClickBind = this._onAudioPlayMenuCloseClick.bind(this);
        /** @type {(event: MouseEvent) => void} */
        this._onEnableAudioButtonClickBind = this._onEnableAudioButtonClick.bind(this);
    }

    /** @type {number} */
    get autoPlayAudioDelay() {
        return this._autoPlayAudioDelay;
    }

    set autoPlayAudioDelay(value) {
        this._autoPlayAudioDelay = value;
    }

    /** */
    prepare() {
        this._audioSystem.prepare();
        this._dataTransmissionConsentRequired = isDataTransmissionConsentRequiredBrowser(document.documentElement.dataset.browser);
        this._firefoxDataTransmissionModal = this._modalController?.getModal('firefox-data-transmission-consent') ?? null;
        this._prepareDataTransmissionConsentModal();
        /* eslint-disable @stylistic/no-multi-spaces */
        this._display.hotkeyHandler.registerActions([
            ['playAudio',           this._onHotkeyActionPlayAudio.bind(this)],
            ['playAudioFromSource', this._onHotkeyActionPlayAudioFromSource.bind(this)],
        ]);
        this._display.registerDirectMessageHandlers([
            ['displayAudioClearAutoPlayTimer', this._onMessageClearAutoPlayTimer.bind(this)],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */
        this._display.on('optionsUpdated', this._onOptionsUpdated.bind(this));
        this._display.on('contentClear', this._onContentClear.bind(this));
        this._display.on('contentUpdateEntry', this._onContentUpdateEntry.bind(this));
        this._display.on('contentUpdateComplete', this._onContentUpdateComplete.bind(this));
        this._display.on('frameVisibilityChange', this._onFrameVisibilityChange.bind(this));
        this._display.application.on('optionsUpdated', this._onApplicationOptionsUpdated.bind(this));
        const options = this._display.getOptions();
        if (options !== null) {
            this._onOptionsUpdated({options});
        }
        void this._refreshDataTransmissionConsentState();
    }

    /** */
    clearAutoPlayTimer() {
        if (this._autoPlayAudioTimer === null) { return; }
        clearTimeout(this._autoPlayAudioTimer);
        this._autoPlayAudioTimer = null;
    }

    /** */
    stopAudio() {
        this._stopAudio(null);
    }

    /**
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     * @param {?string} [sourceType]
     */
    async playAudio(dictionaryEntryIndex, headwordIndex, sourceType = null) {
        if (!this._canPlayAudio()) {
            this._showDataTransmissionConsentModal();
            return;
        }
        let sources = this._audioSources;
        if (sourceType !== null) {
            sources = [];
            for (const source of this._audioSources) {
                if (source.type === sourceType) {
                    sources.push(source);
                }
            }
        }
        await this._playAudio(dictionaryEntryIndex, headwordIndex, sources, null);
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @returns {import('display-audio').AudioMediaOptions}
     */
    getAnkiNoteMediaAudioDetails(term, reading) {
        // Card creation is a separate consumer from pronunciation playback.
        // Suppress defaults as well: an empty explicit list alone still downloads.
        if (!this._canPlayAudio()) {
            return {sources: [], preferredAudioIndex: null, enableDefaultAudioSources: false};
        }
        /** @type {import('display-audio').AudioSourceShort[]} */
        const sources = [];
        let preferredAudioIndex = null;
        const primaryCardAudio = this._getPrimaryCardAudio(term, reading);
        if (primaryCardAudio !== null) {
            const {index, subIndex} = primaryCardAudio;
            const source = this._audioSources[index];
            sources.push(this._getSourceData(source));
            preferredAudioIndex = subIndex;
        } else {
            for (const source of this._audioSources) {
                if (!source.isInOptions) { continue; }
                sources.push(this._getSourceData(source));
            }
        }
        const enableDefaultAudioSources = this._enableDefaultAudioSources ?? false;
        return {sources, preferredAudioIndex, enableDefaultAudioSources};
    }

    // Private

    /**
     * @param {?import('core').TokenObject} token
     */
    _stopAudio(token) {
        const audio = this._audioPlaying;
        this._audioPlaying = null;
        this._invalidatePlayback(token);
        if (audio !== null) { audio.pause(); }
    }

    /**
     * @param {?import('core').TokenObject} [token]
     */
    _invalidatePlayback(token = null) {
        this._playbackToken = token;
        const progressToken = this._playbackProgressToken;
        const audio = this._audioPlayPending ? this._audioPlaying : null;
        this._audioPlayPending = false;
        if (audio !== null) {
            // A pending play/resume promise is not already-started playback.
            this._audioPlaying = null;
            audio.pause();
        }
        this._clearPlaybackProgress(progressToken);
    }

    /**
     * @param {?import('core').TokenString} [token]
     */
    _clearPlaybackProgress(token = this._playbackProgressToken) {
        if (token === null || token !== this._playbackProgressToken) { return; }
        this._playbackProgressToken = null;
        this._display.progressIndicatorVisible.clearOverride(token);
    }

    /**
     * @param {import('display').EventArgument<'optionsUpdated'>} details
     */
    _onOptionsUpdated({options}) {
        this._invalidatePlayback();
        this._closeOpenMenus();
        this.clearAutoPlayTimer();
        const {
            general: {language},
            audio: {enabled, autoPlay, fallbackSoundType, volume, sources, enableDefaultAudioSources},
        } = options;
        // Consent can finish loading after options; check it when scheduling.
        this._autoPlay = enabled && autoPlay;
        this._fallbackSoundType = fallbackSoundType;
        this._playbackVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1;
        this._enableDefaultAudioSources = enableDefaultAudioSources;

        /** @type {Set<import('settings').AudioSourceType>} */
        const requiredAudioSources = enableDefaultAudioSources ? getRequiredAudioSourceList(language) : new Set();
        /** @type {Map<string, import('display-audio').AudioSource[]>} */
        const nameMap = new Map();
        this._audioSources.length = 0;
        for (const {type, url, voice} of sources) {
            this._addAudioSourceInfo(type, url, voice, true, nameMap);
            requiredAudioSources.delete(type);
        }
        for (const type of requiredAudioSources) {
            this._addAudioSourceInfo(type, '', '', false, nameMap);
        }

        const data = document.documentElement.dataset;
        data.audioEnabled = (enabled && this._canPlayAudio()).toString();
        data.audioConsentRequired = this._dataTransmissionConsentRequired.toString();
        data.audioConsentState = this._dataTransmissionConsentState;

        this._cache.clear();
    }

    /** */
    _onApplicationOptionsUpdated() {
        void this._refreshDataTransmissionConsentState();
    }

    /** */
    _onContentClear() {
        this._invalidatePlayback();
        this._closeOpenMenus();
        this._entriesToken = {};
        this._cache.clear();
        this.clearAutoPlayTimer();
        this._eventListeners.removeAllEventListeners();
    }

    /**
     * @param {import('display').EventArgument<'contentUpdateEntry'>} details
     */
    _onContentUpdateEntry({element}) {
        const eventListeners = this._eventListeners;
        for (const button of element.querySelectorAll('.action-button[data-action=enable-audio]')) {
            eventListeners.addEventListener(button, 'click', this._onEnableAudioButtonClickBind, false);
        }
        for (const button of element.querySelectorAll('.action-button[data-action=play-audio]')) {
            eventListeners.addEventListener(button, 'click', this._onAudioPlayButtonClickBind, false);
            eventListeners.addEventListener(button, 'contextmenu', this._onAudioPlayButtonContextMenuBind, false);
            eventListeners.addEventListener(button, 'menuClose', this._onAudioPlayMenuCloseClickBind, false);
        }
    }

    /** */
    _onContentUpdateComplete() {
        if (!this._autoPlay || !this._display.frameVisible || !this._canPlayAudio()) { return; }

        this.clearAutoPlayTimer();

        const {dictionaryEntries} = this._display;
        if (dictionaryEntries.length === 0) { return; }

        const firstDictionaryEntries = dictionaryEntries[0];
        if (firstDictionaryEntries.type === 'kanji') { return; }

        const callback = () => {
            this._autoPlayAudioTimer = null;
            void this.playAudio(0, 0);
        };

        if (this._autoPlayAudioDelay > 0) {
            this._autoPlayAudioTimer = setTimeout(callback, this._autoPlayAudioDelay);
        } else {
            callback();
        }
    }

    /**
     * @param {import('display').EventArgument<'frameVisibilityChange'>} details
     */
    _onFrameVisibilityChange({value}) {
        if (!value) {
            // Pending playback is retired, but audio that has already started playing
            // is not stopped, as this is a valid use case for some users.
            this._invalidatePlayback();
            this.clearAutoPlayTimer();
        }
    }

    /** */
    _onHotkeyActionPlayAudio() {
        void this.playAudio(this._display.selectedIndex, 0);
    }

    /**
     * @param {unknown} source
     */
    _onHotkeyActionPlayAudioFromSource(source) {
        if (!(typeof source === 'string' || typeof source === 'undefined' || source === null)) { return; }
        void this.playAudio(this._display.selectedIndex, 0, source);
    }

    /** @type {import('display').DirectApiHandler<'displayAudioClearAutoPlayTimer'>} */
    _onMessageClearAutoPlayTimer() {
        this.clearAutoPlayTimer();
    }

    /**
     * @param {import('settings').AudioSourceType} type
     * @param {string} url
     * @param {string} voice
     * @param {boolean} isInOptions
     * @param {Map<string, import('display-audio').AudioSource[]>} nameMap
     */
    _addAudioSourceInfo(type, url, voice, isInOptions, nameMap) {
        const index = this._audioSources.length;
        const downloadable = this._sourceIsDownloadable(type);
        let name = this._audioSourceTypeNames.get(type);
        if (typeof name === 'undefined') { name = 'Unknown'; }

        let entries = nameMap.get(name);
        if (typeof entries === 'undefined') {
            entries = [];
            nameMap.set(name, entries);
        }
        const nameIndex = entries.length;
        if (nameIndex === 1) {
            entries[0].nameUnique = false;
        }

        /** @type {import('display-audio').AudioSource} */
        const source = {
            index,
            type,
            url,
            voice,
            isInOptions,
            downloadable,
            name,
            nameIndex,
            nameUnique: (nameIndex === 0),
        };

        entries.push(source);
        this._audioSources.push(source);
    }

    /**
     * @param {MouseEvent} e
     */
    _onAudioPlayButtonClick(e) {
        e.preventDefault();

        const button = /** @type {HTMLButtonElement} */ (e.currentTarget);
        const headwordIndex = this._getAudioPlayButtonHeadwordIndex(button);
        const dictionaryEntryIndex = this._display.getElementDictionaryEntryIndex(button);

        if (e.shiftKey) {
            this._showAudioMenu(button, dictionaryEntryIndex, headwordIndex);
        } else {
            void this.playAudio(dictionaryEntryIndex, headwordIndex);
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onEnableAudioButtonClick(e) {
        e.preventDefault();
        this._showDataTransmissionConsentModal();
    }

    /** */
    _prepareDataTransmissionConsentModal() {
        if (this._firefoxDataTransmissionModal === null) { return; }
        this._acceptDataTransmissionButton = /** @type {HTMLButtonElement} */ (querySelectorNotNull(document, '#accept-data-transmission'));
        this._declineDataTransmissionButton = /** @type {HTMLButtonElement} */ (querySelectorNotNull(document, '#decline-data-transmission'));
        this._acceptDataTransmissionButton.addEventListener('click', this._onAcceptDataTransmission.bind(this), false);
        this._declineDataTransmissionButton.addEventListener('click', this._onDeclineDataTransmission.bind(this), false);
    }

    /** */
    async _refreshDataTransmissionConsentState() {
        if (this._consentUpdatePromise !== null) { return; }
        /** @type {import('core').TokenObject} */
        const token = {};
        this._consentStateToken = token;
        try {
            const optionsFull = await this._display.application.api.optionsGetFull();
            if (this._consentStateToken !== token) { return; }
            this._setDataTransmissionConsentState(getDataTransmissionConsentStateFromOptionsFull(optionsFull));
        } catch (_) {
            // NOP
        }
    }

    /**
     * @param {unknown} value
     */
    _setDataTransmissionConsentState(value) {
        this._consentStateToken = {};
        this._dataTransmissionConsentState = normalizeDataTransmissionConsentState(value);
        if (!this._canPlayAudio()) {
            this._invalidatePlayback();
            this.clearAutoPlayTimer();
        }
        this._syncAudioConsentDataset();
    }

    /** */
    _syncAudioConsentDataset() {
        const data = document.documentElement.dataset;
        data.audioConsentRequired = this._dataTransmissionConsentRequired.toString();
        data.audioConsentState = this._dataTransmissionConsentState;
        const enabled = this._display.getOptions()?.audio.enabled === true;
        data.audioEnabled = (enabled && this._canPlayAudio()).toString();
    }

    /**
     * @returns {boolean}
     */
    _canPlayAudio() {
        return !this._dataTransmissionConsentRequired || this._dataTransmissionConsentState === 'accepted';
    }

    /** */
    _showDataTransmissionConsentModal() {
        this._firefoxDataTransmissionModal?.setVisible(true);
    }

    /** */
    async _onAcceptDataTransmission() {
        await this._updateDataTransmissionConsent('accepted', true);
    }

    /** */
    async _onDeclineDataTransmission() {
        await this._updateDataTransmissionConsent('declined', false);
    }

    /**
     * @param {'accepted'|'declined'} state
     * @param {boolean} audioEnabled
     */
    async _updateDataTransmissionConsent(state, audioEnabled) {
        const optionsContext = {...this._display.getOptionsContext()};
        /** @returns {Promise<boolean>} */
        const update = async () => {
            // Serialize persistence, but do not send superseded queued choices.
            if (this._consentUpdatePromise !== promise) { return false; }
            try {
                const results = await this._display.application.api.modifySettings(
                    getDataTransmissionConsentUpdateTargets(state, audioEnabled, optionsContext),
                    'display-audio',
                );
                for (const {error} of results) {
                    if (typeof error !== 'undefined') { throw toError(error); }
                }
                if (this._consentUpdatePromise !== promise) { return false; }
                this._setDataTransmissionConsentState(state);
                return true;
            } catch (_) {
                if (this._consentUpdatePromise === promise) {
                    this._showNotification('Failed to update audio consent. Check extension settings and try again.', true);
                }
                return false;
            }
        };
        const promise = (this._consentUpdatePromise ?? Promise.resolve(false)).then(update, update);
        this._consentUpdatePromise = promise;
        this._consentStateToken = {};
        // Revocation takes effect locally without waiting for storage or older
        // requests. Granting consent still requires a successful current save.
        if (state === 'declined') { this._setDataTransmissionConsentState(state); }
        let applied = false;
        try {
            applied = await promise;
        } finally {
            if (this._consentUpdatePromise === promise) {
                this._consentUpdatePromise = null;
                // Reconcile broadcasts skipped during persistence, including
                // changes made by another settings context in the meantime.
                if (applied) { void this._refreshDataTransmissionConsentState(); }
            }
        }
    }

    /**
     * @param {string} message
     * @param {boolean} autoClose
     */
    _showNotification(message, autoClose) {
        if (this._notification === null) {
            this._notification = this._display.createNotification(false);
            this._notification.node.addEventListener('click', this._onNotificationClick.bind(this), false);
        }
        this._notification.setContent(message);
        this._notification.open();
        this._stopHideNotificationTimer();
        if (autoClose) {
            this._notificationHideTimer = setTimeout(this._onNotificationHideTimeout.bind(this), this._notificationHideTimeout);
        }
    }

    /** */
    _stopHideNotificationTimer() {
        if (this._notificationHideTimer !== null) {
            clearTimeout(this._notificationHideTimer);
            this._notificationHideTimer = null;
        }
    }

    /** */
    _onNotificationHideTimeout() {
        this._notificationHideTimer = null;
        this._notification?.close(true);
    }

    /** */
    _onNotificationClick() {
        this._stopHideNotificationTimer();
    }

    /**
     * @param {MouseEvent} e
     */
    _onAudioPlayButtonContextMenu(e) {
        e.preventDefault();

        const button = /** @type {HTMLButtonElement} */ (e.currentTarget);
        const headwordIndex = this._getAudioPlayButtonHeadwordIndex(button);
        const dictionaryEntryIndex = this._display.getElementDictionaryEntryIndex(button);

        this._showAudioMenu(button, dictionaryEntryIndex, headwordIndex);
    }

    /**
     * @param {import('popup-menu').MenuCloseEvent} e
     */
    _onAudioPlayMenuCloseClick(e) {
        const button = /** @type {Element} */ (e.currentTarget);
        const headwordIndex = this._getAudioPlayButtonHeadwordIndex(button);
        const dictionaryEntryIndex = this._display.getElementDictionaryEntryIndex(button);

        const {detail: {action, item, shiftKey}} = e;
        switch (action) {
            case 'playAudioFromSource':
                if (shiftKey) {
                    e.preventDefault();
                }
                void this._playAudioFromSource(dictionaryEntryIndex, headwordIndex, item);
                break;
            case 'setPrimaryAudio':
                e.preventDefault();
                if (item !== null) {
                    this._setPrimaryAudio(dictionaryEntryIndex, headwordIndex, this._getMenuItemSourceInfo(item), true);
                }
                break;
        }
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @param {boolean} create
     * @returns {import('display-audio').CacheItem|undefined}
     */
    _getCacheItem(term, reading, create) {
        const key = this._getTermReadingKey(term, reading);
        let cacheEntry = this._cache.get(key);
        if (typeof cacheEntry !== 'undefined') {
            // Maintain LRU order using insertion order of Map.
            this._cache.delete(key);
            this._cache.set(key, cacheEntry);
            return cacheEntry;
        }
        if (create) {
            cacheEntry = {
                sourceMap: new Map(),
                primaryCardAudio: null,
            };
            this._cache.set(key, cacheEntry);
            this._evictCacheEntries();
        }
        return cacheEntry;
    }

    /** */
    _evictCacheEntries() {
        const cacheMaxSize = Math.max(1, Math.trunc(this._cacheMaxSize));
        while (this._cache.size > cacheMaxSize) {
            const oldestKey = this._cache.keys().next();
            if (oldestKey.done) { break; }
            this._cache.delete(oldestKey.value);
        }
    }

    /**
     * @param {Element} item
     * @returns {import('display-audio').SourceInfo}
     */
    _getMenuItemSourceInfo(item) {
        const group = /** @type {?HTMLElement} */ (item.closest('.popup-menu-item-group'));
        if (group !== null) {
            const {index, subIndex} = group.dataset;
            if (typeof index === 'string') {
                const indexNumber = Number.parseInt(index, 10);
                if (indexNumber >= 0 && indexNumber < this._audioSources.length) {
                    return {
                        source: this._audioSources[indexNumber],
                        subIndex: typeof subIndex === 'string' ? Number.parseInt(subIndex, 10) : null,
                    };
                }
            }
        }
        return {source: null, subIndex: null};
    }

    /**
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     * @param {import('display-audio').AudioSource[]} sources
     * @param {?number} audioInfoListIndex
     * @returns {Promise<import('display-audio').PlayAudioResult>}
     */
    async _playAudio(dictionaryEntryIndex, headwordIndex, sources, audioInfoListIndex) {
        /** @type {import('core').TokenObject} */
        const token = {};
        // Publish admission before cleanup can synchronously dispatch a stop
        // or a newer request through progress observers.
        this._stopAudio(token);
        if (this._playbackToken !== token) {
            return {audio: null, source: null, subIndex: 0, valid: false};
        }
        this.clearAutoPlayTimer();
        if (!this._canPlayAudio()) {
            this._showDataTransmissionConsentModal();
            return {audio: null, source: null, subIndex: 0, valid: false};
        }
        sources = [...sources];

        const headword = this._getHeadword(dictionaryEntryIndex, headwordIndex);
        if (headword === null) {
            return {audio: null, source: null, subIndex: 0, valid: false};
        }

        const buttons = this._getAudioPlayButtons(dictionaryEntryIndex, headwordIndex);

        const {term, reading} = headword;

        const progressIndicatorVisible = this._display.progressIndicatorVisible;
        const overrideToken = progressIndicatorVisible.setOverride(true);
        // Setting an override emits a synchronous change event. Do not retain
        // progress or start a lookup if that event already retired this request.
        if (this._playbackToken !== token) {
            progressIndicatorVisible.clearOverride(overrideToken);
            return {audio: null, source: null, subIndex: 0, valid: false};
        }
        this._playbackProgressToken = overrideToken;
        try {
            // Create audio
            let audio;
            let title;
            let source = null;
            let subIndex = 0;
            const info = await this._createTermAudio(term, reading, sources, audioInfoListIndex);
            if (this._playbackToken !== token) {
                return {audio: null, source: null, subIndex: 0, valid: false};
            }
            const valid = (info !== null);
            if (valid) {
                ({audio, source, subIndex} = info);
                const sourceIndex = sources.indexOf(source);
                title = `From source ${1 + sourceIndex}: ${source.name}`;
            } else {
                audio = this._audioSystem.getFallbackAudio(this._fallbackSoundType);
                title = 'Could not find audio';
            }

            // Update details
            const potentialAvailableAudioCount = this._getPotentialAvailableAudioCount(term, reading);
            for (const button of buttons) {
                const titleDefault = button.dataset.titleDefault || '';
                button.title = `${titleDefault}\n${title}`;
                this._updateAudioPlayButtonBadge(button, potentialAvailableAudioCount);
            }

            // Play
            audio.currentTime = 0;
            audio.volume = this._playbackVolume;

            this._audioPlaying = audio;
            this._audioPlayPending = true;
            let started = false;
            try {
                const playPromise = audio.play();
                if (typeof playPromise !== 'undefined') { await playPromise; }
                started = true;
            } catch (e) {
                // A prepared recording is not necessarily playable: native
                // play() can reject (for example until the next user gesture).
            }

            if (this._playbackToken !== token) {
                return {audio: null, source: null, subIndex: 0, valid: false};
            }
            this._audioPlayPending = false;
            if (!started) {
                this._audioPlaying = null;
                audio.pause();
                if (this._playbackToken === token) {
                    for (const button of buttons) {
                        button.title = `${button.dataset.titleDefault || ''}\nCould not play audio`;
                    }
                }
                // Do not pin an unheard recording. Keep its prepared cache
                // entry available for a later explicit playback attempt.
                return {audio: null, source: null, subIndex: 0, valid: false};
            }
            return {audio, source, subIndex, valid};
        } finally {
            this._clearPlaybackProgress(overrideToken);
        }
    }

    /**
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     * @param {?HTMLElement} item
     */
    async _playAudioFromSource(dictionaryEntryIndex, headwordIndex, item) {
        if (item === null) { return; }
        const {source, subIndex} = this._getMenuItemSourceInfo(item);
        if (source === null) { return; }

        try {
            const token = this._entriesToken;
            const primaryCardAudioToken = this._primaryCardAudioToken;
            const playPromise = this._playAudio(dictionaryEntryIndex, headwordIndex, [source], subIndex);
            const playbackToken = this._playbackToken;
            const result = await playPromise;
            if (result.valid && token === this._entriesToken && playbackToken === this._playbackToken && primaryCardAudioToken === this._primaryCardAudioToken) {
                // Menu rows may be reused while audio loads; select the recording
                // that actually played, not the row's current source/index.
                this._setPrimaryAudio(dictionaryEntryIndex, headwordIndex, result, false);
            }
        } catch (e) {
            // NOP
        }
    }

    /**
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     * @param {import('display-audio').SourceInfo} sourceInfo
     * @param {boolean} canToggleOff
     */
    _setPrimaryAudio(dictionaryEntryIndex, headwordIndex, sourceInfo, canToggleOff) {
        const {source, subIndex} = sourceInfo;
        if (source === null || !source.downloadable) { return; }

        const headword = this._getHeadword(dictionaryEntryIndex, headwordIndex);
        if (headword === null) { return; }

        const {index} = source;
        const {term, reading} = headword;
        const cacheEntry = this._getCacheItem(term, reading, true);
        if (typeof cacheEntry === 'undefined') { return; }

        let {primaryCardAudio} = cacheEntry;
        primaryCardAudio = (
            !canToggleOff ||
            primaryCardAudio === null ||
            primaryCardAudio.index !== index ||
            primaryCardAudio.subIndex !== subIndex ?
            {index: index, subIndex} :
            null
        );
        cacheEntry.primaryCardAudio = primaryCardAudio;
        this._primaryCardAudioToken = {};

        for (const menu of this._openMenus) {
            const {dataset} = menu.containerNode;
            if (dataset.term === term && dataset.reading === reading) {
                this._updateMenuPrimaryCardAudio(menu.bodyNode, term, reading);
            }
        }
    }

    /**
     * @param {Element} button
     * @returns {number}
     */
    _getAudioPlayButtonHeadwordIndex(button) {
        const headwordNode = /** @type {?HTMLElement} */ (button.closest('.headword'));
        if (headwordNode !== null) {
            const {index} = headwordNode.dataset;
            if (typeof index === 'string') {
                const headwordIndex = Number.parseInt(index, 10);
                if (Number.isFinite(headwordIndex)) { return headwordIndex; }
            }
        }
        return 0;
    }

    /**
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     * @returns {HTMLButtonElement[]}
     */
    _getAudioPlayButtons(dictionaryEntryIndex, headwordIndex) {
        const results = [];
        const {dictionaryEntryNodes} = this._display;
        if (dictionaryEntryIndex >= 0 && dictionaryEntryIndex < dictionaryEntryNodes.length) {
            const node = dictionaryEntryNodes[dictionaryEntryIndex];
            const button1 = /** @type {?HTMLButtonElement} */ ((headwordIndex === 0 ? node.querySelector('.action-button[data-action=play-audio]') : null));
            const button2 = /** @type {?HTMLButtonElement} */ (node.querySelector(`.headword:nth-of-type(${headwordIndex + 1}) .action-button[data-action=play-audio]`));
            if (button1 !== null) { results.push(button1); }
            if (button2 !== null) { results.push(button2); }
        }
        return results;
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @param {import('display-audio').AudioSource[]} sources
     * @param {?number} audioInfoListIndex
     * @returns {Promise<?import('display-audio').TermAudio>}
     */
    async _createTermAudio(term, reading, sources, audioInfoListIndex) {
        const token = this._playbackToken;
        const cacheItem = this._getCacheItem(term, reading, true);
        if (typeof cacheItem === 'undefined') { return null; }
        const {sourceMap} = cacheItem;

        for (const source of sources) {
            if (this._playbackToken !== token) { return null; }
            const {index} = source;

            let cacheUpdated = false;
            let sourceInfo = sourceMap.get(index);
            // Empty lists can also represent a provider/HTTP failure. Preserve
            // their badges, but retry discovery on a later playback request.
            if (typeof sourceInfo === 'undefined' || sourceInfo.infoList?.length === 0) {
                const infoListPromise = this._getTermAudioInfoList(source, term, reading);
                sourceInfo = {infoListPromise, infoList: null};
                sourceMap.set(index, sourceInfo);
                cacheUpdated = true;
            }

            let {infoList} = sourceInfo;
            if (infoList === null) {
                try {
                    infoList = await sourceInfo.infoListPromise;
                } catch (e) {
                    // A failed lookup must not poison later attempts. Retire only
                    // the flight observed here, never a newer cache replacement.
                    if (sourceMap.get(index) === sourceInfo) { sourceMap.delete(index); }
                    continue;
                }
                sourceInfo.infoList = infoList;
            }
            if (this._playbackToken !== token) { return null; }

            const {audio, index: subIndex, cacheUpdated: cacheUpdated2} = await this._createAudioFromInfoList(source, infoList, audioInfoListIndex);
            if (this._playbackToken !== token) { return null; }
            if (cacheUpdated || cacheUpdated2) { this._updateOpenMenu(); }
            if (audio !== null) {
                return {audio, source, subIndex};
            }
        }

        return null;
    }

    /**
     * @param {import('display-audio').AudioSource} source
     * @param {import('display-audio').AudioInfoList} infoList
     * @param {?number} audioInfoListIndex
     * @returns {Promise<import('display-audio').CreateAudioResult>}
     */
    async _createAudioFromInfoList(source, infoList, audioInfoListIndex) {
        const token = this._playbackToken;
        let start = 0;
        let end = infoList.length;
        if (audioInfoListIndex !== null) {
            start = Math.max(0, Math.min(end, audioInfoListIndex));
            end = Math.max(0, Math.min(end, audioInfoListIndex + 1));
        }

        /** @type {import('display-audio').CreateAudioResult} */
        const result = {
            audio: null,
            index: -1,
            cacheUpdated: false,
        };
        for (let i = start; i < end; ++i) {
            if (this._playbackToken !== token) { break; }
            const item = infoList[i];

            let {audio} = item;

            if (audio === null) {
                let {audioPromise} = item;
                if (audioPromise === null) {
                    audioPromise = this._createAudioFromInfo(item.info, source);
                    item.audioPromise = audioPromise;
                    item.audioResolved = false;
                }

                result.cacheUpdated = true;

                try {
                    audio = await audioPromise;
                } catch (e) {
                    // Keep the failure visible, but let a later request retry.
                    // A late observer must not retire a newer decode attempt.
                    if (item.audioPromise === audioPromise) {
                        item.audioPromise = null;
                        item.audioResolved = true;
                    }
                    continue;
                }

                if (item.audioPromise === audioPromise) {
                    item.audio = audio;
                    item.audioPromise = null;
                    item.audioResolved = true;
                }
            }

            if (audio !== null) {
                result.audio = audio;
                result.index = i;
                break;
            }
        }
        return result;
    }

    /**
     * @param {import('audio-downloader').Info} info
     * @param {import('display-audio').AudioSource} source
     * @returns {Promise<import('display-audio').GenericAudio>}
     */
    async _createAudioFromInfo(info, source) {
        switch (info.type) {
            case 'url':
                return await this._audioSystem.createAudio(info.url, source.type);
            case 'tts':
                return this._audioSystem.createTextToSpeechAudio(info.text, info.voice);
            default:
                throw new Error(`Unsupported type: ${/** @type {import('core').SafeAny} */ (info).type}`);
        }
    }

    /**
     * @param {import('display-audio').AudioSource} source
     * @param {string} term
     * @param {string} reading
     * @returns {Promise<import('display-audio').AudioInfoList>}
     */
    async _getTermAudioInfoList(source, term, reading) {
        const sourceData = this._getSourceData(source);
        const languageSummary = this._display.getLanguageSummary();
        const infoList = await this._display.application.api.getTermAudioInfoList(sourceData, term, reading, languageSummary);
        return infoList.map((info) => ({info, audioPromise: null, audioResolved: false, audio: null}));
    }

    /**
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     * @returns {?import('dictionary').TermHeadword}
     */
    _getHeadword(dictionaryEntryIndex, headwordIndex) {
        const {dictionaryEntries} = this._display;
        if (dictionaryEntryIndex < 0 || dictionaryEntryIndex >= dictionaryEntries.length) { return null; }

        const dictionaryEntry = dictionaryEntries[dictionaryEntryIndex];
        if (dictionaryEntry.type === 'kanji') { return null; }

        const {headwords} = dictionaryEntry;
        if (headwordIndex < 0 || headwordIndex >= headwords.length) { return null; }

        return headwords[headwordIndex];
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @returns {string}
     */
    _getTermReadingKey(term, reading) {
        return JSON.stringify([term, reading]);
    }

    /**
     * @param {HTMLButtonElement} button
     * @param {?number} potentialAvailableAudioCount
     */
    _updateAudioPlayButtonBadge(button, potentialAvailableAudioCount) {
        if (potentialAvailableAudioCount === null) {
            delete button.dataset.potentialAvailableAudioCount;
        } else {
            button.dataset.potentialAvailableAudioCount = `${potentialAvailableAudioCount}`;
        }

        /** @type {?HTMLElement} */
        const badge = button.querySelector('.action-button-badge');
        if (badge === null) { return; }

        const badgeData = badge.dataset;
        switch (potentialAvailableAudioCount) {
            case 0:
                badgeData.icon = 'cross';
                badge.hidden = false;
                break;
            case 1:
            case null:
                delete badgeData.icon;
                badge.hidden = true;
                break;
            default:
                badgeData.icon = 'plus-thick';
                badge.hidden = false;
                break;
        }
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @returns {?number}
     */
    _getPotentialAvailableAudioCount(term, reading) {
        const cacheEntry = this._getCacheItem(term, reading, false);
        if (typeof cacheEntry === 'undefined') { return null; }

        const {sourceMap} = cacheEntry;
        let count = 0;
        for (const {infoList} of sourceMap.values()) {
            if (infoList === null) { continue; }
            for (const {audio, audioResolved} of infoList) {
                if (!audioResolved || audio !== null) {
                    ++count;
                }
            }
        }
        return count;
    }

    /**
     * @param {HTMLButtonElement} button
     * @param {number} dictionaryEntryIndex
     * @param {number} headwordIndex
     */
    _showAudioMenu(button, dictionaryEntryIndex, headwordIndex) {
        const headword = this._getHeadword(dictionaryEntryIndex, headwordIndex);
        if (headword === null) { return; }

        const {term, reading} = headword;
        const popupMenu = this._createMenu(button, term, reading);
        this._openMenus.add(popupMenu);
        popupMenu.prepare();
        popupMenu.on('close', this._onPopupMenuClose.bind(this));
    }

    /**
     * @param {import('popup-menu').EventArgument<'close'>} details
     */
    _onPopupMenuClose({menu}) {
        this._openMenus.delete(menu);
    }

    /**
     * @param {import('settings').AudioSourceType} source
     * @returns {boolean}
     */
    _sourceIsDownloadable(source) {
        switch (source) {
            case 'text-to-speech':
            case 'text-to-speech-reading':
                return false;
            default:
                return true;
        }
    }

    /**
     * @param {HTMLButtonElement} sourceButton
     * @param {string} term
     * @param {string} reading
     * @returns {PopupMenu}
     */
    _createMenu(sourceButton, term, reading) {
        // Create menu
        const menuContainerNode = /** @type {HTMLElement} */ (this._display.displayGenerator.instantiateTemplate('audio-button-popup-menu'));
        /** @type {HTMLElement} */
        const menuBodyNode = querySelectorNotNull(menuContainerNode, '.popup-menu-body');
        menuContainerNode.dataset.term = term;
        menuContainerNode.dataset.reading = reading;

        // Set up items based on options and cache data
        this._createMenuItems(menuContainerNode, menuBodyNode, term, reading);

        // Update primary card audio display
        this._updateMenuPrimaryCardAudio(menuBodyNode, term, reading);

        // Create popup menu
        this._menuContainer.appendChild(menuContainerNode);
        return new PopupMenu(sourceButton, menuContainerNode);
    }

    /**
     * @param {HTMLElement} menuContainerNode
     * @param {HTMLElement} menuItemContainer
     * @param {string} term
     * @param {string} reading
     */
    _createMenuItems(menuContainerNode, menuItemContainer, term, reading) {
        const {displayGenerator} = this._display;
        let showIcons = false;
        const currentItems = [...menuItemContainer.children];
        for (const source of this._audioSources) {
            const {index, name, nameIndex, nameUnique, isInOptions, downloadable} = source;
            const entries = this._getMenuItemEntries(source, term, reading);
            for (let i = 0, ii = entries.length; i < ii; ++i) {
                const {valid, index: subIndex, name: subName} = entries[i];
                const existingNode = this._getOrCreateMenuItem(currentItems, index, subIndex);
                const node = existingNode !== null ? existingNode : /** @type {HTMLElement} */ (displayGenerator.instantiateTemplate('audio-button-popup-menu-item'));

                /** @type {HTMLElement} */
                const labelNode = querySelectorNotNull(node, '.popup-menu-item-audio-button .popup-menu-item-label');
                let label = name;
                if (!nameUnique) {
                    label = `${label} ${nameIndex + 1}`;
                    if (ii > 1) { label = `${label} -`; }
                }
                if (ii > 1) { label = `${label} ${i + 1}`; }
                if (typeof subName === 'string' && subName.length > 0) { label += `: ${subName}`; }
                labelNode.textContent = label;

                /** @type {HTMLElement} */
                const cardButton = querySelectorNotNull(node, '.popup-menu-item-set-primary-audio-button');
                cardButton.hidden = !downloadable;

                /** @type {HTMLElement} */
                const icon = querySelectorNotNull(node, '.popup-menu-item-audio-button .popup-menu-item-icon');
                if (valid === null) {
                    delete icon.dataset.icon;
                } else {
                    icon.dataset.icon = valid ? 'checkmark' : 'cross';
                    showIcons = true;
                }
                node.dataset.index = `${index}`;
                if (subIndex !== null) {
                    node.dataset.subIndex = `${subIndex}`;
                } else {
                    delete node.dataset.subIndex;
                }
                node.dataset.valid = `${valid}`;
                node.dataset.sourceInOptions = `${isInOptions}`;
                node.dataset.downloadable = `${downloadable}`;

                menuItemContainer.appendChild(node);
            }
        }
        for (const node of currentItems) {
            const {parentNode} = node;
            if (parentNode === null) { continue; }
            parentNode.removeChild(node);
        }
        menuContainerNode.dataset.showIcons = `${showIcons}`;
    }

    /**
     * @param {Element[]} currentItems
     * @param {number} index
     * @param {?number} subIndex
     * @returns {?HTMLElement}
     */
    _getOrCreateMenuItem(currentItems, index, subIndex) {
        const indexNumber = `${index}`;
        const subIndexNumber = `${subIndex !== null ? subIndex : 0}`;
        for (let i = 0, ii = currentItems.length; i < ii; ++i) {
            const node = currentItems[i];
            if (!(node instanceof HTMLElement) || indexNumber !== node.dataset.index) { continue; }

            let subIndex2 = node.dataset.subIndex;
            if (typeof subIndex2 === 'undefined') { subIndex2 = '0'; }
            if (subIndexNumber !== subIndex2) { continue; }

            currentItems.splice(i, 1);
            return node;
        }
        return null;
    }

    /**
     * @param {import('display-audio').AudioSource} source
     * @param {string} term
     * @param {string} reading
     * @returns {import('display-audio').MenuItemEntry[]}
     */
    _getMenuItemEntries(source, term, reading) {
        const cacheEntry = this._getCacheItem(term, reading, false);
        if (typeof cacheEntry !== 'undefined') {
            const {sourceMap} = cacheEntry;
            const sourceInfo = sourceMap.get(source.index);
            if (typeof sourceInfo !== 'undefined') {
                const {infoList} = sourceInfo;
                if (infoList !== null) {
                    const ii = infoList.length;
                    if (ii === 0) {
                        return [{valid: false, index: null, name: null}];
                    }

                    /** @type {import('display-audio').MenuItemEntry[]} */
                    const results = [];
                    for (let i = 0; i < ii; ++i) {
                        const {audio, audioResolved, info: {name}} = infoList[i];
                        const valid = audioResolved ? (audio !== null) : null;
                        const entry = {valid, index: i, name: typeof name === 'string' ? name : null};
                        results.push(entry);
                    }
                    return results;
                }
            }
        }
        return [{valid: null, index: null, name: null}];
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @returns {?import('display-audio').PrimaryCardAudio}
     */
    _getPrimaryCardAudio(term, reading) {
        const cacheEntry = this._getCacheItem(term, reading, false);
        return typeof cacheEntry !== 'undefined' ? cacheEntry.primaryCardAudio : null;
    }

    /**
     * @param {HTMLElement} menuBodyNode
     * @param {string} term
     * @param {string} reading
     */
    _updateMenuPrimaryCardAudio(menuBodyNode, term, reading) {
        const primaryCardAudio = this._getPrimaryCardAudio(term, reading);
        const primaryCardAudioIndex = (primaryCardAudio !== null ? primaryCardAudio.index : null);
        const primaryCardAudioSubIndex = (primaryCardAudio !== null ? primaryCardAudio.subIndex : null);
        const itemGroups = /** @type {NodeListOf<HTMLElement>} */ (menuBodyNode.querySelectorAll('.popup-menu-item-group'));
        for (const node of itemGroups) {
            const {index, subIndex} = node.dataset;
            if (typeof index !== 'string') { continue; }
            const indexNumber = Number.parseInt(index, 10);
            const subIndexNumber = typeof subIndex === 'string' ? Number.parseInt(subIndex, 10) : null;
            const isPrimaryCardAudio = (indexNumber === primaryCardAudioIndex && subIndexNumber === primaryCardAudioSubIndex);
            node.dataset.isPrimaryCardAudio = `${isPrimaryCardAudio}`;
        }
    }

    /** */
    _closeOpenMenus() {
        for (const menu of this._openMenus) { menu.close(false); }
        this._openMenus.clear();
    }

    /** */
    _updateOpenMenu() {
        for (const menu of this._openMenus) {
            const menuContainerNode = menu.containerNode;
            const {term, reading} = menuContainerNode.dataset;
            if (typeof term === 'string' && typeof reading === 'string') {
                this._createMenuItems(menuContainerNode, menu.bodyNode, term, reading);
                this._updateMenuPrimaryCardAudio(menu.bodyNode, term, reading);
                menu.updateMenuItems();
            }
            menu.updatePosition();
        }
    }

    /**
     * @param {import('display-audio').AudioSource} source
     * @returns {import('display-audio').AudioSourceShort}
     */
    _getSourceData(source) {
        const {type, url, voice} = source;
        return {type, url, voice};
    }
}
