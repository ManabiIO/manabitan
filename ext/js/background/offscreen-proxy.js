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
import {reportDiagnostics} from '../core/diagnostics-reporter.js';
import {log} from '../core/log.js';
import {isObjectNotArray} from '../core/object-utilities.js';
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';
import {getDictionaryRuntimeActionPolicy} from './dictionary-runtime-action-policy.js';
import {DictionaryWorkerClient} from './dictionary-worker-client.js';

const offscreenControlRequestTimeoutMs = 30_000;
const offscreenRetriedLookupRequestTimeoutMs = 65_000;

class OffscreenControlTransportError extends Error {
    /**
     * @param {string} message
     * @param {{cause?: unknown}} [options]
     */
    constructor(message, options) {
        super(message, options);
        /** @type {string} */
        this.name = 'OffscreenControlTransportError';
    }
}

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
        /** @type {number} */
        this._offscreenControlRequestId = 0;
        /** @type {Map<number, {port: MessagePort, resolve: (value: unknown) => void, reject: (reason?: unknown) => void}>} */
        this._offscreenControlResponseHandlers = new Map();
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
        const error = new OffscreenControlTransportError('Offscreen control port disconnected');
        for (const [id, handler] of this._offscreenControlResponseHandlers) {
            if (handler.port !== port) { continue; }
            this._offscreenControlResponseHandlers.delete(id);
            handler.reject(error);
        }
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
        /** @type {(event: MessageEvent<{id?: number, result?: unknown, error?: import('core').SerializedError}>) => void} */
        const onMessage = (event) => { this._onOffscreenControlMessage(port, event); };
        port.onmessage = onMessage;
        port.onmessageerror = () => {
            this._clearCurrentOffscreenPort(port);
        };
        if (this._currentOffscreenPort && this._currentOffscreenPort !== port) {
            this._clearCurrentOffscreenPort(this._currentOffscreenPort);
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
     * @returns {Promise<import('offscreen').McApiReturn<TMessageType>>}
     */
    async sendMessageViaPort(message, transfers) {
        const attemptCount = transfers.length === 0 ? 2 : 1;
        for (let attempt = 0; attempt < attemptCount; ++attempt) {
            await this._ensureOffscreenPort();
            const port = this._currentOffscreenPort;
            if (port === null) {
                throw new Error('Offscreen control port is unavailable');
            }
            try {
                return /** @type {import('offscreen').McApiReturn<TMessageType>} */ (
                    await this._sendOffscreenControlMessage(port, /** @type {import('offscreen').McApiMessageAny} */ (message), transfers)
                );
            } catch (error) {
                if (!(error instanceof OffscreenControlTransportError)) {
                    throw error;
                }
                this._clearCurrentOffscreenPort(port);
                if (attempt + 1 >= attemptCount) {
                    throw error;
                }
            }
        }
    }

    /**
     * @param {MessagePort} port
     * @param {import('offscreen').McApiMessageAny} message
     * @param {Transferable[]} transfers
     * @returns {Promise<unknown>}
     */
    async _sendOffscreenControlMessage(port, message, transfers) {
        const id = ++this._offscreenControlRequestId;
        const timeoutMs = message.action === 'findTermsStructuredOffscreen' ?
            offscreenRetriedLookupRequestTimeoutMs :
            offscreenControlRequestTimeoutMs;
        return await new Promise((resolve, reject) => {
            const timeoutId = globalThis.setTimeout(() => {
                const handler = this._offscreenControlResponseHandlers.get(id);
                if (typeof handler === 'undefined') { return; }
                this._offscreenControlResponseHandlers.delete(id);
                handler.reject(new OffscreenControlTransportError(
                    `Timed out waiting for offscreen control response to ${message.action} after ${String(timeoutMs)}ms`,
                ));
            }, timeoutMs);
            this._offscreenControlResponseHandlers.set(id, {
                port,
                resolve: (value) => {
                    globalThis.clearTimeout(timeoutId);
                    resolve(value);
                },
                reject: (reason) => {
                    globalThis.clearTimeout(timeoutId);
                    reject(reason);
                },
            });
            try {
                port.postMessage({...message, id}, transfers);
            } catch (error) {
                this._offscreenControlResponseHandlers.delete(id);
                globalThis.clearTimeout(timeoutId);
                reject(new OffscreenControlTransportError('Failed to send offscreen control message', {cause: error}));
            }
        });
    }

    /**
     * @param {MessagePort} port
     * @param {MessageEvent<{id?: number, result?: unknown, error?: import('core').SerializedError}>} event
     * @returns {void}
     */
    _onOffscreenControlMessage(port, event) {
        if (port !== this._currentOffscreenPort) { return; }
        const id = typeof event.data?.id === 'number' ? event.data.id : null;
        if (id === null) {
            this._clearCurrentOffscreenPort(port);
            return;
        }
        const handler = this._offscreenControlResponseHandlers.get(id);
        if (typeof handler === 'undefined' || handler.port !== port) {
            reportDiagnostics('offscreen-control-unmatched-response', {id});
            this._clearCurrentOffscreenPort(port);
            return;
        }
        this._offscreenControlResponseHandlers.delete(id);
        if (typeof event.data?.error !== 'undefined') {
            try {
                handler.reject(ExtensionError.deserialize(event.data.error));
            } catch (error) {
                handler.reject(new OffscreenControlTransportError('Invalid offscreen control error response', {cause: error}));
                this._clearCurrentOffscreenPort(port);
            }
            return;
        }
        handler.resolve(event.data?.result);
    }
}

/**
 * @typedef {{
 *   sendMessagePromise: (message: import('offscreen').ApiMessageAny) => Promise<unknown>,
 *   sendMessageViaPort: (message: import('offscreen').McApiMessageAny, transfers: Transferable[]) => Promise<unknown>
 * }} DictionaryRuntimeMessenger
 */

export class DictionaryRuntimeWorkerProxy {
    /**
     * @param {string} workerPath
     */
    constructor(workerPath) {
        /** @type {DictionaryWorkerClient} */
        this._client = new DictionaryWorkerClient(workerPath, {context: 'Dictionary runtime worker'});
    }

    /**
     * @template [TReturn=unknown]
     * @param {import('offscreen').ApiMessageAny} message
     * @returns {Promise<TReturn>}
     */
    async sendMessagePromise(message) {
        const payload = /** @type {{action?: string, params?: unknown}} */ (
            typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}
        );
        const action = payload.action ?? '';
        return await this._client.invoke(
            action,
            /** @type {import('core').SerializableObject} */ (payload.params ?? {}),
        );
    }

    /**
     * @template [TReturn=unknown]
     * @param {import('offscreen').McApiMessageAny} message
     * @param {Transferable[]} transfers
     * @returns {Promise<TReturn>}
     */
    async sendMessageViaPort(message, transfers) {
        const payload = /** @type {{action?: string, params?: unknown}} */ (
            typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}
        );
        const action = payload.action ?? '';
        const params = /** @type {import('core').SerializableObject} */ (payload.params ?? {});
        if (getDictionaryRuntimeActionPolicy(action).concurrency === 'streamed-import') {
            this._client.post(action, params, transfers);
            return /** @type {TReturn} */ (void 0);
        }
        return await this._client.invoke(action, params, transfers);
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
        return {...(/** @type {Record<string, unknown>} */ (this._openStorageDiagnostics))};
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
     * @param {Iterable<string>} dictionaryNames
     * @returns {Promise<void>}
     */
    async warmTermLookupCaches(dictionaryNames) {
        await this._offscreen.sendMessagePromise({action: 'warmTermLookupCachesOffscreen', params: {dictionaryNames: [...dictionaryNames]}});
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
        return /** @type {Promise<import('translator').FindTermsResult>} */ (
            this._offscreen.sendMessageViaPort({action: 'findTermsStructuredOffscreen', params: {mode, text, options}}, [])
        );
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
