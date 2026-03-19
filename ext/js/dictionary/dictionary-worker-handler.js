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

import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {DictionaryDatabase} from './dictionary-database.js';
import {DictionaryImporter} from './dictionary-importer.js';
import {DictionaryWorkerMediaLoader} from './dictionary-worker-media-loader.js';

const MDX_IMPORT_VERSION = 1;
const MDX_PREPARATION_PROGRESS_TOTAL = 1000;
const MDX_PREPARATION_PROGRESS_START_INDEX = 450;
const MDX_PREPARATION_PROGRESS_RANGE = MDX_PREPARATION_PROGRESS_TOTAL - MDX_PREPARATION_PROGRESS_START_INDEX;

export class DictionaryWorkerHandler {
    constructor() {
        /** @type {DictionaryWorkerMediaLoader} */
        this._mediaLoader = new DictionaryWorkerMediaLoader();
        /** @type {DictionaryDatabase|null} */
        this._importSessionDictionaryDatabase = null;
    }

    /** */
    prepare() {
        self.addEventListener('message', this._onMessage.bind(this), false);
    }

    // Private

    /**
     * @param {MessageEvent<import('dictionary-worker-handler').Message>} event
     */
    _onMessage(event) {
        const {action, params} = event.data;
        switch (action) {
            case 'importDictionary':
                void this._onMessageWithProgress(params, this._importDictionary.bind(this));
                break;
            case 'importMdxDictionary':
                void this._onMessageWithProgress(params, this._importMdxDictionary.bind(this));
                break;
            case 'deleteDictionary':
                void this._onMessageWithProgress(params, this._deleteDictionary.bind(this));
                break;
            case 'getDictionaryCounts':
                void this._onMessageWithProgress(params, this._getDictionaryCounts.bind(this));
                break;
            case 'getMdxVersion':
                void this._onMessageWithProgress(params, this._getMdxVersion.bind(this));
                break;
            case 'getImageDetails.response':
                this._mediaLoader.handleMessage(params);
                break;
        }
    }

    /**
     * @template [T=unknown]
     * @param {T} params
     * @param {(details: T, onProgress: import('dictionary-worker-handler').OnProgressCallback) => Promise<unknown>} handler
     */
    async _onMessageWithProgress(params, handler) {
        /**
         * @param {...unknown} args
         */
        const onProgress = (...args) => {
            self.postMessage({
                action: 'progress',
                params: {args},
            });
        };
        let response;
        try {
            const result = await handler(params, onProgress);
            response = {result};
        } catch (e) {
            response = {error: ExtensionError.serialize(e)};
        }
        self.postMessage({action: 'complete', params: response});
    }

    /**
     * @template [T=unknown]
     * @param {string} action
     * @param {import('core').SerializableObject} params
     * @returns {Promise<T>}
     */
    async _invokeBackendApi(action, params) {
        const runtime = /** @type {typeof chrome.runtime|undefined} */ (Reflect.get(chrome, 'runtime'));
        if (typeof runtime?.sendMessage !== 'function') {
            throw new Error(`Cannot invoke backend action ${action}: chrome.runtime.sendMessage unavailable`);
        }
        return await new Promise((resolve, reject) => {
            runtime.sendMessage({action, params}, (responseRaw) => {
                const runtimeError = runtime.lastError;
                if (typeof runtimeError !== 'undefined') {
                    reject(new Error(runtimeError.message));
                    return;
                }
                const response = /** @type {unknown} */ (responseRaw);
                if (!(typeof response === 'object' && response !== null)) {
                    reject(new Error(`Backend action ${action} returned invalid response`));
                    return;
                }
                const responseRecord = /** @type {Record<string, unknown>} */ (response);
                const error = /** @type {unknown} */ (Reflect.get(responseRecord, 'error'));
                if (typeof error !== 'undefined' && error !== null) {
                    if (typeof error === 'object' && !Array.isArray(error)) {
                        reject(ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (error)));
                        return;
                    }
                    reject(new Error(`Backend action ${action} returned invalid error payload`));
                    return;
                }
                const result = Reflect.get(responseRecord, 'result');
                resolve(/** @type {T} */ (result));
            });
        });
    }

    /**
     * @param {import('dictionary-worker-handler').ImportDictionaryMessageParams} details
     * @param {import('dictionary-worker-handler').OnProgressCallback} onProgress
     * @returns {Promise<import('dictionary-worker').MessageCompleteResultSerialized>}
     */
    async _importDictionary({details, archiveContent}, onProgress) {
        return await this._runImport(details, onProgress, async (dictionaryImporter, dictionaryDatabase) => (
            await dictionaryImporter.importDictionary(dictionaryDatabase, archiveContent, details)
        ));
    }

    /**
     * @param {import('dictionary-worker-handler').ImportMdxDictionaryMessageParams} params
     * @param {import('dictionary-worker-handler').OnProgressCallback} onProgress
     * @returns {Promise<import('dictionary-worker').MessageCompleteResultSerialized>}
     */
    async _importMdxDictionary({details, mdxFileName, mdxBytes, mddFiles = [], options = {}}, onProgress) {
        if (!(mdxBytes instanceof ArrayBuffer)) {
            throw new Error('MDX import worker did not receive MDX bytes');
        }
        const mdxSource = {
            mdxFileName: typeof mdxFileName === 'string' && mdxFileName.length > 0 ? mdxFileName : 'dictionary.mdx',
            mdxBytes: new Uint8Array(mdxBytes),
            mddFiles: Array.isArray(mddFiles) ?
                mddFiles
                    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
                    .map((value) => {
                        const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : 'dictionary.mdd';
                        const bytes = value.bytes instanceof ArrayBuffer ? new Uint8Array(value.bytes) : new Uint8Array(0);
                        return {name, bytes};
                    }) :
                [],
            options: (typeof options === 'object' && options !== null && !Array.isArray(options)) ? options : {},
        };
        const progressState = {
            messageCount: 0,
            lastCompleted: 0,
            lastReportedAt: 0,
        };

        return await this._runImport(details, onProgress, async (dictionaryImporter, dictionaryDatabase) => {
            const importPayload = await dictionaryImporter.importMdxDictionary(
                dictionaryDatabase,
                mdxSource,
                details,
                ({completed, total}) => {
                    const normalizedTotal = Math.max(1, total);
                    const clampedCompleted = Math.max(0, Math.min(normalizedTotal, completed));
                    const now = Date.now();
                    const minimumEntryDelta = Math.max(1, Math.min(100, Math.ceil(normalizedTotal * 0.01)));
                    const shouldEmit = (
                        progressState.messageCount === 0 ||
                        clampedCompleted >= normalizedTotal ||
                        (clampedCompleted - progressState.lastCompleted) >= minimumEntryDelta ||
                        (now - progressState.lastReportedAt) >= 50
                    );
                    if (!shouldEmit) { return; }
                    progressState.messageCount += 1;
                    progressState.lastCompleted = clampedCompleted;
                    progressState.lastReportedAt = now;
                    const normalizedProgress = normalizedTotal > 0 ? Math.max(0, Math.min(1, clampedCompleted / normalizedTotal)) : 1;
                    onProgress({
                        nextStep: false,
                        index: MDX_PREPARATION_PROGRESS_START_INDEX + Math.round(MDX_PREPARATION_PROGRESS_RANGE * normalizedProgress),
                        count: MDX_PREPARATION_PROGRESS_TOTAL,
                    });
                },
            );
            const importerDebug = (typeof importPayload === 'object' && importPayload !== null && !Array.isArray(importPayload)) ?
                (/** @type {import('dictionary-importer').ImportDebug|null} */ (Reflect.get(importPayload, 'debug') ?? null)) :
                null;
            const preparePhaseTiming = importerDebug?.phaseTimings.find(({phase}) => phase === 'prepare-mdx') ?? null;
            if (preparePhaseTiming !== null) {
                preparePhaseTiming.details = {
                    ...preparePhaseTiming.details,
                    progressMessageCount: progressState.messageCount,
                };
            }
            return importPayload;
        });
    }

    /**
     * @param {import('dictionary-importer').ImportDetails} details
     * @param {import('dictionary-worker-handler').OnProgressCallback} onProgress
     * @param {(dictionaryImporter: DictionaryImporter, dictionaryDatabase: DictionaryDatabase) => Promise<import('dictionary-importer').ImportResult>} importCallback
     * @returns {Promise<import('dictionary-worker').MessageCompleteResultSerialized>}
     */
    async _runImport(details, onProgress, importCallback) {
        const useImportSession = (
            typeof details === 'object' &&
            details !== null &&
            !Array.isArray(details) &&
            Reflect.get(details, 'useImportSession') === true
        );
        const finalizeImportSession = (
            typeof details === 'object' &&
            details !== null &&
            !Array.isArray(details) &&
            Reflect.get(details, 'finalizeImportSession') === true
        );
        const createdImportSessionDatabase = useImportSession && this._importSessionDictionaryDatabase === null;
        log.log(`[ImportTiming][worker] useImportSession=${String(useImportSession)} finalizeImportSession=${String(finalizeImportSession)} createdSessionDb=${String(createdImportSessionDatabase)} hasExistingSessionDb=${String(this._importSessionDictionaryDatabase !== null)}`);
        const dictionaryDatabase = useImportSession ?
            (this._importSessionDictionaryDatabase ?? await this._getPreparedDictionaryDatabase()) :
            await this._getPreparedDictionaryDatabase();
        const usesFallbackStorage = dictionaryDatabase.usesFallbackStorage();
        const openStorageDiagnostics = (
            typeof dictionaryDatabase.getOpenStorageDiagnostics === 'function' ?
                dictionaryDatabase.getOpenStorageDiagnostics() :
                null
        );
        if (usesFallbackStorage) {
            throw new Error(`OPFS is required for dictionary import. diagnostics=${JSON.stringify(openStorageDiagnostics)}`);
        }
        if (createdImportSessionDatabase) {
            this._importSessionDictionaryDatabase = dictionaryDatabase;
        }
        try {
            const dictionaryImporter = new DictionaryImporter(this._mediaLoader, onProgress);
            let result;
            let errors;
            /** @type {import('dictionary-importer').ImportDebug|null} */
            let importerDebug = null;
            try {
                const importPayload = await importCallback(dictionaryImporter, dictionaryDatabase);
                ({result, errors} = importPayload);
                importerDebug = (typeof importPayload === 'object' && importPayload !== null && !Array.isArray(importPayload)) ?
                    (/** @type {import('dictionary-importer').ImportDebug|null} */ (Reflect.get(importPayload, 'debug') ?? null)) :
                    null;
            } catch (error) {
                const diagnostics = (
                    typeof dictionaryDatabase.getOpenStorageDiagnostics === 'function' ?
                        dictionaryDatabase.getOpenStorageDiagnostics() :
                        openStorageDiagnostics
                );
                const message = (error instanceof Error) ? error.message : String(error);
                throw new Error(`Dictionary import failed: ${message}. workerStorageDiagnostics=${JSON.stringify(diagnostics)}`);
            }
            return {
                result,
                errors: errors.map((error) => ExtensionError.serialize(error)),
                debug: {
                    usesFallbackStorage,
                    openStorageDiagnostics,
                    useImportSession,
                    finalizeImportSession,
                    importerDebug,
                },
            };
        } finally {
            if (useImportSession && finalizeImportSession && this._importSessionDictionaryDatabase !== null) {
                await this._importSessionDictionaryDatabase.close();
                this._importSessionDictionaryDatabase = null;
            } else if (!useImportSession) {
                await dictionaryDatabase.close();
            }
        }
    }

    /**
     * @param {Record<string, never>} _params
     * @param {import('dictionary-worker-handler').OnProgressCallback} _onProgress
     * @returns {Promise<number>}
     */
    async _getMdxVersion(_params, _onProgress) {
        return MDX_IMPORT_VERSION;
    }

    /**
     * @param {import('dictionary-worker-handler').DeleteDictionaryMessageParams} details
     * @param {import('dictionary-database').DeleteDictionaryProgressCallback} onProgress
     * @returns {Promise<void>}
     */
    async _deleteDictionary({dictionaryTitle}, onProgress) {
        onProgress({processed: 0, count: 1, storeCount: 1, storesProcesed: 0});
        await this._invokeBackendApi('deleteDictionaryByTitle', {dictionaryTitle});
        onProgress({processed: 1, count: 1, storeCount: 1, storesProcesed: 1});
    }

    /**
     * @param {import('dictionary-worker-handler').GetDictionaryCountsMessageParams} details
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    async _getDictionaryCounts({dictionaryNames, getTotal}) {
        return await this._invokeBackendApi('getDictionaryCounts', {dictionaryNames, getTotal});
    }

    /**
     * @returns {Promise<DictionaryDatabase>}
     */
    async _getPreparedDictionaryDatabase() {
        const dictionaryDatabase = new DictionaryDatabase();
        await dictionaryDatabase.prepare();
        return dictionaryDatabase;
    }
}
