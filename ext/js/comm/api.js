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

const pmTransportTimeoutMs = 10_000;
const apiInvokeTimeoutMs = 30_000;
const apiInvokeExtendedTimeoutMs = 180_000;

function sleep(delayMs) {
    return new Promise((resolve) => {
        globalThis.setTimeout(resolve, delayMs);
    });
}

export class API {
    /**
     * @param {import('../extension/web-extension.js').WebExtension} webExtension
     * @param {Worker?} mediaDrawingWorker
     * @param {MessagePort?} backendPort
     */
    constructor(webExtension, mediaDrawingWorker = null, backendPort = null) {
        /** @type {import('../extension/web-extension.js').WebExtension} */
        this._webExtension = webExtension;

        /** @type {Worker?} */
        this._mediaDrawingWorker = null;
        /** @type {number} */
        this._mediaDrawingWorkerGeneration = 0;
        /** @type {boolean} */
        this._mediaDrawingWorkerConnected = false;
        /** @type {Promise<void>|null} */
        this._mediaDrawingWorkerConnectPromise = null;
        /** @type {number} */
        this._mediaDrawingWorkerConnectGeneration = 0;
        this.setMediaDrawingWorker(mediaDrawingWorker);

        /** @type {MessagePort?} */
        this._backendPort = null;
        /** @type {Promise<void>|null} */
        this._backendReconnectPromise = null;
        /** @type {boolean} */
        this._runtimeConnectionsShutdown = false;
        /** @type {Set<(error: Error) => void>} */
        this._shutdownRejectors = new Set();
        this._setBackendPort(backendPort);
    }

    /**
     * @param {Worker|null} mediaDrawingWorker
     * @returns {void}
     */
    setMediaDrawingWorker(mediaDrawingWorker) {
        this._mediaDrawingWorkerGeneration += 1;
        this._mediaDrawingWorker = mediaDrawingWorker;
        this._mediaDrawingWorkerConnected = false;
        this._mediaDrawingWorkerConnectPromise = null;
        this._mediaDrawingWorkerConnectGeneration = this._mediaDrawingWorkerGeneration;
        const generation = this._mediaDrawingWorkerGeneration;
        if (this._mediaDrawingWorker !== null && typeof this._mediaDrawingWorker.addEventListener === 'function') {
            this._mediaDrawingWorker.addEventListener('message', (event) => {
                if (generation !== this._mediaDrawingWorkerGeneration || this._mediaDrawingWorker !== mediaDrawingWorker) { return; }
                const data = /** @type {unknown} */ (event.data);
                if (!(typeof data === 'object' && data !== null && !Array.isArray(data))) { return; }
                if (Reflect.get(data, 'action') !== 'mediaDrawingWorkerDatabasePortClosed') { return; }
                this._mediaDrawingWorkerConnected = false;
            });
        }
    }

    /**
     * @returns {void}
     */
    shutdownRuntimeConnections() {
        this._runtimeConnectionsShutdown = true;
        const error = new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
        for (const reject of this._shutdownRejectors) {
            reject(error);
        }
        this._shutdownRejectors.clear();
        this.setMediaDrawingWorker(null);
        this._backendReconnectPromise = null;
        this._setBackendPort(null);
    }

    /**
     * @param {import('api').ApiParam<'optionsGet', 'optionsContext'>} optionsContext
     * @returns {Promise<import('api').ApiReturn<'optionsGet'>>}
     */
    optionsGet(optionsContext) {
        return this._invoke('optionsGet', {optionsContext});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'optionsGetFull'>>}
     */
    optionsGetFull() {
        return this._invoke('optionsGetFull', void 0);
    }

    /**
     * @param {import('api').ApiParam<'termsFind', 'text'>} text
     * @param {import('api').ApiParam<'termsFind', 'details'>} details
     * @param {import('api').ApiParam<'termsFind', 'optionsContext'>} optionsContext
     * @returns {Promise<import('api').ApiReturn<'termsFind'>>}
     */
    termsFind(text, details, optionsContext) {
        return this._invoke('termsFind', {text, details, optionsContext});
    }

    /**
     * @param {import('api').ApiParam<'parseText', 'text'>} text
     * @param {import('api').ApiParam<'parseText', 'optionsContext'>} optionsContext
     * @param {import('api').ApiParam<'parseText', 'scanLength'>} scanLength
     * @param {import('api').ApiParam<'parseText', 'useInternalParser'>} useInternalParser
     * @param {import('api').ApiParam<'parseText', 'useMecabParser'>} useMecabParser
     * @returns {Promise<import('api').ApiReturn<'parseText'>>}
     */
    parseText(text, optionsContext, scanLength, useInternalParser, useMecabParser) {
        return this._invoke('parseText', {text, optionsContext, scanLength, useInternalParser, useMecabParser});
    }

    /**
     * @param {import('api').ApiParam<'kanjiFind', 'text'>} text
     * @param {import('api').ApiParam<'kanjiFind', 'optionsContext'>} optionsContext
     * @returns {Promise<import('api').ApiReturn<'kanjiFind'>>}
     */
    kanjiFind(text, optionsContext) {
        return this._invoke('kanjiFind', {text, optionsContext});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'isAnkiConnected'>>}
     */
    isAnkiConnected() {
        return this._invoke('isAnkiConnected', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'getAnkiConnectVersion'>>}
     */
    getAnkiConnectVersion() {
        return this._invoke('getAnkiConnectVersion', void 0);
    }

    /**
     * @param {import('api').ApiParam<'addAnkiNote', 'note'>} note
     * @returns {Promise<import('api').ApiReturn<'addAnkiNote'>>}
     */
    addAnkiNote(note) {
        return this._invoke('addAnkiNote', {note});
    }

    /**
     * @param {import('api').ApiParam<'updateAnkiNote', 'noteWithId'>} noteWithId
     * @returns {Promise<import('api').ApiReturn<'updateAnkiNote'>>}
     */
    updateAnkiNote(noteWithId) {
        return this._invoke('updateAnkiNote', {noteWithId});
    }

    /**
     * @param {import('api').ApiParam<'getAnkiNoteInfo', 'notes'>} notes
     * @param {import('api').ApiParam<'getAnkiNoteInfo', 'fetchAdditionalInfo'>} fetchAdditionalInfo
     * @param {import('api').ApiParam<'getAnkiNoteInfo', 'fetchDuplicateNoteIds'>} [fetchDuplicateNoteIds=true]
     * @returns {Promise<import('api').ApiReturn<'getAnkiNoteInfo'>>}
     */
    getAnkiNoteInfo(notes, fetchAdditionalInfo, fetchDuplicateNoteIds = true) {
        return this._invoke('getAnkiNoteInfo', {notes, fetchAdditionalInfo, fetchDuplicateNoteIds});
    }

    /**
     * @param {import('api').ApiParam<'injectAnkiNoteMedia', 'timestamp'>} timestamp
     * @param {import('api').ApiParam<'injectAnkiNoteMedia', 'definitionDetails'>} definitionDetails
     * @param {import('api').ApiParam<'injectAnkiNoteMedia', 'audioDetails'>} audioDetails
     * @param {import('api').ApiParam<'injectAnkiNoteMedia', 'screenshotDetails'>} screenshotDetails
     * @param {import('api').ApiParam<'injectAnkiNoteMedia', 'clipboardDetails'>} clipboardDetails
     * @param {import('api').ApiParam<'injectAnkiNoteMedia', 'dictionaryMediaDetails'>} dictionaryMediaDetails
     * @returns {Promise<import('api').ApiReturn<'injectAnkiNoteMedia'>>}
     */
    injectAnkiNoteMedia(timestamp, definitionDetails, audioDetails, screenshotDetails, clipboardDetails, dictionaryMediaDetails) {
        return this._invoke('injectAnkiNoteMedia', {timestamp, definitionDetails, audioDetails, screenshotDetails, clipboardDetails, dictionaryMediaDetails});
    }

    /**
     * @param {import('api').ApiParam<'viewNotes', 'noteIds'>} noteIds
     * @param {import('api').ApiParam<'viewNotes', 'mode'>} mode
     * @param {import('api').ApiParam<'viewNotes', 'allowFallback'>} allowFallback
     * @returns {Promise<import('api').ApiReturn<'viewNotes'>>}
     */
    viewNotes(noteIds, mode, allowFallback) {
        return this._invoke('viewNotes', {noteIds, mode, allowFallback});
    }

    /**
     * @param {import('api').ApiParam<'suspendAnkiCardsForNote', 'noteId'>} noteId
     * @returns {Promise<import('api').ApiReturn<'suspendAnkiCardsForNote'>>}
     */
    suspendAnkiCardsForNote(noteId) {
        return this._invoke('suspendAnkiCardsForNote', {noteId});
    }

    /**
     * @param {import('api').ApiParam<'getTermAudioInfoList', 'source'>} source
     * @param {import('api').ApiParam<'getTermAudioInfoList', 'term'>} term
     * @param {import('api').ApiParam<'getTermAudioInfoList', 'reading'>} reading
     * @param {import('api').ApiParam<'getTermAudioInfoList', 'languageSummary'>} languageSummary
     * @returns {Promise<import('api').ApiReturn<'getTermAudioInfoList'>>}
     */
    getTermAudioInfoList(source, term, reading, languageSummary) {
        return this._invoke('getTermAudioInfoList', {source, term, reading, languageSummary});
    }

    /**
     * @param {import('api').ApiParam<'commandExec', 'command'>} command
     * @param {import('api').ApiParam<'commandExec', 'params'>} [params]
     * @returns {Promise<import('api').ApiReturn<'commandExec'>>}
     */
    commandExec(command, params) {
        return this._invoke('commandExec', {command, params});
    }

    /**
     * @param {import('api').ApiParam<'sendMessageToFrame', 'frameId'>} frameId
     * @param {import('api').ApiParam<'sendMessageToFrame', 'message'>} message
     * @returns {Promise<import('api').ApiReturn<'sendMessageToFrame'>>}
     */
    sendMessageToFrame(frameId, message) {
        return this._invoke('sendMessageToFrame', {frameId, message});
    }

    /**
     * @param {import('api').ApiParam<'broadcastTab', 'message'>} message
     * @returns {Promise<import('api').ApiReturn<'broadcastTab'>>}
     */
    broadcastTab(message) {
        return this._invoke('broadcastTab', {message});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'frameInformationGet'>>}
     */
    frameInformationGet() {
        return this._invoke('frameInformationGet', void 0);
    }

    /**
     * @param {import('api').ApiParam<'injectStylesheet', 'type'>} type
     * @param {import('api').ApiParam<'injectStylesheet', 'value'>} value
     * @returns {Promise<import('api').ApiReturn<'injectStylesheet'>>}
     */
    injectStylesheet(type, value) {
        return this._invoke('injectStylesheet', {type, value});
    }

    /**
     * @param {import('api').ApiParam<'getStylesheetContent', 'url'>} url
     * @returns {Promise<import('api').ApiReturn<'getStylesheetContent'>>}
     */
    getStylesheetContent(url) {
        return this._invoke('getStylesheetContent', {url});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'getEnvironmentInfo'>>}
     */
    getEnvironmentInfo() {
        return this._invoke('getEnvironmentInfo', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'clipboardGet'>>}
     */
    clipboardGet() {
        return this._invoke('clipboardGet', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'getZoom'>>}
     */
    getZoom() {
        return this._invoke('getZoom', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'getDefaultAnkiFieldTemplates'>>}
     */
    getDefaultAnkiFieldTemplates() {
        return this._invoke('getDefaultAnkiFieldTemplates', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'getDictionaryInfo'>>}
     */
    getDictionaryInfo() {
        return this._invoke('getDictionaryInfo', void 0);
    }

    /**
     * @param {import('api').ApiParam<'deleteDictionaryByTitle', 'dictionaryTitle'>} dictionaryTitle
     * @returns {Promise<import('api').ApiReturn<'deleteDictionaryByTitle'>>}
     */
    deleteDictionaryByTitle(dictionaryTitle) {
        return this._invoke('deleteDictionaryByTitle', {dictionaryTitle});
    }

    /**
     * @param {import('api').ApiParams<'replaceDictionaryTitle'>} details
     * @returns {Promise<import('api').ApiReturn<'replaceDictionaryTitle'>>}
     */
    replaceDictionaryTitle(details) {
        const {
            fromDictionaryTitle,
            toDictionaryTitle,
            summary,
            replacedDictionaryTitle,
        } = details;
        return this._invoke('replaceDictionaryTitle', {fromDictionaryTitle, toDictionaryTitle, summary, replacedDictionaryTitle});
    }

    /**
     * @param {import('api').ApiParam<'getDictionaryCounts', 'dictionaryNames'>} dictionaryNames
     * @param {import('api').ApiParam<'getDictionaryCounts', 'getTotal'>} getTotal
     * @returns {Promise<import('api').ApiReturn<'getDictionaryCounts'>>}
     */
    getDictionaryCounts(dictionaryNames, getTotal) {
        return this._invoke('getDictionaryCounts', {dictionaryNames, getTotal});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'debugDictionaryStorageState'>>}
     */
    debugDictionaryStorageState() {
        return this._invoke('debugDictionaryStorageState', void 0);
    }

    /**
     * @param {import('api').ApiParam<'verifyDictionaryVisibility', 'dictionaryTitle'>} dictionaryTitle
     * @param {import('api').ApiParam<'verifyDictionaryVisibility', 'requireEnabledForActiveProfile'>} requireEnabledForActiveProfile
     * @returns {Promise<import('api').ApiReturn<'verifyDictionaryVisibility'>>}
     */
    verifyDictionaryVisibility(dictionaryTitle, requireEnabledForActiveProfile) {
        return this._invoke('verifyDictionaryVisibility', {dictionaryTitle, requireEnabledForActiveProfile});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'debugDictionaryStorageState'>>}
     */
    debugDictionaryStorageState() {
        return this._invoke('debugDictionaryStorageState', void 0);
    }

    /**
     * @param {string} url
     * @returns {Promise<{contentBase64: string, fileName: string, contentType: string|null}>}
     */
    downloadDictionaryArchive(url) {
        return this._invoke('downloadDictionaryArchive', {url});
    }

    /**
     * @param {import('api').ApiParam<'setDictionaryImportMode', 'active'>} active
     * @returns {Promise<import('api').ApiReturn<'setDictionaryImportMode'>>}
     */
    setDictionaryImportMode(active) {
        return this._invoke('setDictionaryImportMode', {active});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'purgeDatabase'>>}
     */
    purgeDatabase() {
        return this._invoke('purgeDatabase', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'exportDictionaryDatabase'>>}
     */
    exportDictionaryDatabase() {
        return this._invoke('exportDictionaryDatabase', void 0);
    }

    /**
     * @param {import('api').ApiParam<'importDictionaryDatabase', 'content'>} content
     * @returns {Promise<import('api').ApiReturn<'importDictionaryDatabase'>>}
     */
    importDictionaryDatabase(content) {
        return this._invoke('importDictionaryDatabase', {content});
    }

    /**
     * @param {import('api').ApiParam<'getMedia', 'targets'>} targets
     * @returns {Promise<import('api').ApiReturn<'getMedia'>>}
     */
    getMedia(targets) {
        return this._invoke('getMedia', {targets});
    }

    /**
     * @param {import('api').PmApiParam<'drawMedia', 'requests'>} requests
     * @param {Transferable[]} transferables
     */
    drawMedia(requests, transferables) {
        if (this._mediaDrawingWorker === null) { return; }
        void this._ensureMediaDrawingWorkerConnected().then(() => {
            this._mediaDrawingWorker?.postMessage({action: 'drawMedia', params: {requests}}, transferables);
        }).catch(() => {
            // Ignore media draw failures here; the runtime error paths above now surface backend/bridge failures explicitly.
        });
    }

    /**
     * @param {import('api').ApiParam<'logGenericErrorBackend', 'error'>} error
     * @param {import('api').ApiParam<'logGenericErrorBackend', 'level'>} level
     * @param {import('api').ApiParam<'logGenericErrorBackend', 'context'>} context
     * @returns {Promise<import('api').ApiReturn<'logGenericErrorBackend'>>}
     */
    logGenericErrorBackend(error, level, context) {
        return this._invoke('logGenericErrorBackend', {error, level, context});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'logIndicatorClear'>>}
     */
    logIndicatorClear() {
        return this._invoke('logIndicatorClear', void 0);
    }

    /**
     * @param {import('api').ApiParam<'modifySettings', 'targets'>} targets
     * @param {import('api').ApiParam<'modifySettings', 'source'>} source
     * @returns {Promise<import('api').ApiReturn<'modifySettings'>>}
     */
    modifySettings(targets, source) {
        return this._invoke('modifySettings', {targets, source});
    }

    /**
     * @param {import('api').ApiParam<'getSettings', 'targets'>} targets
     * @returns {Promise<import('api').ApiReturn<'getSettings'>>}
     */
    getSettings(targets) {
        return this._invoke('getSettings', {targets});
    }

    /**
     * @param {import('api').ApiParam<'setAllSettings', 'value'>} value
     * @param {import('api').ApiParam<'setAllSettings', 'source'>} source
     * @returns {Promise<import('api').ApiReturn<'setAllSettings'>>}
     */
    setAllSettings(value, source) {
        return this._invoke('setAllSettings', {value, source});
    }

    /**
     * @param {import('api').ApiParams<'getOrCreateSearchPopup'>} details
     * @returns {Promise<import('api').ApiReturn<'getOrCreateSearchPopup'>>}
     */
    getOrCreateSearchPopup(details) {
        return this._invoke('getOrCreateSearchPopup', details);
    }

    /**
     * @param {import('api').ApiParam<'isTabSearchPopup', 'tabId'>} tabId
     * @returns {Promise<import('api').ApiReturn<'isTabSearchPopup'>>}
     */
    isTabSearchPopup(tabId) {
        return this._invoke('isTabSearchPopup', {tabId});
    }

    /**
     * @param {import('api').ApiParam<'triggerDatabaseUpdated', 'type'>} type
     * @param {import('api').ApiParam<'triggerDatabaseUpdated', 'cause'>} cause
     * @returns {Promise<import('api').ApiReturn<'triggerDatabaseUpdated'>>}
     */
    triggerDatabaseUpdated(type, cause) {
        return this._invoke('triggerDatabaseUpdated', {type, cause});
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'testMecab'>>}
     */
    testMecab() {
        return this._invoke('testMecab', void 0);
    }

    /**
     * @param {string} url
     * @returns {Promise<import('api').ApiReturn<'testYomitanApi'>>}
     */
    testYomitanApi(url) {
        return this._invoke('testYomitanApi', {url});
    }

    /**
     * @param {import('api').ApiParam<'isTextLookupWorthy', 'text'>} text
     * @param {import('api').ApiParam<'isTextLookupWorthy', 'language'>} language
     * @returns {Promise<import('api').ApiReturn<'isTextLookupWorthy'>>}
     */
    isTextLookupWorthy(text, language) {
        return this._invoke('isTextLookupWorthy', {text, language});
    }

    /**
     * @param {import('api').ApiParam<'getTermFrequencies', 'termReadingList'>} termReadingList
     * @param {import('api').ApiParam<'getTermFrequencies', 'dictionaries'>} dictionaries
     * @returns {Promise<import('api').ApiReturn<'getTermFrequencies'>>}
     */
    getTermFrequencies(termReadingList, dictionaries) {
        return this._invoke('getTermFrequencies', {termReadingList, dictionaries});
    }

    /**
     * @param {import('api').ApiParam<'findAnkiNotes', 'query'>} query
     * @returns {Promise<import('api').ApiReturn<'findAnkiNotes'>>}
     */
    findAnkiNotes(query) {
        return this._invoke('findAnkiNotes', {query});
    }

    /**
     * @param {import('api').ApiParam<'openCrossFramePort', 'targetTabId'>} targetTabId
     * @param {import('api').ApiParam<'openCrossFramePort', 'targetFrameId'>} targetFrameId
     * @returns {Promise<import('api').ApiReturn<'openCrossFramePort'>>}
     */
    openCrossFramePort(targetTabId, targetFrameId) {
        return this._invoke('openCrossFramePort', {targetTabId, targetFrameId});
    }

    /**
     * This is used to keep the background page alive on Firefox MV3, as it does not support offscreen.
     * The reason that backend persistency is required on FF is actually different from the reason it's required on Chromium --
     * on Chromium, persistency (which we achieve via the offscreen page, not via this heartbeat) is required because the load time
     * for the IndexedDB is incredibly long, which makes the first lookup after the extension sleeps take one minute+, which is
     * not acceptable. However, on Firefox, the database is backed by sqlite and starts very fast. Instead, the problem is that the
     * media-drawing-worker on the frontend holds a MessagePort to the database-worker on the backend, which closes when the extension
     * sleeps, because the database-worker is killed and currently there is no way to detect a closed port due to
     * https://github.com/whatwg/html/issues/1766 / https://github.com/whatwg/html/issues/10201
     *
     * So this is our only choice. We can remove this once there is a way to gracefully detect the closed MessagePort and rebuild it.
     * @returns {Promise<import('api').ApiReturn<'heartbeat'>>}
     */
    heartbeat() {
        return this._invoke('heartbeat', void 0);
    }

    /**
     * @param {Blob} archiveContent
     * @param {import('dictionary-importer').ImportDetails} details
     * @param {?import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<unknown>}
     */
    importDictionaryOffscreen(archiveContent, details, onProgress) {
        const pmTransportError = this._getPmTransportError();
        if (pmTransportError !== null) {
            return Promise.reject(pmTransportError);
        }
        const channel = new MessageChannel();
        return new Promise((resolve, reject) => {
            let settled = false;
            const shutdownReject = (error) => {
                if (settled) { return; }
                settled = true;
                this._shutdownRejectors.delete(shutdownReject);
                globalThis.clearTimeout(timeoutId);
                try {
                    channel.port1.close();
                } catch (_) {
                    // Ignore close failures for torn-down import response channels.
                }
                reject(error);
            };
            this._shutdownRejectors.add(shutdownReject);
            const timeoutMs = 150_000;
            const timeoutId = globalThis.setTimeout(() => {
                shutdownReject(new Error(`Dictionary runtime import response timed out after ${String(timeoutMs)}ms`));
            }, timeoutMs);
            channel.port1.onmessage = (event) => {
                if (settled) { return; }
                const eventData = /** @type {unknown} */ (event.data);
                const data = (
                    typeof eventData === 'object' &&
                    eventData !== null &&
                    !Array.isArray(eventData)
                ) ? /** @type {{type?: string, progress?: unknown, result?: unknown, error?: import('core').SerializedError}} */ (eventData) : null;
                switch (data?.type) {
                    case 'progress':
                        onProgress?.(/** @type {import('dictionary-importer').ProgressData} */ (data.progress));
                        return;
                    case 'complete':
                        settled = true;
                        this._shutdownRejectors.delete(shutdownReject);
                        globalThis.clearTimeout(timeoutId);
                        channel.port1.close();
                        if (
                            data.result &&
                            typeof data.result === 'object' &&
                            !Array.isArray(data.result)
                        ) {
                            const result = /** @type {{errors?: unknown[]}} */ (data.result);
                            if (Array.isArray(result.errors)) {
                                result.errors = result.errors.map((error) => {
                                    if (error && typeof error === 'object' && !Array.isArray(error)) {
                                        return ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (error));
                                    }
                                    return error;
                                });
                            }
                        }
                        resolve(data.result ?? null);
                        return;
                    case 'error':
                        settled = true;
                        this._shutdownRejectors.delete(shutdownReject);
                        globalThis.clearTimeout(timeoutId);
                        channel.port1.close();
                        reject(ExtensionError.deserialize(
                            data.error ?? {name: 'Error', message: 'Dictionary runtime import failed', stack: ''},
                        ));
                        return;
                    default:
                        return;
                }
            };
            channel.port1.onmessageerror = () => {
                shutdownReject(new Error('Dictionary runtime import response channel failed'));
            };
            try {
                void this._pmInvoke('importDictionaryOffscreen', {archiveContent, details}, [channel.port2]).catch((error) => {
                    shutdownReject(error instanceof Error ? error : new Error(String(error)));
                });
            } catch (error) {
                shutdownReject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
     * @param {string} url
     * @param {import('dictionary-importer').ImportDetails} details
     * @param {?import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<unknown>}
     */
    importDictionaryUrlOffscreen(url, details, onProgress) {
        const pmTransportError = this._getPmTransportError();
        if (pmTransportError !== null) {
            return Promise.reject(pmTransportError);
        }
        const channel = new MessageChannel();
        return new Promise((resolve, reject) => {
            let settled = false;
            const shutdownReject = (error) => {
                if (settled) { return; }
                settled = true;
                this._shutdownRejectors.delete(shutdownReject);
                globalThis.clearTimeout(timeoutId);
                try {
                    channel.port1.close();
                } catch (_) {
                    // Ignore close failures for torn-down URL import response channels.
                }
                reject(error);
            };
            this._shutdownRejectors.add(shutdownReject);
            const timeoutMs = 150_000;
            const timeoutId = globalThis.setTimeout(() => {
                shutdownReject(new Error(`Dictionary runtime URL import response timed out after ${String(timeoutMs)}ms`));
            }, timeoutMs);
            channel.port1.onmessage = (event) => {
                if (settled) { return; }
                const eventData = /** @type {unknown} */ (event.data);
                const data = (
                    typeof eventData === 'object' &&
                    eventData !== null &&
                    !Array.isArray(eventData)
                ) ? /** @type {{type?: string, progress?: unknown, result?: unknown, error?: import('core').SerializedError}} */ (eventData) : null;
                switch (data?.type) {
                    case 'progress':
                        onProgress?.(/** @type {import('dictionary-importer').ProgressData} */ (data.progress));
                        return;
                    case 'complete':
                        settled = true;
                        this._shutdownRejectors.delete(shutdownReject);
                        globalThis.clearTimeout(timeoutId);
                        channel.port1.close();
                        if (
                            data.result &&
                            typeof data.result === 'object' &&
                            !Array.isArray(data.result)
                        ) {
                            const result = /** @type {{errors?: unknown[]}} */ (data.result);
                            if (Array.isArray(result.errors)) {
                                result.errors = result.errors.map((error) => {
                                    if (error && typeof error === 'object' && !Array.isArray(error)) {
                                        return ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (error));
                                    }
                                    return error;
                                });
                            }
                        }
                        resolve(data.result ?? null);
                        return;
                    case 'error':
                        settled = true;
                        this._shutdownRejectors.delete(shutdownReject);
                        globalThis.clearTimeout(timeoutId);
                        channel.port1.close();
                        reject(ExtensionError.deserialize(
                            data.error ?? {name: 'Error', message: 'Dictionary runtime URL import failed', stack: ''},
                        ));
                        return;
                    default:
                        return;
                }
            };
            channel.port1.onmessageerror = () => {
                shutdownReject(new Error('Dictionary runtime URL import response channel failed'));
            };
            try {
                void this._pmInvoke('importDictionaryUrlOffscreen', {url, details}, [channel.port2]).catch((error) => {
                    shutdownReject(error instanceof Error ? error : new Error(String(error)));
                });
            } catch (error) {
                shutdownReject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
     * @param {Transferable[]} transferables
     */
    async registerOffscreenPort(transferables) {
        await this._pmInvoke('registerOffscreenPort', void 0, transferables);
    }

    /**
     * @param {MessagePort} port
     * @param {{expectedMediaDrawingWorkerGeneration?: number}} [options]
     */
    async connectToDatabaseWorker(port, options = {}) {
        await this._pmInvoke('connectToDatabaseWorker', void 0, [port]);
        if (this._runtimeConnectionsShutdown) {
            try {
                port.close();
            } catch (_) {
                // Ignore close failures for late media worker bridge success after shutdown.
            }
            throw new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
        }
        const expectedMediaDrawingWorkerGeneration = options.expectedMediaDrawingWorkerGeneration;
        if (typeof expectedMediaDrawingWorkerGeneration === 'number' && expectedMediaDrawingWorkerGeneration !== this._mediaDrawingWorkerGeneration) {
            try {
                port.close();
            } catch (_) {
                // Ignore close failures for stale media worker bridge setup.
            }
            throw new Error('Media drawing worker changed while connecting. Restarting media bridge.');
        }
        this._mediaDrawingWorkerConnected = true;
    }

    /**
     * @returns {Promise<void>}
     */
    async ensureMediaDrawingWorkerConnected() {
        await this._ensureMediaDrawingWorkerConnected();
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'getLanguageSummaries'>>}
     */
    getLanguageSummaries() {
        return this._invoke('getLanguageSummaries', void 0);
    }

    /**
     * @returns {Promise<import('api').ApiReturn<'forceSync'>>}
     */
    forceSync() {
        return this._invoke('forceSync', void 0);
    }

    // Utilities

    /**
     * @template {import('api').ApiNames} TAction
     * @template {import('api').ApiParams<TAction>} TParams
     * @param {TAction} action
     * @param {TParams} params
     * @returns {Promise<import('api').ApiReturn<TAction>>}
     */
    _invoke(action, params) {
        if (this._runtimeConnectionsShutdown) {
            return Promise.reject(new Error('Runtime connections have been shut down. Refresh the page to reconnect.'));
        }
        /** @type {import('api').ApiMessage<TAction>} */
        const data = {action, params};
        return new Promise((resolve, reject) => {
            let settled = false;
            let retriedTransientFailure = false;
            const shutdownReject = (error) => {
                if (settled) { return; }
                settled = true;
                this._shutdownRejectors.delete(shutdownReject);
                globalThis.clearTimeout(timeoutId);
                reject(error);
            };
            const timeoutMs = this._getInvokeTimeoutMs(action);
            const timeoutId = globalThis.setTimeout(() => {
                shutdownReject(new Error(`Timed out waiting for backend response to ${String(action)} after ${String(timeoutMs)}ms. You may need to refresh the page.`));
            }, timeoutMs);
            this._shutdownRejectors.add(shutdownReject);
            const attemptSend = () => {
                if (this._runtimeConnectionsShutdown) {
                    shutdownReject(new Error('Runtime connections have been shut down. Refresh the page to reconnect.'));
                    return;
                }
                try {
                    this._webExtension.sendMessage(data, (response) => {
                        if (settled) { return; }
                        const runtimeError = this._webExtension.getLastError();
                        if (runtimeError !== null) {
                            if (!retriedTransientFailure && this._shouldRetryInvokeAfterRuntimeError(action, runtimeError)) {
                                retriedTransientFailure = true;
                                setTimeout(() => {
                                    if (settled) { return; }
                                    if (this._runtimeConnectionsShutdown) {
                                        shutdownReject(new Error('Runtime connections have been shut down. Refresh the page to reconnect.'));
                                        return;
                                    }
                                    attemptSend();
                                }, 100);
                                return;
                            }
                            settled = true;
                            this._shutdownRejectors.delete(shutdownReject);
                            globalThis.clearTimeout(timeoutId);
                            reject(runtimeError);
                            return;
                        }
                        settled = true;
                        this._shutdownRejectors.delete(shutdownReject);
                        globalThis.clearTimeout(timeoutId);
                        if (response !== null && typeof response === 'object') {
                            const {error} = /** @type {import('core').UnknownObject} */ (response);
                            if (typeof error !== 'undefined') {
                                reject(ExtensionError.deserialize(/** @type {import('core').SerializedError} */(error)));
                            } else {
                                const {result} = /** @type {import('core').UnknownObject} */ (response);
                                resolve(/** @type {import('api').ApiReturn<TAction>} */(result));
                            }
                        } else {
                            const message = response === null ? 'Unexpected null response. You may need to refresh the page.' : `Unexpected response of type ${typeof response}. You may need to refresh the page.`;
                            reject(new Error(`${message} (${JSON.stringify(data)})`));
                        }
                    });
                } catch (e) {
                    if (settled) { return; }
                    settled = true;
                    this._shutdownRejectors.delete(shutdownReject);
                    globalThis.clearTimeout(timeoutId);
                    reject(e);
                }
            };
            attemptSend();
        });
    }

    /**
     * @template {import('api').ApiNames} TAction
     * @param {TAction} action
     * @returns {number}
     */
    _getInvokeTimeoutMs(action) {
        switch (action) {
            case 'exportDictionaryDatabase':
            case 'importDictionaryDatabase':
            case 'downloadDictionaryArchive':
            case 'purgeDatabase':
            case 'triggerDatabaseUpdated':
            case 'modifySettings':
            case 'setAllSettings':
                return apiInvokeExtendedTimeoutMs;
            default:
                return apiInvokeTimeoutMs;
        }
    }

    /**
     * @template {import('api').ApiNames} TAction
     * @param {TAction} action
     * @param {Error} error
     * @returns {boolean}
     */
    _shouldRetryInvokeAfterRuntimeError(action, error) {
        const message = error.message;
        const transientDisconnect = (
            message.includes('Receiving end does not exist') ||
            message.includes('Could not establish connection') ||
            message.includes('The message port closed before a response was received')
        );
        if (!transientDisconnect) {
            return false;
        }
        switch (action) {
            case 'optionsGet':
            case 'optionsGetFull':
            case 'termsFind':
            case 'parseText':
            case 'kanjiFind':
            case 'getEnvironmentInfo':
            case 'frameInformationGet':
            case 'getDictionaryInfo':
            case 'getDictionaryCounts':
            case 'verifyDictionaryVisibility':
            case 'debugDictionaryLookupState':
            case 'debugDictionaryStorageState':
            case 'getMedia':
            case 'getSettings':
            case 'getLanguageSummaries':
            case 'heartbeat':
                return true;
            default:
                return false;
        }
    }

    /**
     * @template {import('api').PmApiNames} TAction
     * @template {import('api').PmApiParams<TAction>} TParams
     * @param {TAction} action
     * @param {TParams} params
     * @param {Transferable[]} transferables
     */
    async _pmInvoke(action, params, transferables) {
        // on firefox, there is no service worker, so we instead use a MessageChannel which is established
        // via a handshake via a SharedWorker
        if (!('serviceWorker' in navigator)) {
            if (this._runtimeConnectionsShutdown) {
                throw new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
            }
            if (this._backendPort === null) {
                await this._reconnectBackendPort();
            }
            const transportError = this._getPmTransportError();
            if (transportError !== null) {
                throw transportError;
            }
            try {
                this._backendPort.postMessage({action, params}, transferables);
            } catch (error) {
                this._setBackendPort(null);
                await this._reconnectBackendPort();
                if (this._backendPort === null) {
                    throw new Error('Backend message port is not available. You may need to refresh the page.');
                }
                try {
                    this._backendPort.postMessage({action, params}, transferables);
                } catch (retryError) {
                    this._setBackendPort(null);
                    throw new Error(`Failed to send backend message over the shared-worker bridge. You may need to refresh the page. ${retryError instanceof Error ? retryError.message : String(retryError)}`);
                }
            }
        } else {
            let retryableFailure = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                if (this._runtimeConnectionsShutdown) {
                    throw new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
                }
                let timeoutId = null;
                /** @type {(error: Error) => void} */
                let shutdownReject = () => {};
                try {
                    const serviceWorkerRegistration = await Promise.race([
                        navigator.serviceWorker.ready,
                        new Promise((_, reject) => {
                            timeoutId = globalThis.setTimeout(() => {
                                reject(new Error(`Timed out waiting for active service worker after ${String(pmTransportTimeoutMs)}ms`));
                            }, pmTransportTimeoutMs);
                        }),
                        new Promise((_, reject) => {
                            shutdownReject = (error) => {
                                reject(error);
                            };
                            this._shutdownRejectors.add(shutdownReject);
                        }),
                    ]);
                    if (serviceWorkerRegistration.active === null) {
                        throw new Error(`[${self.constructor.name}] no active service worker`);
                    }
                    try {
                        serviceWorkerRegistration.active.postMessage({action, params}, transferables);
                        return;
                    } catch (error) {
                        throw new Error(`Failed to send backend message to the service worker. You may need to refresh the page. ${error instanceof Error ? error.message : String(error)}`);
                    }
                } catch (error) {
                    const normalizedError = error instanceof Error ? error : new Error(String(error));
                    retryableFailure = normalizedError;
                    if (attempt >= 1 || !this._shouldRetryPmServiceWorkerFailure(normalizedError)) {
                        throw normalizedError;
                    }
                    if (this._runtimeConnectionsShutdown) {
                        throw new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
                    }
                    await sleep(100);
                } finally {
                    this._shutdownRejectors.delete(shutdownReject);
                    if (timeoutId !== null) {
                        globalThis.clearTimeout(timeoutId);
                    }
                }
            }
            throw retryableFailure ?? new Error('Failed to send backend message to the service worker. You may need to refresh the page.');
        }
    }

    /**
     * @returns {Error|null}
     */
    _getPmTransportError() {
        if (this._runtimeConnectionsShutdown) {
            return new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
        }
        if (!('serviceWorker' in navigator)) {
            return this._backendPort === null ? new Error('Backend message port is not available. You may need to refresh the page.') : null;
        }
        return null;
    }

    /**
     * @param {MessagePort|null} backendPort
     * @returns {void}
     */
    _setBackendPort(backendPort) {
        if (backendPort === null) {
            this._mediaDrawingWorkerConnected = false;
        }
        if (this._backendPort !== null && this._backendPort !== backendPort) {
            try {
                this._backendPort.close();
            } catch (_) {
                // Ignore close failures for stale backend ports.
            }
        }
        this._backendPort = backendPort;
        if (this._backendPort !== null) {
            this._backendPort.onmessageerror = () => {
                this._setBackendPort(null);
            };
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _reconnectBackendPort() {
        if (this._runtimeConnectionsShutdown) {
            return;
        }
        if (!this._canReconnectBackendPort()) {
            return;
        }
        if (this._backendReconnectPromise !== null) {
            await this._backendReconnectPromise;
            return;
        }
        this._backendReconnectPromise = (async () => {
            const backendPort = this._createFirefoxBackendPort();
            if (this._runtimeConnectionsShutdown) {
                try {
                    backendPort.close();
                } catch (_) {
                    // Ignore close failures for late backend bridge success after shutdown.
                }
                throw new Error('Runtime connections have been shut down. Refresh the page to reconnect.');
            }
            this._setBackendPort(backendPort);
        })();
        try {
            await this._backendReconnectPromise;
        } finally {
            this._backendReconnectPromise = null;
        }
    }

    /**
     * @returns {boolean}
     */
    _canReconnectBackendPort() {
        return (
            !('serviceWorker' in navigator) &&
            typeof SharedWorker === 'function' &&
            typeof MessageChannel === 'function' &&
            window.location.protocol === new URL(import.meta.url).protocol
        );
    }

    /**
     * @returns {MessagePort}
     */
    _createFirefoxBackendPort() {
        const sharedWorkerBridge = new SharedWorker(new URL('shared-worker-bridge.js', import.meta.url), {type: 'module'});
        const backendChannel = new MessageChannel();
        try {
            sharedWorkerBridge.port.postMessage({action: 'connectToBackend1'}, [backendChannel.port1]);
            sharedWorkerBridge.port.close();
            return backendChannel.port2;
        } catch (error) {
            try {
                sharedWorkerBridge.port.close();
            } catch (_) {
                // Ignore close failures for broken shared-worker bridge setup.
            }
            try {
                backendChannel.port1.close();
            } catch (_) {
                // Ignore close failures for unused bridge ports.
            }
            try {
                backendChannel.port2.close();
            } catch (_) {
                // Ignore close failures for unused bridge ports.
            }
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            throw new Error(`Failed to initialize Firefox backend bridge. You may need to refresh the page. ${normalizedError.message}`);
        }
    }

    /**
     * @param {Error} error
     * @returns {boolean}
     */
    _shouldRetryPmServiceWorkerFailure(error) {
        const {message} = error;
        return (
            message.includes('no active service worker') ||
            message.includes('Failed to send backend message to the service worker')
        );
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureMediaDrawingWorkerConnected() {
        if (this._mediaDrawingWorker === null || this._mediaDrawingWorkerConnected) {
            return;
        }
        if (this._mediaDrawingWorkerConnectPromise !== null) {
            if (this._mediaDrawingWorkerConnectGeneration !== this._mediaDrawingWorkerGeneration) {
                this._mediaDrawingWorkerConnectPromise = null;
            } else {
                await this._mediaDrawingWorkerConnectPromise;
                return;
            }
        }
        this._mediaDrawingWorkerConnectGeneration = this._mediaDrawingWorkerGeneration;
        this._mediaDrawingWorkerConnectPromise = (async () => {
            const mediaDrawingWorker = this._mediaDrawingWorker;
            const mediaDrawingWorkerGeneration = this._mediaDrawingWorkerGeneration;
            const mediaDrawingWorkerToBackendChannel = new MessageChannel();
            try {
                mediaDrawingWorker?.postMessage({action: 'connectToDatabaseWorker'}, [mediaDrawingWorkerToBackendChannel.port2]);
                await this.connectToDatabaseWorker(mediaDrawingWorkerToBackendChannel.port1, {expectedMediaDrawingWorkerGeneration: mediaDrawingWorkerGeneration});
            } catch (error) {
                try {
                    mediaDrawingWorkerToBackendChannel.port1.close();
                } catch (_) {
                    // Ignore close failures for failed media bridge setup.
                }
                throw error;
            }
        })();
        try {
            await this._mediaDrawingWorkerConnectPromise;
        } finally {
            if (this._mediaDrawingWorkerConnectGeneration === this._mediaDrawingWorkerGeneration) {
                this._mediaDrawingWorkerConnectPromise = null;
            }
        }
    }
}
