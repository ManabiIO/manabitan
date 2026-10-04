/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {EventListenerCollection} from '../core/event-listener-collection.js';
import {log} from '../core/log.js';
import {promiseAnimationFrame} from '../core/promise-animation-frame.js';
import {safePerformance} from '../core/safe-performance.js';
import {setProfile} from '../data/profiles-util.js';
import {addFullscreenChangeEventListener, getFullscreenElement} from '../dom/document-util.js';
import {TextSourceElement} from '../dom/text-source-element.js';
import {TextSourceGenerator} from '../dom/text-source-generator.js';
import {TextSourceRange} from '../dom/text-source-range.js';
import {TextScanner} from '../language/text-scanner.js';

const JAPANESE_TEXT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]+/g;
const JAPANESE_PARTICLE_BOUNDARY_PATTERN = /[はがをにへでとものや]/u;

/** @typedef {{timer: ?import('core').Timeout, resolveDelay: ?(() => void)}} DelayedSelectionClearRequest */

/**
 * This is the main class responsible for scanning and handling webpage content.
 */
export class Frontend {
    /**
     * Creates a new instance.
     * @param {import('frontend').ConstructorDetails} details Details about how to set up the instance.
     */
    constructor({
        application,
        pageType,
        popupFactory,
        depth,
        parentPopupId,
        parentFrameId,
        useProxyPopup,
        canUseWindowPopup = true,
        allowRootFramePopupProxy,
        childrenSupported = true,
        hotkeyHandler,
        browser,
    }) {
        /** @type {import('../application.js').Application} */
        this._application = application;
        /** @type {import('frontend').PageType} */
        this._pageType = pageType;
        /** @type {import('./popup-factory.js').PopupFactory} */
        this._popupFactory = popupFactory;
        /** @type {number} */
        this._depth = depth;
        /** @type {?string} */
        this._parentPopupId = parentPopupId;
        /** @type {?number} */
        this._parentFrameId = parentFrameId;
        /** @type {boolean} */
        this._useProxyPopup = useProxyPopup;
        /** @type {boolean} */
        this._canUseWindowPopup = canUseWindowPopup;
        /** @type {boolean} */
        this._allowRootFramePopupProxy = allowRootFramePopupProxy;
        /** @type {boolean} */
        this._childrenSupported = childrenSupported;
        /** @type {import('../input/hotkey-handler.js').HotkeyHandler} */
        this._hotkeyHandler = hotkeyHandler;
        /** @type {?import('popup').PopupAny} */
        this._popup = null;
        /** @type {boolean} */
        this._disabledOverride = false;
        /** @type {?import('settings').ProfileOptions} */
        this._options = null;
        /** @type {?object} */
        this._optionsUpdateToken = null;
        /** @type {?Promise<void>} */
        this._optionsUpdatePromise = null;
        /** @type {?Promise<void>} */
        this._preparePromise = null;
        /** @type {boolean} */
        this._prepared = false;
        /** @type {boolean} */
        this._preparing = false;
        /** @type {?AggregateError} */
        this._prepareCleanupError = null;
        /** @type {boolean} */
        this._siteSpecificPrepared = false;
        /** @type {number} */
        this._pageZoomFactor = 1;
        /** @type {number} */
        this._contentScale = 1;
        /** @type {Promise<void>} */
        this._lastShowPromise = Promise.resolve();
        /** @type {?Promise<void>} */
        this._popupPrewarmPromise = null;
        /** @type {?Promise<void>} */
        this._lookupPrewarmPromise = null;
        /** @type {?string} */
        this._popupContentPrewarmTerm = null;
        /** @type {TextSourceGenerator} */
        this._textSourceGenerator = new TextSourceGenerator();
        /** @type {TextScanner} */
        this._textScanner = new TextScanner({
            api: application.api,
            node: window,
            ignoreElements: this._ignoreElements.bind(this),
            ignorePoint: this._ignorePoint.bind(this),
            getSearchContext: this._getSearchContext.bind(this),
            searchTerms: true,
            searchKanji: true,
            textSourceGenerator: this._textSourceGenerator,
            browser: browser,
        });
        /** @type {boolean} */
        this._textScannerHasBeenEnabled = false;
        /** @type {Map<'default'|'window'|'iframe'|'proxy', Promise<?import('popup').PopupAny>>} */
        this._popupCache = new Map();
        /** @type {EventListenerCollection} */
        this._popupEventListeners = new EventListenerCollection();
        /** @type {?import('core').TokenObject} */
        this._updatePopupToken = null;
        /** @type {?DelayedSelectionClearRequest} */
        this._clearSelectionRequest = null;
        /** @type {boolean} */
        this._isPointerOverPopup = false;
        /** @type {?import('settings').OptionsContext} */
        this._optionsContextOverride = null;
        /** @type {number} */
        this._debugSearchSuccessCount = 0;
        /** @type {number} */
        this._debugSearchEmptyCount = 0;
        /** @type {boolean} */
        this._dictionaryUpdateSearchActive = false;
        /** @type {boolean} */
        this._optionsUpdateSearchActive = false;
        /** @type {number} */
        this._optionsUpdateSearchCount = 0;
        /** @type {number} */
        this._dictionaryUpdateSearchCount = 0;

        /* eslint-disable @stylistic/no-multi-spaces */
        /** @type {import('application').ApiMap} */
        this._runtimeApiMap = createApiMap([
            ['frontendRequestReadyBroadcast',   this._onMessageRequestFrontendReadyBroadcast.bind(this)],
            ['frontendSetAllVisibleOverride',   this._onApiSetAllVisibleOverride.bind(this)],
            ['frontendClearAllVisibleOverride', this._onApiClearAllVisibleOverride.bind(this)],
            ['frontendScanSelectedText',        this._onApiScanSelectedText.bind(this)],
        ]);

        /* eslint-enable @stylistic/no-multi-spaces */
    }

    /**
     * Get whether or not the text selection can be cleared.
     * @type {boolean}
     */
    get canClearSelection() {
        return this._textScanner.canClearSelection;
    }

    /**
     * Set whether or not the text selection can be cleared.
     * @param {boolean} value The new value to assign.
     */
    set canClearSelection(value) {
        this._textScanner.canClearSelection = value;
    }

    /**
     * Gets the popup instance.
     * @type {?import('popup').PopupAny}
     */
    get popup() {
        return this._popup;
    }

    /**
     * Prepares the instance for use.
     * @returns {Promise<void>}
     */
    prepare() {
        if (this._prepareCleanupError !== null) { return Promise.reject(this._prepareCleanupError); }
        if (this._prepared) { return Promise.resolve(); }
        if (this._preparePromise !== null) { return this._preparePromise; }
        const promise = this._prepareInternal().finally(() => {
            if (this._preparePromise === promise) { this._preparePromise = null; }
        });
        this._preparePromise = promise;
        return promise;
    }

    /** @returns {Promise<void>} */
    async _prepareInternal() {
        const listeners = new EventListenerCollection();
        /** @type {(() => void)[]} */
        const cleanups = [() => listeners.removeAllEventListeners(), () => this._textScanner.setEnabled(false)];
        this._preparing = true;
        try {
            this._updatePageDebugState({prepareStarted: true});
            let optionsPromise = this.updateOptions();
            for (;;) {
                try {
                    await optionsPromise;
                } catch (error) {
                    if (this._optionsUpdatePromise === optionsPromise) { throw error; }
                }
                if (this._optionsUpdatePromise === optionsPromise) { break; }
                optionsPromise = /** @type {Promise<void>} */ (this._optionsUpdatePromise);
            }
            try {
                const {zoomFactor} = await this._application.api.getZoom();
                this._pageZoomFactor = zoomFactor;
            } catch (e) {
                // Ignore exceptions which may occur due to being on an unsupported page (e.g. about:blank)
            }

            this._textScanner.prepare();

            listeners.addEventListener(window, 'resize', this._onResize.bind(this), false);
            addFullscreenChangeEventListener(() => {
                void this._updatePopup().catch((e) => { log.error(e); });
            }, listeners);

            const {visualViewport} = window;
            if (typeof visualViewport !== 'undefined' && visualViewport !== null) {
                listeners.addEventListener(visualViewport, 'scroll', this._onVisualViewportScroll.bind(this));
                listeners.addEventListener(visualViewport, 'resize', this._onVisualViewportResize.bind(this));
            }

            listeners.on(this._application, 'optionsUpdated', this._onOptionsUpdated.bind(this));
            listeners.on(this._application, 'zoomChanged', this._onZoomChanged.bind(this));
            listeners.on(this._application, 'closePopups', this._onClosePopups.bind(this));
            listeners.on(this._application, 'databaseUpdated', this._onDatabaseUpdated.bind(this));
            listeners.addListener(chrome.runtime.onMessage, this._onRuntimeMessage.bind(this));

            listeners.on(this._textScanner, 'clear', this._onTextScannerClear.bind(this));
            listeners.on(this._textScanner, 'searchSuccess', this._onSearchSuccess.bind(this));
            listeners.on(this._textScanner, 'searchEmpty', this._onSearchEmpty.bind(this));
            listeners.on(this._textScanner, 'searchError', this._onSearchError.bind(this));

            /* eslint-disable @stylistic/no-multi-spaces */
            cleanups.push(this._application.crossFrame.registerHandlersScoped([
                ['frontendClosePopup',       this._onApiClosePopup.bind(this)],
                ['frontendCopySelection',    this._onApiCopySelection.bind(this)],
                ['frontendGetPopupSelectionText', this._onApiGetPopupSelectionText.bind(this)],
                ['frontendGetPopupInfo',     this._onApiGetPopupInfo.bind(this)],
                ['frontendGetPageInfo',      this._onApiGetPageInfo.bind(this)],
            ]));
            /* eslint-enable @stylistic/no-multi-spaces */

            this._prepareSiteSpecific();
            this._updateContentScale();
            this._preparing = false;
            this._prepared = true;
            this._updateTextScannerEnabled();
            cleanups.push(this._hotkeyHandler.registerActionsScoped([
                ['scanSelectedText', this._onActionScanSelectedText.bind(this)],
                ['scanTextAtSelection', this._onActionScanTextAtSelection.bind(this)],
                ['scanTextAtCaret', this._onActionScanTextAtCaret.bind(this)],
                ['profilePrevious', async () => { await setProfile(-1, this._application); }],
                ['profileNext', async () => { await setProfile(1, this._application); }],
            ]));
            this._updatePageDebugState({prepared: true});
            this._signalFrontendReady(null);
        } catch (error) {
            this._prepared = false;
            this._preparing = false;
            this._optionsUpdateToken = null;
            this._updatePopupToken = null;
            const errors = [error];
            for (const cleanup of cleanups.reverse()) {
                try {
                    cleanup();
                } catch (cleanupError) {
                    errors.push(cleanupError);
                }
            }
            if (errors.length > 1) {
                this._prepareCleanupError = new AggregateError(errors, 'Frontend preparation cleanup failed');
                throw this._prepareCleanupError;
            }
            throw error;
        }
    }

    /**
     * Set whether or not the instance is disabled.
     * @param {boolean} disabled Whether or not the instance is disabled.
     */
    setDisabledOverride(disabled) {
        this._disabledOverride = disabled;
        this._updateTextScannerEnabled();
    }

    /**
     * Set or clear an override options context object.
     * @param {?import('settings').OptionsContext} optionsContext An options context object to use as the override, or `null` to clear the override.
     */
    setOptionsContextOverride(optionsContext) {
        this._optionsContextOverride = optionsContext;
    }

    /**
     * Performs a new search on a specific source.
     * @param {import('text-source').TextSource} textSource The text source to search.
     */
    async setTextSource(textSource) {
        this._textScanner.setCurrentTextSource(null);
        await this._textScanner.search(textSource, null, false, true);
    }

    /**
     * Updates the internal options representation.
     * @param {boolean} [suppressSearchLast]
     * @returns {Promise<void>}
     */
    updateOptions(suppressSearchLast = false) {
        const promise = this._updateOptionsInternal(suppressSearchLast).catch((e) => {
            if (!this._application.webExtension.unloaded) {
                throw e;
            }
        });
        this._optionsUpdatePromise = promise;
        return promise;
    }

    /**
     * Waits for the previous `showContent` call to be completed.
     * @returns {Promise<void>} A promise which is resolved when the previous `showContent` call has completed.
     */
    showContentCompleted() {
        return this._lastShowPromise;
    }

    // Message handlers

    /** @type {import('application').ApiHandler<'frontendRequestReadyBroadcast'>} */
    _onMessageRequestFrontendReadyBroadcast({frameId}) {
        this._signalFrontendReady(frameId);
    }

    // Action handlers

    /**
     * @returns {void}
     */
    _onActionScanSelectedText() {
        void this._scanSelectedText(false, true);
    }

    /**
     * @returns {void}
     */
    _onApiScanSelectedText() {
        void this._scanSelectedText(false, true, true);
    }

    /**
     * @returns {void}
     */
    _onActionScanTextAtSelection() {
        void this._scanSelectedText(false, false);
    }

    /**
     * @returns {void}
     */
    _onActionScanTextAtCaret() {
        void this._scanSelectedText(true, false);
    }

    // API message handlers

    /** @type {import('cross-frame-api').ApiHandler<'frontendClosePopup'>} */
    _onApiClosePopup() {
        this._textScanner.cancelPendingSearches();
        this._clearSelection(false);
    }

    /** @type {import('cross-frame-api').ApiHandler<'frontendCopySelection'>} */
    _onApiCopySelection() {
        // This will not work on Firefox if a popup has focus, which is usually the case when this function is called.
        document.execCommand('copy');
    }

    /** @type {import('cross-frame-api').ApiHandler<'frontendGetPopupSelectionText'>} */
    _onApiGetPopupSelectionText() {
        const selection = document.getSelection();
        return selection !== null ? selection.toString() : '';
    }

    /** @type {import('cross-frame-api').ApiHandler<'frontendGetPopupInfo'>} */
    _onApiGetPopupInfo() {
        return {
            popupId: (this._popup !== null ? this._popup.id : null),
        };
    }

    /** @type {import('cross-frame-api').ApiHandler<'frontendGetPageInfo'>} */
    _onApiGetPageInfo() {
        return {
            url: window.location.href,
            documentTitle: document.title,
        };
    }

    /** @type {import('application').ApiHandler<'frontendSetAllVisibleOverride'>} */
    async _onApiSetAllVisibleOverride({value, priority, awaitFrame}) {
        const result = await this._popupFactory.setAllVisibleOverride(value, priority);
        if (awaitFrame) {
            await promiseAnimationFrame(100);
        }
        return result;
    }

    /** @type {import('application').ApiHandler<'frontendClearAllVisibleOverride'>} */
    async _onApiClearAllVisibleOverride({token}) {
        return await this._popupFactory.clearAllVisibleOverride(token);
    }

    // Private

    /**
     * @returns {void}
     */
    _onResize() {
        void this._updatePopupPosition();
    }

    /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
    _onRuntimeMessage({action, params}, _sender, callback) {
        return invokeApiMapHandler(this._runtimeApiMap, action, params, [], callback);
    }

    /**
     * @param {{newZoomFactor: number}} params
     */
    _onZoomChanged({newZoomFactor}) {
        this._pageZoomFactor = newZoomFactor;
        this._updateContentScale();
    }

    /**
     * @returns {void}
     */
    _onClosePopups() {
        this._textScanner.cancelPendingSearches();
        this._clearSelection(true);
        this._clearMousePosition();
    }

    /**
     * @returns {Promise<void>}
     */
    async _onOptionsUpdated() {
        this._updatePageDebugState({lastSearchState: 'options-updated'});
        this._optionsUpdateSearchCount = (this._optionsUpdateSearchCount ?? 0) + 1;
        let token;
        try {
            this._optionsUpdateSearchActive = true;
            const promise = this.updateOptions();
            token = this._optionsUpdateToken;
            await promise;
        } catch (error) {
            if (this._optionsUpdateToken !== token) { return; }
            if (!this._application.webExtension.unloaded) {
                log.error(error);
            }
            this._clearSelection(true);
            this._clearMousePosition();
        } finally {
            this._optionsUpdateSearchActive = (--this._optionsUpdateSearchCount > 0);
        }
    }

    /**
     * @param {import('application').EventArgument<'databaseUpdated'>} details
     * @returns {Promise<void>}
     */
    async _onDatabaseUpdated({type}) {
        if (type !== 'dictionary') { return; }
        this._updatePageDebugState({lastSearchState: 'dictionary-updated'});
        this._dictionaryUpdateSearchCount = (this._dictionaryUpdateSearchCount ?? 0) + 1;
        let token;
        try {
            this._dictionaryUpdateSearchActive = true;
            const promise = this.updateOptions(true);
            token = this._optionsUpdateToken;
            await promise;
            if (this._optionsUpdateToken !== token) { return; }
            this._startPopupPrewarmForHover();
            if (await this._textScanner.searchLast()) {
                return;
            }
            if (this._optionsUpdateToken !== token) { return; }
        } catch (error) {
            if (this._optionsUpdateToken !== token) { return; }
            if (!this._application.webExtension.unloaded) {
                log.error(error);
            }
        } finally {
            this._dictionaryUpdateSearchActive = (--this._dictionaryUpdateSearchCount > 0);
        }
        this._clearSelection(true);
        this._clearMousePosition();
    }

    /**
     * @returns {void}
     */
    _onVisualViewportScroll() {
        void this._updatePopupPosition();
    }

    /**
     * @returns {void}
     */
    _onVisualViewportResize() {
        this._updateContentScale();
    }

    /**
     * @returns {void}
     */
    _onTextScannerClear() {
        this._updatePageDebugState({lastSearchState: 'cleared'});
        this._clearSelection(false);
    }

    /**
     * @param {import('text-scanner').EventArgument<'searchSuccess'>} details
     */
    _onSearchSuccess({type, dictionaryEntries, dictionaryAvailability, sentence, inputInfo: {eventType, detail: inputInfoDetail}, textSource, optionsContext, detail, pageTheme}) {
        this._debugSearchSuccessCount += 1;
        const searchSuccessAt = safePerformance.now();
        this._updatePageDebugState({
            lastSearchState: 'success',
            lastSearchEventType: eventType,
            lastSearchResultCount: dictionaryEntries.length,
            searchSuccessCount: this._debugSearchSuccessCount,
            lastSearchSuccessAt: Math.round(searchSuccessAt),
        });
        this._stopClearSelectionDelayed();
        let focus = (eventType === 'mouseMove');
        if (typeof inputInfoDetail === 'object' && inputInfoDetail !== null) {
            const focus2 = inputInfoDetail.focus;
            if (typeof focus2 === 'boolean') { focus = focus2; }
        }
        this._showContent(textSource, focus, dictionaryEntries, type, sentence, detail !== null ? detail.documentTitle : null, optionsContext, pageTheme, searchSuccessAt, dictionaryAvailability);
    }

    /** */
    _onSearchEmpty() {
        this._debugSearchEmptyCount += 1;
        this._updatePageDebugState({
            lastSearchState: 'empty',
            searchEmptyCount: this._debugSearchEmptyCount,
        });
        if (this._dictionaryUpdateSearchActive || this._optionsUpdateSearchActive) {
            this._clearSelection(true);
            this._clearMousePosition();
            return;
        }
        const scanningOptions = /** @type {import('settings').ProfileOptions} */ (this._options).scanning;
        if (scanningOptions.autoHideResults) {
            void this._clearSelectionDelayed(scanningOptions.hideDelay, false, false);
        }
    }

    /**
     * @param {import('text-scanner').EventArgument<'searchError'>} details
     */
    _onSearchError({error, textSource, inputInfo: {passive}}) {
        this._updatePageDebugState({
            lastSearchState: 'error',
            lastSearchError: error instanceof Error ? error.message : `${error}`,
        });
        if (this._application.webExtension.unloaded) {
            if (textSource !== null && !passive) {
                this._showExtensionUnloaded(textSource);
            }
        } else {
            log.error(error);
        }
    }

    /**
     * @returns {void}
     */
    _onPopupFramePointerOver() {
        this._isPointerOverPopup = true;
    }

    /**
     * @returns {void}
     */
    _onPopupFramePointerOut() {
        this._isPointerOverPopup = false;
        if (!this._options) { return; }
        const {scanning: {hidePopupOnCursorExit, hidePopupOnCursorExitDelay}} = this._options;
        if (hidePopupOnCursorExit) {
            void this._clearSelectionDelayed(hidePopupOnCursorExitDelay, false, false);
        }
    }

    /**
     * @param {boolean} passive
     */
    _clearSelection(passive) {
        this._stopClearSelectionDelayed();
        if (this._popup !== null) {
            void this._popup.clearAutoPlayTimer();
            void this._popup.hide(!passive);
            this._isPointerOverPopup = false;
        }
        this._textScanner.clearSelection();
    }

    /** */
    _clearMousePosition() {
        this._textScanner.clearMousePosition();
    }

    /**
     * Checks if the pointer is over any popup in the hierarchy (parent or child popups).
     * @returns {Promise<boolean>}
     * @private
     */
    async _isPointerOverAnyPopup() {
        if (this._isPointerOverPopup) {
            return true;
        }

        let childPopup = this._popup?.child;
        while (typeof childPopup !== 'undefined' && childPopup !== null) {
            try {
                const isOver = childPopup.isPointerOver();
                if (isOver) {
                    return true;
                }
                childPopup = childPopup.child;
            } catch (e) {
                log.warn(new Error('Error checking child popup pointer state'));
            }
        }

        let parentPopup = this._popup?.parent;
        while (typeof parentPopup !== 'undefined' && parentPopup !== null) {
            try {
                const isOver = parentPopup.isPointerOver();
                if (isOver) {
                    return true;
                }
                parentPopup = parentPopup.parent;
            } catch (e) {
                log.warn(new Error('Error checking parent popup pointer state'));
            }
        }

        return false;
    }

    /**
     * @param {number} delay
     * @param {boolean} restart
     * @param {boolean} passive
     */
    async _clearSelectionDelayed(delay, restart, passive) {
        if (!this._textScanner.hasSelection()) { return; }
        if (this._clearSelectionRequest !== null && !restart) { return; }
        this._stopClearSelectionDelayed();
        /** @type {DelayedSelectionClearRequest} */
        const request = {timer: null, resolveDelay: null};
        this._clearSelectionRequest = request;
        try {
            // Allow mouseover events to settle, but keep this wait cancellation-owned too.
            await this._waitForClearSelectionDelay(50, request);
            if (this._clearSelectionRequest !== request || !this._textScanner.hasSelection()) { return; }
            if (await this._isPointerOverAnyPopup() || this._clearSelectionRequest !== request) { return; }

            if (delay > 0) {
                await this._waitForClearSelectionDelay(delay, request);
                if (this._clearSelectionRequest !== request || !this._textScanner.hasSelection()) { return; }
                if (await this._isPointerOverAnyPopup() || this._clearSelectionRequest !== request) { return; }
            }
            this._clearSelection(passive);
        } catch (error) {
            if (this._clearSelectionRequest !== request) { return; }
            try {
                log.error(error);
            } catch (e) {
                // Automatic hiding must not leak a rejection if error reporting also fails.
            }
        } finally {
            if (this._clearSelectionRequest === request) { this._stopClearSelectionDelayed(); }
        }
    }

    /**
     * @param {number} delay
     * @param {DelayedSelectionClearRequest} request
     * @returns {Promise<void>}
     */
    _waitForClearSelectionDelay(delay, request) {
        return new Promise((resolve) => {
            request.resolveDelay = resolve;
            request.timer = setTimeout(() => {
                request.timer = null;
                request.resolveDelay = null;
                resolve();
            }, delay);
        });
    }

    /**
     * @returns {void}
     */
    _stopClearSelectionDelayed() {
        const request = this._clearSelectionRequest;
        this._clearSelectionRequest = null;
        if (request === null) { return; }
        if (request.timer !== null) { clearTimeout(request.timer); }
        const resolve = request.resolveDelay;
        request.timer = null;
        request.resolveDelay = null;
        if (resolve !== null) { resolve(); }
    }

    /**
     * @param {boolean} [suppressSearchLast]
     * @returns {Promise<void>}
     */
    async _updateOptionsInternal(suppressSearchLast = false) {
        const token = {};
        this._optionsUpdateToken = token;
        this._updatePopupToken = null;
        try {
            const optionsContext = await this._getOptionsContext();
            if (this._optionsUpdateToken !== token) { return; }
            const options = await this._application.api.optionsGet(optionsContext);
            if (this._optionsUpdateToken !== token) { return; }
            const {scanning: scanningOptions, sentenceParsing: sentenceParsingOptions} = options;
            this._options = options;

            this._hotkeyHandler.setHotkeys('web', options.inputs.hotkeys);

            await this._updatePopup(optionsContext, token);
            if (this._optionsUpdateToken !== token) { return; }

            const preventMiddleMouseOnPage = this._getPreventSecondaryMouseValueForPageType(scanningOptions.preventMiddleMouse);
            const preventMiddleMouseOnTextHover = scanningOptions.preventMiddleMouse.onTextHover;
            const preventBackForwardOnPage = this._getPreventSecondaryMouseValueForPageType(scanningOptions.preventBackForward);
            const preventBackForwardOnTextHover = scanningOptions.preventBackForward.onTextHover;
            this._textScanner.language = options.general.language;
            this._textScanner.setOptions({
                inputs: scanningOptions.inputs,
                deepContentScan: scanningOptions.deepDomScan,
                normalizeCssZoom: scanningOptions.normalizeCssZoom,
                selectText: scanningOptions.selectText,
                delay: scanningOptions.delay,
                scanLength: scanningOptions.length,
                layoutAwareScan: scanningOptions.layoutAwareScan,
                preventMiddleMouseOnPage,
                preventMiddleMouseOnTextHover,
                preventBackForwardOnPage,
                preventBackForwardOnTextHover,
                sentenceParsingOptions,
                scanWithoutMousemove: scanningOptions.scanWithoutMousemove,
                scanResolution: scanningOptions.scanResolution,
            });
            this._updateTextScannerEnabled();
            this._updatePageDebugState({
                optionsLoaded: true,
                generalEnabled: options.general.enable,
                scanningDelay: scanningOptions.delay,
                scanWithoutMousemove: scanningOptions.scanWithoutMousemove,
                popupWindow: options.general.usePopupWindow,
            });

            if (this._pageType !== 'web') {
                const excludeSelectors = ['.scan-disable', '.scan-disable *'];
                if (!scanningOptions.enableOnPopupExpressions) {
                    excludeSelectors.push('.source-text', '.source-text *');
                }
                this._textScanner.excludeSelector = excludeSelectors.join(',');
                this._textScanner.touchEventExcludeSelector = '.gloss-link, .gloss-link *, .tag, .tag *, .inflection';
            }

            this._updateContentScale();
            this._startPopupPrewarmForHover();

            if (!suppressSearchLast) {
                await this._textScanner.searchLast();
            }
        } catch (error) {
            if (this._optionsUpdateToken === token) { throw error; }
        }
    }

    /**
     * @returns {void}
     */
    _startPopupPrewarmForHover() {
        this._startLookupPrewarmForHover();
        if (this._popupPrewarmPromise !== null) { return; }
        this._popupPrewarmPromise = this._prewarmPopupForHover();
        void this._popupPrewarmPromise.finally(() => {
            this._popupPrewarmPromise = null;
        });
    }

    /**
     * @returns {void}
     */
    _startLookupPrewarmForHover() {
        if (this._lookupPrewarmPromise !== null) { return; }
        this._lookupPrewarmPromise = this._prewarmLookupForHover();
        void this._lookupPrewarmPromise.finally(() => {
            this._lookupPrewarmPromise = null;
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async _prewarmLookupForHover() {
        const options = this._options;
        if (
            options === null ||
            !options.general.enable ||
            !this._textScanner.isEnabled()
        ) {
            return;
        }

        const startedAt = safePerformance.now();
        this._updatePageDebugState({
            lookupPrewarmRequested: true,
            lookupPrewarmSettled: false,
            lookupPrewarmLastError: null,
        });
        try {
            const optionsContext = await this._getOptionsContext();
            const initialPrewarmTerms = this._getInitialLookupPrewarmTerms();
            let prewarmTerms = initialPrewarmTerms;
            let {firstMatchedResultPromise, resultsPromise} = this._runLookupPrewarmTerms(initialPrewarmTerms, optionsContext);
            let firstMatchedResult = await firstMatchedResultPromise;
            if (firstMatchedResult === null) {
                let lookupResults = await resultsPromise;
                const knownTerms = new Set(initialPrewarmTerms);
                const dictionaryProbeTerms = (await this._getDictionaryLookupPrewarmTerms(options))
                    .filter((term) => !knownTerms.has(term));
                if (dictionaryProbeTerms.length > 0) {
                    prewarmTerms = [...initialPrewarmTerms, ...dictionaryProbeTerms];
                    ({firstMatchedResultPromise, resultsPromise} = this._runLookupPrewarmTerms(dictionaryProbeTerms, optionsContext));
                    firstMatchedResult = await firstMatchedResultPromise;
                    lookupResults = [...lookupResults, ...await resultsPromise];
                }
                resultsPromise = Promise.resolve(lookupResults);
            }
            if (firstMatchedResult !== null) {
                const popupPrewarmPromise = this._popupPrewarmPromise;
                if (popupPrewarmPromise !== null) {
                    await popupPrewarmPromise;
                }
                await this._prewarmPopupContentForHover(firstMatchedResult.term, firstMatchedResult.dictionaryEntries, optionsContext);
                this._updatePageDebugState({
                    lookupPrewarmReady: true,
                    lookupPrewarmResultCount: firstMatchedResult.dictionaryEntries.length,
                    lookupPrewarmTermCount: prewarmTerms.length,
                    lookupPrewarmMatchedTerm: firstMatchedResult.term,
                    lookupPrewarmMatchedTermCount: 1,
                    lookupPrewarmSettled: true,
                    lookupPrewarmWaitMs: Math.round(safePerformance.now() - startedAt),
                });
            }
            const lookupResults = await resultsPromise;
            let resultCount = 0;
            /** @type {string[]} */
            const matchedTerms = [];
            for (const {term, dictionaryEntries} of lookupResults) {
                resultCount += dictionaryEntries.length;
                if (dictionaryEntries.length > 0) {
                    matchedTerms.push(term);
                }
            }
            const allWaitMs = Math.round(safePerformance.now() - startedAt);
            /** @type {Record<string, string|number|boolean|null|undefined>} */
            const finalPrewarmState = {
                lookupPrewarmReady: resultCount > 0,
                lookupPrewarmResultCount: resultCount,
                lookupPrewarmTermCount: prewarmTerms.length,
                lookupPrewarmMatchedTerm: matchedTerms[0] || '',
                lookupPrewarmMatchedTermCount: matchedTerms.length,
                lookupPrewarmSettled: true,
                lookupPrewarmAllSettled: true,
                lookupPrewarmAllWaitMs: allWaitMs,
            };
            if (firstMatchedResult === null) {
                finalPrewarmState.lookupPrewarmWaitMs = allWaitMs;
            }
            this._updatePageDebugState(finalPrewarmState);
        } catch (e) {
            this._updatePageDebugState({
                lookupPrewarmReady: false,
                lookupPrewarmSettled: true,
                lookupPrewarmWaitMs: Math.round(safePerformance.now() - startedAt),
                lookupPrewarmLastError: e instanceof Error ? e.message : `${e}`,
            });
            log.error(e);
        }
    }

    /**
     * @param {string[]} terms
     * @param {import('settings').OptionsContext} optionsContext
     * @returns {{firstMatchedResultPromise: Promise<?{term: string, dictionaryEntries: import('dictionary').DictionaryEntry[]}>, resultsPromise: Promise<Array<{term: string, dictionaryEntries: import('dictionary').DictionaryEntry[]}>>}}
     */
    _runLookupPrewarmTerms(terms, optionsContext) {
        /** @type {Array<{term: string, dictionaryEntries: import('dictionary').DictionaryEntry[]}>} */
        const results = [];
        /** @type {(value: ?{term: string, dictionaryEntries: import('dictionary').DictionaryEntry[]}) => void} */
        let resolveFirstMatchedResult = () => {};
        const firstMatchedResultPromise = /** @type {Promise<?{term: string, dictionaryEntries: import('dictionary').DictionaryEntry[]}>} */ (new Promise((resolve) => {
            resolveFirstMatchedResult = resolve;
        }));

        const resultsPromise = (async () => {
            let matched = false;
            for (const term of terms) {
                /** @type {import('dictionary').DictionaryEntry[]} */
                let dictionaryEntries = [];
                try {
                    ({dictionaryEntries} = await this._application.api.termsFind(term, {}, optionsContext));
                } catch (_) {
                    // Best-effort prewarm; visible lookup correctness does not depend on probes.
                }
                results.push({term, dictionaryEntries});
                if (dictionaryEntries.length > 0) {
                    matched = true;
                    resolveFirstMatchedResult({term, dictionaryEntries});
                    break;
                }
            }
            if (!matched) {
                resolveFirstMatchedResult(null);
            }
            return results;
        })();
        return {firstMatchedResultPromise, resultsPromise};
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {Promise<string[]>}
     */
    async _getLookupPrewarmTerms(options) {
        return this._normalizeLookupPrewarmTerms([
            ...this._getInitialLookupPrewarmTerms(),
            ...await this._getDictionaryLookupPrewarmTerms(options),
        ]);
    }

    /**
     * @returns {string[]}
     */
    _getInitialLookupPrewarmTerms() {
        return this._normalizeLookupPrewarmTerms([
            ...this._getPageLookupPrewarmTerms(),
            '日本',
            'する',
            'ある',
            '見る',
        ]);
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {Promise<string[]>}
     */
    async _getDictionaryLookupPrewarmTerms(options) {
        /** @type {string[]} */
        const terms = [];
        const probeTimeout = 125;
        const maxProbeDictionaries = 4;
        const dictionaries = options.dictionaries
            .filter(({name, enabled}) => enabled && name.length > 0)
            .slice(0, maxProbeDictionaries);
        for (const {name} of dictionaries) {
            try {
                /** @type {Promise<import('dictionary-database').DictionaryTermProbe|null>} */
                const probePromise = this._application.api.getDictionaryTermProbe(name);
                /** @type {Promise<null>} */
                const timeoutPromise = new Promise((resolve) => {
                    setTimeout(() => { resolve(null); }, probeTimeout);
                });
                const probe = await Promise.race([probePromise, timeoutPromise]);
                if (probe !== null) {
                    terms.push(probe.expression, probe.reading);
                }
            } catch (_) {
                // Best-effort prewarm; visible lookup correctness does not depend on probes.
            }
        }
        return this._normalizeLookupPrewarmTerms(terms);
    }

    /**
     * @param {string[]} terms
     * @returns {string[]}
     */
    _normalizeLookupPrewarmTerms(terms) {
        return [...new Set(terms.map((term) => `${term}`).filter((term) => term.length > 0))];
    }

    /**
     * @returns {string[]}
     */
    _getPageLookupPrewarmTerms() {
        /** @type {string[]} */
        const terms = [];
        const ignoredParentNames = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        const deadline = safePerformance.now() + 8;
        let visitedNodeCount = 0;
        while (terms.length < 6 && visitedNodeCount < 2000 && safePerformance.now() < deadline) {
            const node = walker.nextNode();
            if (node === null) { break; }
            ++visitedNodeCount;
            const parent = node.parentElement;
            if (parent === null || ignoredParentNames.has(parent.tagName) || parent.closest('[hidden],[aria-hidden="true"]') !== null) {
                continue;
            }
            const text = node.textContent || '';
            JAPANESE_TEXT_PATTERN.lastIndex = 0;
            for (const match of text.matchAll(JAPANESE_TEXT_PATTERN)) {
                const term = this._getPrimaryPageLookupPrewarmTerm(match[0].slice(0, 12));
                if (term.length > 0) {
                    terms.push(term);
                    if (terms.length >= 6) { break; }
                }
            }
        }
        return terms;
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    _getPrimaryPageLookupPrewarmTerm(text) {
        for (let i = 2; i < text.length; ++i) {
            if (JAPANESE_PARTICLE_BOUNDARY_PATTERN.test(text[i])) {
                return text.slice(0, i);
            }
        }
        return text;
    }

    /**
     * @param {string} term
     * @param {import('dictionary').DictionaryEntry[]} dictionaryEntries
     * @param {import('settings').OptionsContext} optionsContext
     * @returns {Promise<void>}
     */
    async _prewarmPopupContentForHover(term, dictionaryEntries, optionsContext) {
        const popup = this._popup;
        if (
            this._popupContentPrewarmTerm === term ||
            popup === null ||
            dictionaryEntries.length === 0 ||
            typeof Reflect.get(popup, 'prewarmContent') !== 'function'
        ) {
            return;
        }

        const startedAt = safePerformance.now();
        this._updatePageDebugState({
            popupContentPrewarmRequested: true,
            popupContentPrewarmSettled: false,
            popupContentPrewarmLastError: null,
        });
        try {
            const {tabId, frameId} = this._application;
            /** @type {import('display').ContentDetails} */
            const details = {
                focus: false,
                historyMode: 'clear',
                params: {
                    type: 'terms',
                    query: term,
                    wildcards: 'off',
                    lookup: 'false',
                },
                state: {
                    focusEntry: 0,
                    optionsContext,
                    url: optionsContext.url,
                    pageTheme: 'light',
                },
                content: {
                    dictionaryEntries,
                    contentOrigin: {tabId, frameId},
                },
            };
            await /** @type {{prewarmContent: (details: import('display').ContentDetails) => Promise<void>}} */ (popup).prewarmContent(details);
            this._popupContentPrewarmTerm = term;
            this._updatePageDebugState({
                popupContentPrewarmReady: true,
                popupContentPrewarmSettled: true,
                popupContentPrewarmTerm: term,
                popupContentPrewarmResultCount: dictionaryEntries.length,
                popupContentPrewarmWaitMs: Math.round(safePerformance.now() - startedAt),
            });
        } catch (e) {
            this._updatePageDebugState({
                popupContentPrewarmReady: false,
                popupContentPrewarmSettled: true,
                popupContentPrewarmWaitMs: Math.round(safePerformance.now() - startedAt),
                popupContentPrewarmLastError: e instanceof Error ? e.message : `${e}`,
            });
            log.error(e);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _prewarmPopupForHover() {
        const popup = this._popup;
        const options = this._options;
        if (
            popup === null ||
            options === null ||
            !options.general.enable ||
            options.general.usePopupWindow ||
            !this._textScanner.isEnabled() ||
            typeof popup.prepareFrame !== 'function'
        ) {
            return;
        }

        const timeout = 8000;
        const startedAt = safePerformance.now();
        this._updatePageDebugState({
            popupPrewarmRequested: true,
            popupPrewarmSettled: false,
            popupPrewarmTimedOut: false,
            popupPrewarmLastError: null,
        });
        try {
            /** @type {Promise<boolean>} */
            const timeoutPromise = new Promise((resolve) => {
                setTimeout(() => { resolve(true); }, timeout);
            });
            const timedOut = await Promise.race([
                popup.prepareFrame().then(() => false),
                timeoutPromise,
            ]);
            this._updatePageDebugState({
                popupPrewarmSettled: !timedOut,
                popupPrewarmTimedOut: timedOut,
                popupPrewarmWaitMs: Math.round(safePerformance.now() - startedAt),
            });
        } catch (e) {
            this._updatePageDebugState({
                popupPrewarmSettled: true,
                popupPrewarmTimedOut: false,
                popupPrewarmWaitMs: Math.round(safePerformance.now() - startedAt),
                popupPrewarmLastError: e instanceof Error ? e.message : `${e}`,
            });
            log.error(e);
        }
    }

    /**
     * @param {import('settings').OptionsContext} [requestedContext]
     * @param {object} [optionsToken]
     * @returns {Promise<void>}
     */
    async _updatePopup(requestedContext, optionsToken) {
        if (optionsToken && this._optionsUpdateToken !== optionsToken) { return; }
        const {usePopupWindow, showIframePopupsInRootFrame} = /** @type {import('settings').ProfileOptions} */ (this._options).general;
        const isIframe = !this._useProxyPopup && (window !== window.parent);

        const currentPopup = this._popup;

        /** @type {Promise<?import('popup').PopupAny>|undefined} */
        let popupPromise;
        if (usePopupWindow && this._canUseWindowPopup) {
            popupPromise = this._popupCache.get('window');
            if (typeof popupPromise === 'undefined') {
                popupPromise = this._getPopupWindow();
                popupPromise = this._cachePopup('window', popupPromise);
            }
        } else if (
            isIframe &&
            showIframePopupsInRootFrame &&
            getFullscreenElement() === null &&
            this._allowRootFramePopupProxy
        ) {
            popupPromise = this._popupCache.get('iframe');
            if (typeof popupPromise === 'undefined') {
                popupPromise = this._getIframeProxyPopup();
                popupPromise = this._cachePopup('iframe', popupPromise);
            }
        } else if (this._useProxyPopup) {
            popupPromise = this._popupCache.get('proxy');
            if (typeof popupPromise === 'undefined') {
                popupPromise = this._getProxyPopup();
                popupPromise = this._cachePopup('proxy', popupPromise);
            }
        } else {
            popupPromise = this._popupCache.get('default');
            if (typeof popupPromise === 'undefined') {
                popupPromise = this._getDefaultPopup();
                popupPromise = this._cachePopup('default', popupPromise);
            }
        }

        /**
         * The token below is used as a unique identifier to ensure that a new _updatePopup call
         * hasn't been started during the await.
         * @type {?import('core').TokenObject}
         */
        const token = {};
        this._updatePopupToken = token;
        const popup = await popupPromise;
        const optionsContext = requestedContext ?? await this._getOptionsContext();
        if (optionsToken && this._optionsUpdateToken !== optionsToken) { return; }
        if (this._updatePopupToken !== token) { return; }
        if (popup !== null) {
            await popup.setOptionsContext(optionsContext);
        }
        if (this._updatePopupToken !== token) { return; }

        if (popup !== currentPopup) {
            this._clearSelection(true);
        }

        this._popupEventListeners.removeAllEventListeners();
        this._popup = popup;
        if (popup !== null) {
            this._popupEventListeners.on(popup, 'mouseOver', this._onPopupFramePointerOver.bind(this));
            this._popupEventListeners.on(popup, 'mouseOut', this._onPopupFramePointerOut.bind(this));
        }
        this._isPointerOverPopup = false;
    }

    /**
     * @param {'default'|'window'|'iframe'|'proxy'} key
     * @param {Promise<?import('popup').PopupAny>} pending
     * @returns {Promise<?import('popup').PopupAny>}
     */
    _cachePopup(key, pending) {
        const promise = pending.catch((error) => {
            if (this._popupCache.get(key) === promise) { this._popupCache.delete(key); }
            throw error;
        });
        this._popupCache.set(key, promise);
        return promise;
    }

    /**
     * @returns {Promise<?import('popup').PopupAny>}
     */
    async _getDefaultPopup() {
        const isXmlDocument = (typeof XMLDocument !== 'undefined' && document instanceof XMLDocument);
        if (isXmlDocument) {
            return null;
        }

        const {frameId} = this._application;
        if (frameId === null) {
            return null;
        }

        return await this._popupFactory.getOrCreatePopup({
            frameId,
            depth: this._depth,
            childrenSupported: this._childrenSupported,
        });
    }

    /**
     * @returns {Promise<import('popup').PopupAny>}
     */
    async _getProxyPopup() {
        return await this._popupFactory.getOrCreatePopup({
            frameId: this._parentFrameId,
            depth: this._depth,
            parentPopupId: this._parentPopupId,
            childrenSupported: this._childrenSupported,
        });
    }

    /**
     * @returns {Promise<?import('popup').PopupAny>}
     */
    async _getIframeProxyPopup() {
        const targetFrameId = 0; // Root frameId
        try {
            await this._waitForFrontendReady(targetFrameId, 10000);
        } catch (e) {
            // Root frame not available
            return await this._getDefaultPopup();
        }

        const {popupId} = await this._application.crossFrame.invoke(targetFrameId, 'frontendGetPopupInfo', void 0);
        if (popupId === null) {
            return null;
        }

        const popup = await this._popupFactory.getOrCreatePopup({
            frameId: targetFrameId,
            id: popupId,
            childrenSupported: this._childrenSupported,
        });
        popup.on('offsetNotFound', () => {
            this._allowRootFramePopupProxy = false;
            void this._updatePopup().catch((error) => { log.error(error); });
        });
        return popup;
    }

    /**
     * @returns {Promise<import('popup').PopupAny>}
     */
    async _getPopupWindow() {
        return await this._popupFactory.getOrCreatePopup({
            depth: this._depth,
            popupWindow: true,
            childrenSupported: this._childrenSupported,
        });
    }

    /**
     * @returns {Element[]}
     */
    _ignoreElements() {
        if (this._popup !== null) {
            const container = this._popup.container;
            if (container !== null) {
                return [container];
            }
        }
        return [];
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {Promise<boolean>}
     */
    async _ignorePoint(x, y) {
        try {
            return this._popup !== null && await this._popup.containsPoint(x, y);
        } catch (e) {
            if (!this._application.webExtension.unloaded) {
                throw e;
            }
            return false;
        }
    }

    /**
     * @param {import('text-source').TextSource} textSource
     */
    _showExtensionUnloaded(textSource) {
        void this._showPopupContent(textSource, null, null);
    }

    /**
     * @param {import('text-source').TextSource} textSource
     * @param {boolean} focus
     * @param {?import('dictionary').DictionaryEntry[]} dictionaryEntries
     * @param {import('display').PageType} type
     * @param {?import('display').HistoryStateSentence} sentence
     * @param {?string} documentTitle
     * @param {import('settings').OptionsContext} optionsContext
     * @param {'dark' | 'light'} pageTheme
     * @param {number} searchSuccessAt
     * @param {import('translator').DictionaryAvailability[]} [dictionaryAvailability]
     */
    _showContent(textSource, focus, dictionaryEntries, type, sentence, documentTitle, optionsContext, pageTheme, searchSuccessAt = safePerformance.now(), dictionaryAvailability) {
        const query = textSource.text();
        const {url} = optionsContext;
        /** @type {import('display').HistoryState} */
        const detailsState = {
            focusEntry: 0,
            optionsContext,
            url,
            pageTheme,
        };
        if (sentence !== null) { detailsState.sentence = sentence; }
        if (documentTitle !== null) { detailsState.documentTitle = documentTitle; }
        const {tabId, frameId} = this._application;
        /** @type {import('display').HistoryParams} */
        const params = {
            type,
            query,
            wildcards: 'off',
        };
        /** @type {import('display').HistoryContent} */
        const detailsContent = {
            contentOrigin: {tabId, frameId},
            ...(dictionaryAvailability?.length ? {dictionaryAvailability} : {}),
        };
        if (dictionaryEntries !== null) {
            detailsContent.dictionaryEntries = dictionaryEntries;
            params.lookup = 'false';
        }
        /** @type {import('display').ContentDetails} */
        const details = {
            focus,
            historyMode: 'clear',
            params,
            state: detailsState,
            content: detailsContent,
        };
        if (textSource instanceof TextSourceElement && textSource.fullContent !== query) {
            details.params.full = textSource.fullContent;
            details.params['full-visible'] = 'true';
        }
        void this._showPopupContent(textSource, optionsContext, details, searchSuccessAt);
    }

    /**
     * @param {import('text-source').TextSource} textSource
     * @param {?import('settings').OptionsContext} optionsContext
     * @param {?import('display').ContentDetails} details
     * @param {number} searchSuccessAt
     * @returns {Promise<void>}
     */
    _showPopupContent(textSource, optionsContext, details, searchSuccessAt = safePerformance.now()) {
        const showRequestedAt = safePerformance.now();
        this._updatePageDebugState({
            popupShowRequestedAt: Math.round(showRequestedAt),
            popupShowRequestDelayMs: Math.round(showRequestedAt - searchSuccessAt),
            popupShowSettled: false,
            popupShowDurationMs: null,
        });
        const sourceRects = [];
        for (const {left, top, right, bottom} of textSource.getRects()) {
            sourceRects.push({left, top, right, bottom});
        }
        const showPromise = (
            this._popup !== null ?
            this._popup.showContent(
                {
                    optionsContext,
                    sourceRects,
                    writingMode: textSource.getWritingMode(),
                },
                details,
            ) :
            Promise.resolve()
        );
        this._lastShowPromise = showPromise;
        void showPromise.then(
            () => {
                if (this._lastShowPromise !== showPromise) { return; }
                this._updatePageDebugState({
                    popupShowSettled: true,
                    popupShowDurationMs: Math.round(safePerformance.now() - showRequestedAt),
                });
            },
            (error) => {
                if (details !== null && this._lastShowPromise === showPromise) {
                    this._textScanner.allowCurrentTextSourceRetry(textSource);
                }
                if (this._application.webExtension.unloaded) { return; }
                log.error(error);
            },
        );
        return showPromise;
    }

    /**
     * @returns {void}
     */
    _updateTextScannerEnabled() {
        const enabled = (this._prepared && this._options !== null && this._options.general.enable && !this._disabledOverride && !this._preparing);
        if (enabled === this._textScanner.isEnabled()) { return; }
        this._textScanner.setEnabled(enabled);
        this._updatePageDebugState({scannerEnabled: enabled});
        if (this._textScannerHasBeenEnabled) {
            this._clearSelection(true);
        }
        if (enabled) {
            this._textScannerHasBeenEnabled = true;
            this._startPopupPrewarmForHover();
        }
    }

    /**
     * @returns {void}
     */
    _updateContentScale() {
        const {popupScalingFactor, popupScaleRelativeToPageZoom, popupScaleRelativeToVisualViewport} = /** @type {import('settings').ProfileOptions} */ (this._options).general;
        let contentScale = popupScalingFactor;
        if (popupScaleRelativeToPageZoom) {
            contentScale /= this._pageZoomFactor;
        }
        if (popupScaleRelativeToVisualViewport) {
            const {visualViewport} = window;
            const visualViewportScale = (typeof visualViewport !== 'undefined' && visualViewport !== null ? visualViewport.scale : 1);
            contentScale /= visualViewportScale;
        }
        if (contentScale === this._contentScale) { return; }

        this._contentScale = contentScale;
        if (this._popup !== null) {
            void this._popup.setContentScale(this._contentScale);
        }
        void this._updatePopupPosition();
    }

    /**
     * @returns {Promise<void>}
     */
    async _updatePopupPosition() {
        const textSource = this._textScanner.getCurrentTextSource();
        const popup = this._popup;
        const showPromise = this._lastShowPromise;
        if (textSource === null || popup === null) { return; }
        // A position-only show supersedes popup content delivery too. Wait for
        // that delivery rather than allowing resize/scroll to cancel it.
        try {
            await showPromise;
        } catch (e) {
            // The content request owns error reporting; do not show its old DOM.
            return;
        }
        if (!this._isPopupPositionRequestCurrent(textSource, popup, showPromise)) { return; }
        try {
            if (!await popup.isVisible()) { return; }
            if (!this._isPopupPositionRequestCurrent(textSource, popup, showPromise)) { return; }
            void this._showPopupContent(textSource, null, null);
        } catch (error) {
            if (!this._isPopupPositionRequestCurrent(textSource, popup, showPromise) || this._application.webExtension.unloaded) { return; }
            log.error(error);
        }
    }

    /**
     * @param {import('text-source').TextSource} textSource
     * @param {import('popup').PopupAny} popup
     * @param {Promise<void>} showPromise
     * @returns {boolean}
     */
    _isPopupPositionRequestCurrent(textSource, popup, showPromise) {
        return this._lastShowPromise === showPromise && this._popup === popup && this._textScanner.getCurrentTextSource() === textSource;
    }

    /**
     * @param {?number} targetFrameId
     */
    _signalFrontendReady(targetFrameId) {
        this._updatePageDebugState({frontendReadyBroadcasted: true});
        /** @type {import('application').ApiMessageNoFrameId<'frontendReady'>} */
        const message = {action: 'frontendReady', params: {frameId: this._application.frameId}};
        if (targetFrameId === null) {
            void this._application.api.broadcastTab(message).catch((e) => { log.error(e); });
        } else {
            void this._application.api.sendMessageToFrame(targetFrameId, message).catch((e) => { log.error(e); });
        }
    }

    /**
     * @param {number} frameId
     * @param {?number} timeout
     * @returns {Promise<void>}
     */
    async _waitForFrontendReady(frameId, timeout) {
        return new Promise((resolve, reject) => {
            /** @type {?import('core').Timeout} */
            let timeoutId = null;

            const cleanup = () => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                chrome.runtime.onMessage.removeListener(onMessage);
            };
            /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
            const onMessage = (message, _sender, sendResponse) => {
                try {
                    const {action} = message;
                    if (action === 'frontendReady' && message.params.frameId === frameId) {
                        cleanup();
                        resolve();
                        sendResponse();
                    }
                } catch (e) {
                    // NOP
                }
            };

            if (timeout !== null) {
                timeoutId = setTimeout(() => {
                    timeoutId = null;
                    cleanup();
                    reject(new Error(`Wait for frontend ready timed out after ${timeout}ms`));
                }, timeout);
            }

            chrome.runtime.onMessage.addListener(onMessage);
            void this._application.api.broadcastTab({action: 'frontendRequestReadyBroadcast', params: {frameId: this._application.frameId}});
        });
    }

    /**
     * @param {import('settings').PreventSecondaryMouseOptions} preventSecondaryMouseOptions
     * @returns {boolean}
     */
    _getPreventSecondaryMouseValueForPageType(preventSecondaryMouseOptions) {
        switch (this._pageType) {
            case 'web': return preventSecondaryMouseOptions.onWebPages;
            case 'popup': return preventSecondaryMouseOptions.onPopupPages;
            case 'search': return preventSecondaryMouseOptions.onSearchPages;
        }
    }

    /**
     * @returns {Promise<import('settings').OptionsContext>}
     */
    async _getOptionsContext() {
        let optionsContext = this._optionsContextOverride;
        if (optionsContext === null) {
            optionsContext = (await this._getSearchContext()).optionsContext;
        }
        return optionsContext;
    }

    /**
     * @returns {Promise<import('text-scanner').SearchContext>}
     */
    async _getSearchContext() {
        let url = window.location.href;
        let documentTitle = document.title;
        if (this._useProxyPopup && this._parentFrameId !== null) {
            try {
                ({url, documentTitle} = await this._application.crossFrame.invoke(this._parentFrameId, 'frontendGetPageInfo', void 0));
            } catch (e) {
                // NOP
            }
        }

        let optionsContext = this._optionsContextOverride;
        if (optionsContext === null) {
            optionsContext = {depth: this._depth, url};
        }

        return {
            optionsContext,
            detail: {documentTitle},
        };
    }

    /**
     * @param {boolean} allowEmptyRange
     * @param {boolean} disallowExpandSelection
     * @param {boolean} showEmpty show empty popup if no results are found
     * @returns {Promise<boolean>}
     */
    async _scanSelectedText(allowEmptyRange, disallowExpandSelection, showEmpty = false) {
        safePerformance.mark('frontend:scanSelectedText:start');
        const range = this._getFirstSelectionRange(allowEmptyRange);
        if (range === null) { return false; }
        const source = disallowExpandSelection ? TextSourceRange.createLazy(range) : TextSourceRange.create(range);
        await this._textScanner.search(source, {focus: true, restoreSelection: true}, showEmpty);
        safePerformance.mark('frontend:scanSelectedText:end');
        safePerformance.measure('frontend:scanSelectedText', 'frontend:scanSelectedText:start', 'frontend:scanSelectedText:end');
        return true;
    }

    /**
     * @param {boolean} allowEmptyRange
     * @returns {?Range}
     */
    _getFirstSelectionRange(allowEmptyRange) {
        const selection = window.getSelection();
        if (selection === null) { return null; }
        for (let i = 0, ii = selection.rangeCount; i < ii; ++i) {
            const range = selection.getRangeAt(i);
            if (range.toString().length > 0 || allowEmptyRange) {
                return range;
            }
        }
        return null;
    }

    /**
     * @returns {void}
     */
    _prepareSiteSpecific() {
        if (this._siteSpecificPrepared) { return; }
        switch (location.hostname.toLowerCase()) {
            case 'docs.google.com':
                void this._prepareGoogleDocs().catch((e) => { log.error(e); });
                break;
        }
        this._siteSpecificPrepared = true;
    }

    /**
     * @returns {Promise<void>}
     */
    async _prepareGoogleDocs() {
        const {GoogleDocsUtil} = await import('../accessibility/google-docs-util.js');
        const googleDocsUtil = new GoogleDocsUtil();
        this._textSourceGenerator.registerGetRangeFromPointHandler(googleDocsUtil.getRangeFromPoint.bind(googleDocsUtil));
    }

    /**
     * @param {Record<string, string|number|boolean|null|undefined>} values
     * @returns {void}
     */
    _updatePageDebugState(values) {
        const {documentElement} = document;
        if (documentElement === null) { return; }
        for (const [key, value] of Object.entries(values)) {
            const datasetKey = `manabitan${key.slice(0, 1).toUpperCase()}${key.slice(1)}`;
            if (value === null || typeof value === 'undefined') {
                delete documentElement.dataset[datasetKey];
            } else {
                documentElement.dataset[datasetKey] = `${value}`;
            }
        }
    }
}
