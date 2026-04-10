/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {isObjectNotArray} from '../core/object-utilities.js';
import {arrayBufferToBase64, base64ToArrayBuffer} from '../data/array-buffer-util.js';

/**
 * This class is responsible for creating and communicating with an offscreen document.
 * This offscreen document is used to solve three issues:
 *
 * - Provide clipboard access for the `ClipboardReader` class in the context of a MV3 extension.
 *   The background service workers doesn't have access a webpage to read the clipboard from,
 *   so it must be done in the offscreen page.
 *
 * - Create a worker for image rendering, which both selects the images from the database,
 *   decodes/rasterizes them, and then sends (= postMessage transfers) them back to a worker
 *   in the popup to be rendered onto OffscreenCanvas.
 *
 * - Provide a longer lifetime for the dictionary database. The background service worker can be
 *   terminated by the web browser, which means that when it restarts, it has to go through its
 *   initialization process again. This initialization process can take a non-trivial amount of
 *   time, which is primarily caused by the startup of the IndexedDB database, especially when a
 *   large amount of dictionary data is installed.
 *
 *   The offscreen document stays alive longer, potentially forever, which may be an artifact of
 *   the clipboard access it requests in the `reasons` parameter. Therefore, this initialization
 *   process should only take place once, or at the very least, less frequently than the service
 *   worker.
 *
 *   The long lifetime of the offscreen document is not guaranteed by the spec, which could
 *   result in this code functioning poorly in the future if a web browser vendor changes the
 *   APIs or the implementation substantially, and this is even referenced on the Chrome
 *   developer website.
 * @see https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
 * @see https://developer.chrome.com/docs/extensions/reference/api/offscreen
 */
export class OffscreenProxy {
    /**
     * @param {import('../extension/web-extension.js').WebExtension} webExtension
     */
    constructor(webExtension) {
        /** @type {import('../extension/web-extension.js').WebExtension} */
        this._webExtension = webExtension;
        /** @type {?Promise<void>} */
        this._creatingOffscreen = null;

        /** @type {?MessagePort} */
        this._currentOffscreenPort = null;
        /** @type {?Promise<void>} */
        this._registeringOffscreenPort = null;
        /** @type {Promise<void>} */
        this._offscreenPortReadyPromise = Promise.resolve();
        /** @type {null|(() => void)} */
        this._resolveOffscreenPortReady = null;
        this._resetOffscreenPortReadyPromise();
    }

    /**
     * @see https://developer.chrome.com/docs/extensions/reference/offscreen/
     */
    async prepare() {
        if (await this._hasOffscreenDocument()) {
            await this._ensureOffscreenPort();
            return;
        }
        if (this._creatingOffscreen) {
            await this._creatingOffscreen;
            return;
        }
        this._creatingOffscreen = (async () => {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: [
                    /** @type {chrome.offscreen.Reason} */ ('CLIPBOARD'),
                ],
                justification: 'Access to the clipboard',
            });
            await this._ensureOffscreenPort();
        })();
        try {
            await this._creatingOffscreen;
        } finally {
            this._creatingOffscreen = null;
        }
    }

    /**
     * @returns {void}
     */
    _resetOffscreenPortReadyPromise() {
        this._offscreenPortReadyPromise = new Promise((resolve) => {
            this._resolveOffscreenPortReady = resolve;
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureOffscreenPort() {
        if (this._currentOffscreenPort !== null) {
            return;
        }
        if (this._registeringOffscreenPort !== null) {
            await this._registeringOffscreenPort;
            return;
        }
        this._registeringOffscreenPort = (async () => {
            await this.sendMessagePromise({action: 'createAndRegisterPortOffscreen'});
            await Promise.race([
                this._offscreenPortReadyPromise,
                new Promise((resolve, reject) => {
                    setTimeout(() => reject(new Error('Timed out waiting for offscreen control port registration')), 5000);
                }),
            ]);
        })();
        try {
            await this._registeringOffscreenPort;
        } finally {
            this._registeringOffscreenPort = null;
        }
    }

    /**
     * @param {MessagePort} port
     * @returns {void}
     */
    _clearCurrentOffscreenPort(port) {
        if (this._currentOffscreenPort !== port) {
            return;
        }
        this._currentOffscreenPort = null;
        this._resetOffscreenPortReadyPromise();
        try {
            port.close();
        } catch (_) {
            // Ignore close failures for dead ports.
        }
    }

    /**
     * @returns {Promise<boolean>}
     */
    async _hasOffscreenDocument() {
        const offscreenUrl = chrome.runtime.getURL('offscreen.html');
        if (!chrome.runtime.getContexts) { // Chrome version below 116
            // Clients: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/clients
            // @ts-expect-error - Types not set up for service workers yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const matchedClients = await clients.matchAll();
            // @ts-expect-error - Types not set up for service workers yet
            return await matchedClients.some((client) => client.url === offscreenUrl);
        }

        const contexts = await chrome.runtime.getContexts({
            contextTypes: [
                /** @type {chrome.runtime.ContextType} */ ('OFFSCREEN_DOCUMENT'),
            ],
            documentUrls: [offscreenUrl],
        });
        return contexts.length > 0;
    }

    /**
     * @template {import('offscreen').ApiNames} TMessageType
     * @param {import('offscreen').ApiMessage<TMessageType>} message
     * @returns {Promise<import('offscreen').ApiReturn<TMessageType>>}
     */
    async sendMessagePromise(message) {
        const response = await this._webExtension.sendMessagePromise(message);
        return this._getMessageResponseResult(/** @type {import('core').Response<import('offscreen').ApiReturn<TMessageType>>} */ (response));
    }

    /**
     * @template [TReturn=unknown]
     * @param {import('core').Response<TReturn>} response
     * @returns {TReturn}
     * @throws {Error}
     */
    _getMessageResponseResult(response) {
        const runtimeError = chrome.runtime.lastError;
        if (typeof runtimeError !== 'undefined') {
            throw new Error(runtimeError.message);
        }
        if (!isObjectNotArray(response)) {
            throw new Error('Offscreen document did not respond');
        }
        const responseError = response.error;
        if (responseError) {
            throw ExtensionError.deserialize(responseError);
        }
        return response.result;
    }

    /**
     * @param {MessagePort} port
     */
    async registerOffscreenPort(port) {
        port.onmessageerror = () => {
            this._clearCurrentOffscreenPort(port);
        };
        if (this._currentOffscreenPort && this._currentOffscreenPort !== port) {
            try {
                this._currentOffscreenPort.close();
            } catch (_) {
                // Ignore close failures while rotating the control port.
            }
        }
        this._currentOffscreenPort = port;
        this._resolveOffscreenPortReady?.();
        this._resolveOffscreenPortReady = null;
    }

    /**
     * When you need to transfer Transferable objects, you can use this method which uses postMessage over the MessageChannel port established with the offscreen document.
     * @template {import('offscreen').McApiNames} TMessageType
     * @param {import('offscreen').McApiMessage<TMessageType>} message
     * @param {Transferable[]} transfers
     */
    async sendMessageViaPort(message, transfers) {
        await this._ensureOffscreenPort();
        const port = this._currentOffscreenPort;
        if (port === null) {
            throw new Error('Offscreen control port is unavailable');
        }
        try {
            port.postMessage(message, transfers);
        } catch (_) {
            this._clearCurrentOffscreenPort(port);
            await this._ensureOffscreenPort();
            const retriedPort = this._currentOffscreenPort;
            if (retriedPort === null) {
                throw new Error('Offscreen control port is unavailable');
            }
            retriedPort.postMessage(message, transfers);
        }
    }
}

/**
 * @typedef {{
 *   sendMessagePromise: (message: import('offscreen').ApiMessageAny) => Promise<unknown>,
 *   sendMessageViaPort: (message: import('offscreen').McApiMessageAny, transfers: Transferable[]) => Promise<void>
 * }} DictionaryRuntimeMessenger
 */

export class DictionaryRuntimeWorkerProxy {
    /**
     * @param {string} workerPath
     */
    constructor(workerPath) {
        /** @type {Worker} */
        this._worker = new Worker(workerPath, {type: 'module'});
        /** @type {Map<number, {resolve: (value: unknown) => void, reject: (reason?: unknown) => void}>} */
        this._responseHandlers = new Map();
        /** @type {number} */
        this._requestId = 0;
        /** @type {Error|null} */
        this._fatalError = null;
        this._worker.addEventListener('message', this._onMessage.bind(this));
        this._worker.addEventListener('messageerror', this._onMessageError.bind(this));
        this._worker.addEventListener('error', this._onError.bind(this));
    }

    /**
     * @param {Error} error
     * @returns {void}
     */
    _setFatalError(error) {
        if (this._fatalError !== null) {
            return;
        }
        this._fatalError = error;
        for (const [, handler] of this._responseHandlers) {
            handler.reject(error);
        }
        this._responseHandlers.clear();
        try {
            this._worker.terminate();
        } catch (_) {
            // Ignore termination failures after a fatal worker error.
        }
    }

    /**
     * @template [TReturn=unknown]
     * @param {import('offscreen').ApiMessageAny} message
     * @returns {Promise<TReturn>}
     */
    async sendMessagePromise(message) {
        if (this._fatalError !== null) {
            throw this._fatalError;
        }
        const id = ++this._requestId;
        return await new Promise((resolve, reject) => {
            this._responseHandlers.set(id, {
                resolve: /** @type {(value: unknown) => void} */ (resolve),
                reject,
            });
            const payload = /** @type {{action?: string, params?: unknown}} */ (
                typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}
            );
            try {
                this._worker.postMessage({id, action: payload.action ?? '', params: payload.params ?? {}});
            } catch (error) {
                this._responseHandlers.delete(id);
                const normalizedError = error instanceof Error ? error : new Error(String(error));
                this._setFatalError(normalizedError);
                reject(normalizedError);
            }
        });
    }

    /**
     * @param {import('offscreen').McApiMessageAny} message
     * @param {Transferable[]} transfers
     */
    async sendMessageViaPort(message, transfers) {
        if (this._fatalError !== null) {
            throw this._fatalError;
        }
        const payload = /** @type {{action?: string, params?: unknown}} */ (
            typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}
        );
        try {
            this._worker.postMessage({id: ++this._requestId, action: payload.action ?? '', params: payload.params ?? {}}, transfers);
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            this._setFatalError(normalizedError);
            throw normalizedError;
        }
    }

    /**
     * @param {MessageEvent<{id?: number, result?: unknown, error?: import('core').SerializedError}>} event
     */
    _onMessage(event) {
        const id = typeof event.data?.id === 'number' ? event.data.id : null;
        if (id === null) { return; }
        const handler = this._responseHandlers.get(id);
        if (typeof handler === 'undefined') { return; }
        this._responseHandlers.delete(id);
        if (typeof event.data?.error !== 'undefined') {
            handler.reject(ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (event.data.error)));
            return;
        }
        handler.resolve(event.data?.result);
    }

    /**
     * @param {MessageEvent} _event
     */
    _onMessageError(_event) {
        this._setFatalError(new Error('Dictionary runtime worker message deserialization failed'));
    }

    /**
     * @param {ErrorEvent} event
     */
    _onError(event) {
        const message = event.message ? `: ${event.message}` : '';
        this._setFatalError(new Error(`Dictionary runtime worker failed${message}`));
    }
}

export class DictionaryDatabaseProxy {
    /**
     * @param {DictionaryRuntimeMessenger} offscreen
     */
    constructor(offscreen) {
        /** @type {DictionaryRuntimeMessenger} */
        this._offscreen = offscreen;
        /** @type {boolean} */
        this._isPrepared = false;
        /** @type {boolean} */
        this._usesFallbackStorage = false;
        /** @type {unknown} */
        this._openStorageDiagnostics = null;
    }

    /**
     * @returns {Promise<void>}
     */
    async _refreshRuntimeState() {
        const state = /** @type {{isPrepared?: boolean, usesFallbackStorage?: boolean, openStorageDiagnostics?: unknown}|null} */ (
            await this._offscreen.sendMessagePromise({action: 'getDatabaseRuntimeStateOffscreen'})
        );
        this._isPrepared = state?.isPrepared === true;
        this._usesFallbackStorage = state?.usesFallbackStorage === true;
        this._openStorageDiagnostics = state?.openStorageDiagnostics ?? null;
    }

    /**
     * @returns {Promise<void>}
     */
    async prepare() {
        await this._offscreen.sendMessagePromise({action: 'databasePrepareOffscreen'});
        await this._refreshRuntimeState();
    }

    /**
     * @returns {Promise<void>}
     */
    async refreshConnection() {
        await this._offscreen.sendMessagePromise({action: 'databaseRefreshOffscreen'});
        await this._refreshRuntimeState();
    }

    /**
     * @param {boolean} suspended
     * @returns {Promise<void>}
     */
    async setSuspended(suspended) {
        await this._offscreen.sendMessagePromise({action: 'databaseSetSuspendedOffscreen', params: {suspended}});
        await this._refreshRuntimeState();
    }

    /**
     * @returns {boolean}
     */
    isPrepared() {
        return this._isPrepared;
    }

    /**
     * @returns {boolean}
     */
    usesFallbackStorage() {
        return this._usesFallbackStorage;
    }

    /**
     * @returns {unknown}
     */
    getOpenStorageDiagnostics() {
        if (this._openStorageDiagnostics === null || typeof this._openStorageDiagnostics !== 'object') {
            return null;
        }
        return {.../** @type {Record<string, unknown>} */ (this._openStorageDiagnostics)};
    }

    /**
     * @returns {Promise<import('dictionary-importer').Summary[]>}
     */
    async getDictionaryInfo() {
        return /** @type {Promise<import('dictionary-importer').Summary[]>} */ (this._offscreen.sendMessagePromise({action: 'getDictionaryInfoOffscreen'}));
    }

    /**
     * @param {string} dictionaryTitle
     * @param {number} [_progressRate]
     * @param {import('dictionary-database').DeleteDictionaryProgressCallback} [_onProgress]
     * @returns {Promise<void>}
     */
    async deleteDictionary(dictionaryTitle, _progressRate = 1000, _onProgress = () => {}) {
        await this._offscreen.sendMessagePromise({action: 'deleteDictionaryOffscreen', params: {dictionaryTitle}});
    }

    /**
     * @param {string} fromDictionaryTitle
     * @param {string} toDictionaryTitle
     * @param {import('dictionary-importer').Summary|null} [summaryOverride]
     * @param {string|null} [replacedDictionaryTitle]
     * @returns {Promise<void>}
     */
    async replaceDictionaryTitle(fromDictionaryTitle, toDictionaryTitle, summaryOverride = null, replacedDictionaryTitle = null) {
        await this._offscreen.sendMessagePromise({
            action: 'replaceDictionaryTitleOffscreen',
            params: {
                fromDictionaryTitle,
                toDictionaryTitle,
                summaryOverride,
                replacedDictionaryTitle,
            },
        });
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    async getDictionaryCounts(dictionaryNames, getTotal) {
        return /** @type {Promise<import('dictionary-database').DictionaryCounts>} */ (this._offscreen.sendMessagePromise({action: 'getDictionaryCountsOffscreen', params: {dictionaryNames, getTotal}}));
    }

    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<import('dictionary-database').DictionaryTermProbe|null>}
     */
    async getDictionaryTermProbe(dictionaryTitle) {
        return /** @type {Promise<import('dictionary-database').DictionaryTermProbe|null>} */ (
            this._offscreen.sendMessagePromise({action: 'getDictionaryTermProbeOffscreen', params: {dictionaryTitle}})
        );
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @param {import('dictionary-database').MatchType} matchType
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBulk(termList, dictionaries, matchType) {
        const dictionaryNames = dictionaries instanceof Map ? [...dictionaries.keys()] : [...dictionaries];
        return /** @type {Promise<import('dictionary-database').TermEntry[]>} */ (
            this._offscreen.sendMessagePromise({action: 'findTermsBulkOffscreen', params: {termList, dictionaryNames, matchType}})
        );
    }

    /**
     * @returns {Promise<boolean>}
     */
    async purge() {
        const result = await this._offscreen.sendMessagePromise({action: 'databasePurgeOffscreen'});
        await this._refreshRuntimeState();
        return result === true;
    }

    /**
     * @param {import('dictionary-database').MediaRequest[]} targets
     * @returns {Promise<import('dictionary-database').Media[]>}
     */
    async getMedia(targets) {
        const serializedMedia = /** @type {import('dictionary-database').Media<string>[]} */ (await this._offscreen.sendMessagePromise({action: 'databaseGetMediaOffscreen', params: {targets}}));
        return serializedMedia.map((m) => ({...m, content: base64ToArrayBuffer(m.content)}));
    }

    /**
     * @returns {Promise<ArrayBuffer>}
     */
    async exportDatabase() {
        const content = await this._offscreen.sendMessagePromise({action: 'databaseExportOffscreen'});
        return base64ToArrayBuffer(typeof content === 'string' ? content : '');
    }

    /**
     * @param {ArrayBuffer} content
     * @returns {Promise<void>}
     */
    async importDatabase(content) {
        await this._offscreen.sendMessagePromise({action: 'databaseImportOffscreen', params: {content: arrayBufferToBase64(content)}});
        await this._refreshRuntimeState();
    }

    /**
     * @param {MessagePort} port
     * @returns {Promise<void>}
     */
    async connectToDatabaseWorker(port) {
        await this._offscreen.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [port]);
    }
}

export class TranslatorProxy {
    /**
     * @param {DictionaryRuntimeMessenger} offscreen
     */
    constructor(offscreen) {
        /** @type {DictionaryRuntimeMessenger} */
        this._offscreen = offscreen;
    }

    /** */
    async prepare() {
        await this._offscreen.sendMessagePromise({action: 'translatorPrepareOffscreen'});
    }

    /**
     * @param {string} text
     * @param {import('translation').FindKanjiOptions} options
     * @returns {Promise<import('dictionary').KanjiDictionaryEntry[]>}
     */
    async findKanji(text, options) {
        const enabledDictionaryMapList = [...options.enabledDictionaryMap];
        /** @type {import('offscreen').FindKanjiOptionsOffscreen} */
        const modifiedOptions = {
            ...options,
            enabledDictionaryMap: enabledDictionaryMapList,
        };
        return /** @type {Promise<import('dictionary').KanjiDictionaryEntry[]>} */ (this._offscreen.sendMessagePromise({action: 'findKanjiOffscreen', params: {text, options: modifiedOptions}}));
    }

    /**
     * @param {import('translator').FindTermsMode} mode
     * @param {string} text
     * @param {import('translation').FindTermsOptions} options
     * @returns {Promise<import('translator').FindTermsResult>}
     */
    async findTerms(mode, text, options) {
        const {enabledDictionaryMap, excludeDictionaryDefinitions, textReplacements} = options;
        const enabledDictionaryMapList = [...enabledDictionaryMap];
        const excludeDictionaryDefinitionsList = excludeDictionaryDefinitions ? [...excludeDictionaryDefinitions] : null;
        const textReplacementsSerialized = textReplacements.map((group) => {
            return group !== null ? group.map((opt) => ({...opt, pattern: opt.pattern.toString()})) : null;
        });
        /** @type {import('offscreen').FindTermsOptionsOffscreen} */
        const modifiedOptions = {
            ...options,
            enabledDictionaryMap: enabledDictionaryMapList,
            excludeDictionaryDefinitions: excludeDictionaryDefinitionsList,
            textReplacements: textReplacementsSerialized,
        };
        return /** @type {Promise<import('translator').FindTermsResult>} */ (this._offscreen.sendMessagePromise({action: 'findTermsOffscreen', params: {mode, text, options: modifiedOptions}}));
    }

    /**
     * @param {import('translator').TermReadingList} termReadingList
     * @param {string[]} dictionaries
     * @returns {Promise<import('translator').TermFrequencySimple[]>}
     */
    async getTermFrequencies(termReadingList, dictionaries) {
        return /** @type {Promise<import('translator').TermFrequencySimple[]>} */ (this._offscreen.sendMessagePromise({action: 'getTermFrequenciesOffscreen', params: {termReadingList, dictionaries}}));
    }

    /** */
    async clearDatabaseCaches() {
        await this._offscreen.sendMessagePromise({action: 'clearDatabaseCachesOffscreen'});
    }
}

export class ClipboardReaderProxy {
    /**
     * @param {OffscreenProxy} offscreen
     */
    constructor(offscreen) {
        /** @type {?import('environment').Browser} */
        this._browser = null;
        /** @type {OffscreenProxy} */
        this._offscreen = offscreen;
    }

    /** @type {?import('environment').Browser} */
    get browser() { return this._browser; }
    set browser(value) {
        if (this._browser === value) { return; }
        this._browser = value;
        void this._offscreen.sendMessagePromise({action: 'clipboardSetBrowserOffscreen', params: {value}}).catch((error) => {
            log.error(error);
        });
    }

    /**
     * @param {boolean} useRichText
     * @returns {Promise<string>}
     */
    async getText(useRichText) {
        return await this._offscreen.sendMessagePromise({action: 'clipboardGetTextOffscreen', params: {useRichText}});
    }

    /**
     * @returns {Promise<?string>}
     */
    async getImage() {
        return await this._offscreen.sendMessagePromise({action: 'clipboardGetImageOffscreen'});
    }
}
