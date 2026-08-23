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
import {arrayBufferToBase64} from '../data/array-buffer-util.js';
import {DictionaryDatabase} from '../dictionary/dictionary-database.js';
import {DictionaryImporter} from '../dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../dictionary/dictionary-importer-media-loader.js';
import {Translator} from '../language/translator.js';
import {getDictionaryRuntimeActionPolicy} from './dictionary-runtime-action-policy.js';

/**
 * @typedef {{id: number, action: string, params?: import('core').SerializableObject}} WorkerRequest
 * @typedef {{id: number, result?: unknown, error?: import('core').SerializedError}} WorkerResponse
 */

export class OffscreenDictionaryWorkerHandler {
    constructor() {
        /** @type {DictionaryDatabase} */
        this._dictionaryDatabase = new DictionaryDatabase();
        /** @type {Translator} */
        this._translator = new Translator(this._dictionaryDatabase);
        /** @type {?Promise<void>} */
        this._prepareDatabasePromise = null;
        /** @type {boolean} */
        this._databaseSuspended = false;
        /** @type {DictionaryImporterMediaLoader} */
        this._mediaLoader = new DictionaryImporterMediaLoader();
        /** @type {Promise<void>} */
        this._requestQueue = Promise.resolve();
        /** @type {Set<Promise<void>>} */
        this._activeConcurrentLookupPromises = new Set();
        /** @type {number} */
        this._queuedExclusiveRequestCount = 0;
        /** @type {number} */
        this._queuedImportRequestCount = 0;
        /** @type {number} */
        this._queuedImportCancellationCount = 0;
        /** @type {AbortController|null} */
        this._activeImportAbortController = null;
    }

    /** */
    prepare() {
        self.addEventListener('message', this._onMessage.bind(this), false);
        self.addEventListener('messageerror', this._onMessageError.bind(this), false);
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureDatabasePrepared() {
        if (this._databaseSuspended) {
            throw new Error('Dictionary database access is suspended while import is in progress');
        }
        if (this._dictionaryDatabase.isPrepared()) {
            return;
        }
        if (this._prepareDatabasePromise !== null) {
            await this._prepareDatabasePromise;
            return;
        }
        this._prepareDatabasePromise = (async () => {
            await this._dictionaryDatabase.prepare();
            this._translator.prepare();
        })();
        try {
            await this._prepareDatabasePromise;
        } finally {
            this._prepareDatabasePromise = null;
        }
    }

    /**
     * @param {MessageEvent<WorkerRequest>} event
     */
    _onMessage(event) {
        const action = event.data.action;
        const policy = getDictionaryRuntimeActionPolicy(action);
        if (policy.concurrency === 'cancellation') {
            void this._onMessageAsync(event).catch((error) => {
                log.error(error);
            });
            return;
        }
        if (policy.concurrency === 'streamed-import') {
            ++this._queuedImportRequestCount;
        }
        if (
            policy.concurrency === 'lookup' &&
            this._queuedExclusiveRequestCount === 0 &&
            this._activeImportAbortController === null
        ) {
            this._startConcurrentLookup(event);
            return;
        }
        if (policy.concurrency === 'lookup') {
            // Preserve ordering with mutations that were already queued, but
            // do not turn reads waiting behind that mutation into additional
            // exclusive work. Once the mutation drains, all adjacent reads can
            // fan out and a later mutation will wait for the active read set.
            this._requestQueue = this._requestQueue
                .then(() => {
                    this._startConcurrentLookup(event);
                })
                .catch((error) => {
                    log.error(error);
                });
            return;
        }
        ++this._queuedExclusiveRequestCount;
        this._requestQueue = this._requestQueue
            .then(async () => {
                const activeLookupPromises = [...this._activeConcurrentLookupPromises];
                if (activeLookupPromises.length > 0) {
                    await Promise.allSettled(activeLookupPromises);
                }
                await this._onMessageAsync(event);
            })
            .catch((error) => {
                log.error(error);
            })
            .finally(() => {
                --this._queuedExclusiveRequestCount;
            });
    }

    /**
     * @param {MessageEvent<WorkerRequest>} event
     * @returns {void}
     */
    _startConcurrentLookup(event) {
        const lookupPromise = this._onMessageAsync(event);
        this._activeConcurrentLookupPromises.add(lookupPromise);
        void lookupPromise
            .catch((error) => {
                log.error(error);
            })
            .finally(() => {
                this._activeConcurrentLookupPromises.delete(lookupPromise);
            });
    }

    /**
     * @param {MessageEvent<WorkerRequest>} event
     */
    async _onMessageAsync(event) {
        const {id, action, params} = event.data;
        /** @type {WorkerResponse} */
        const response = {id};
        try {
            response.result = await this._invokeAction(action, params ?? {}, [...event.ports]);
        } catch (e) {
            response.error = ExtensionError.serialize(e);
        }
        self.postMessage(response);
    }

    /**
     * @param {MessageEvent<WorkerRequest>} event
     */
    _onMessageError(event) {
        const error = new ExtensionError('Offscreen dictionary worker: Error receiving message');
        error.data = event;
        log.error(error);
    }

    /**
     * @param {string} action
     * @throws {Error}
     */
    _assertDatabaseAvailable(action) {
        if (this._databaseSuspended) {
            throw new Error(`Cannot execute ${action}: dictionary database access is suspended while import is in progress`);
        }
    }

    /**
     * @param {MessagePort} port
     * @param {unknown} progress
     * @returns {boolean}
     */
    _postImportProgress(port, progress) {
        return this._postImportPortMessage(port, {type: 'progress', progress});
    }

    /**
     * @param {MessagePort} port
     * @param {unknown} result
     * @returns {boolean}
     */
    _postImportComplete(port, result) {
        return this._postImportPortMessage(port, {type: 'complete', result});
    }

    /**
     * @param {MessagePort} port
     * @param {unknown} error
     * @returns {boolean}
     */
    _postImportError(port, error) {
        return this._postImportPortMessage(port, {
            type: 'error',
            error: ExtensionError.serialize(error),
        });
    }

    /**
     * @param {MessagePort} port
     * @param {unknown} message
     * @returns {boolean}
     */
    _postImportPortMessage(port, message) {
        try {
            port.postMessage(message);
            return true;
        } catch (error) {
            log.warn(error);
            return false;
        }
    }

    /**
     * @returns {boolean} Whether the consumed import should start cancelled.
     */
    _consumeQueuedImportRequest() {
        if (this._queuedImportRequestCount > 0) {
            --this._queuedImportRequestCount;
        }
        if (this._queuedImportCancellationCount <= 0) {
            return false;
        }
        --this._queuedImportCancellationCount;
        return true;
    }

    /**
     * @param {import('dictionary-importer').ImportDetails} details
     * @param {ArrayBuffer|Blob|null} archiveContent
     * @param {MessagePort} port
     * @returns {Promise<void>}
     */
    async _importDictionaryOffscreen(details, archiveContent, port) {
        let queuedRequestAccounted = true;
        /** @type {AbortController|null} */
        let abortController = null;
        let responsePortAvailable = true;
        /** @param {import('dictionary-importer').ProgressData} progress */
        const onProgress = (progress) => {
            if (!responsePortAvailable) { return; }
            responsePortAvailable = this._postImportProgress(port, progress);
        };
        try {
            this._assertDatabaseAvailable('importDictionaryOffscreen');
            await this._ensureDatabasePrepared();
            if (this._activeImportAbortController !== null) {
                throw new Error('A dictionary import is already active');
            }
            abortController = new AbortController();
            this._activeImportAbortController = abortController;
            const startCancelled = this._consumeQueuedImportRequest();
            queuedRequestAccounted = false;
            if (startCancelled) {
                abortController.abort();
            }
            const dictionaryImporter = new DictionaryImporter(this._mediaLoader, onProgress, () => abortController?.signal.aborted === true);
            const importPayload = await dictionaryImporter.importDictionary(this._dictionaryDatabase, archiveContent, details);
            const {result, errors, debug} = importPayload;
            // Publish completion only after lookups can no longer observe cached
            // translations from the pre-import dictionary generation.
            this._translator.clearDatabaseCaches();
            const completionDelivered = this._postImportComplete(port, {
                result,
                errors: errors.map((error) => ExtensionError.serialize(error)),
                debug: {
                    usesFallbackStorage: this._dictionaryDatabase.usesFallbackStorage(),
                    openStorageDiagnostics: (
                        typeof this._dictionaryDatabase.getOpenStorageDiagnostics === 'function' ?
                            this._dictionaryDatabase.getOpenStorageDiagnostics() :
                            null
                    ),
                    useImportSession: Reflect.get(details, 'useImportSession') === true,
                    finalizeImportSession: Reflect.get(details, 'finalizeImportSession') === true,
                    importerDebug: debug ?? null,
                },
            });
            if (!completionDelivered && responsePortAvailable) {
                this._postImportError(port, new Error('Dictionary import completed but its result could not be delivered'));
            }
        } catch (error) {
            this._postImportError(port, error);
        } finally {
            if (queuedRequestAccounted) {
                this._consumeQueuedImportRequest();
            }
            if (abortController !== null && this._activeImportAbortController === abortController) {
                this._activeImportAbortController = null;
            }
            try {
                port.close();
            } catch (_) {
                // Ignore close failures for dead import response ports.
            }
        }
    }

    /**
     * @param {string} action
     * @param {import('core').SerializableObject} params
     * @param {MessagePort[]} ports
     * @returns {Promise<unknown>}
     */
    async _invokeAction(action, params, ports) {
        if (getDictionaryRuntimeActionPolicy(action).requiresDatabase) {
            this._assertDatabaseAvailable(action);
        }
        switch (action) {
            case 'databasePrepareOffscreen':
                await this._ensureDatabasePrepared();
                return;
            case 'getDatabaseRuntimeStateOffscreen':
                return {
                    isPrepared: this._dictionaryDatabase.isPrepared(),
                    usesFallbackStorage: this._dictionaryDatabase.usesFallbackStorage(),
                    openStorageDiagnostics: (
                        typeof this._dictionaryDatabase.getOpenStorageDiagnostics === 'function' ?
                            this._dictionaryDatabase.getOpenStorageDiagnostics() :
                            null
                    ),
                };
            case 'databaseSetSuspendedOffscreen': {
                const suspended = params.suspended === true;
                if (suspended) {
                    this._databaseSuspended = true;
                    if (this._dictionaryDatabase.isPrepared()) {
                        await this._dictionaryDatabase.close();
                    }
                    this._translator.clearDatabaseCaches();
                    return;
                }
                this._databaseSuspended = false;
                await this._ensureDatabasePrepared();
                this._translator.prepare();
                return;
            }
            case 'getDictionaryInfoOffscreen':
                await this._ensureDatabasePrepared();
                return await this._dictionaryDatabase.getDictionaryInfo();
            case 'deleteDictionaryOffscreen':
                await this._ensureDatabasePrepared();
                await this._dictionaryDatabase.deleteDictionary(/** @type {string} */ (params.dictionaryTitle ?? ''), 1000, () => {});
                return;
            case 'replaceDictionaryTitleOffscreen':
                await this._ensureDatabasePrepared();
                await this._dictionaryDatabase.replaceDictionaryTitle(
                    /** @type {string} */ (params.fromDictionaryTitle ?? ''),
                    /** @type {string} */ (params.toDictionaryTitle ?? ''),
                    /** @type {import('dictionary-importer').Summary|null} */ (params.summaryOverride ?? null),
                    /** @type {string|null} */ (params.replacedDictionaryTitle ?? null),
                );
                return;
            case 'getDictionaryCountsOffscreen':
                await this._ensureDatabasePrepared();
                return await this._dictionaryDatabase.getDictionaryCounts(
                    /** @type {string[]} */ (params.dictionaryNames ?? []),
                    params.getTotal === true,
                );
            case 'getDictionaryTermProbeOffscreen':
                await this._ensureDatabasePrepared();
                return await this._dictionaryDatabase.getDictionaryTermProbe(
                    /** @type {string} */ (params.dictionaryTitle ?? ''),
                );
            case 'findTermsBulkOffscreen':
                await this._ensureDatabasePrepared();
                return await this._dictionaryDatabase.findTermsBulk(
                    /** @type {string[]} */ (params.termList ?? []),
                    new Set(/** @type {string[]} */ (params.dictionaryNames ?? [])),
                    /** @type {import('dictionary-database').MatchType} */ (params.matchType ?? 'exact'),
                );
            case 'warmTermLookupCachesOffscreen':
                await this._ensureDatabasePrepared();
                await this._dictionaryDatabase.warmTermLookupCaches(
                    /** @type {string[]} */ (params.dictionaryNames ?? []),
                );
                return;
            case 'debugDictionaryStorageStateOffscreen':
                await this._ensureDatabasePrepared();
                {
                    const termRecordStore = Reflect.get(this._dictionaryDatabase, '_termRecordStore');
                    const getShardFileNames = Reflect.get(termRecordStore, 'getShardFileNames');
                    return {
                        dictionaryRows: await this._dictionaryDatabase.debugGetDictionaryRows(),
                        lastReplaceDictionaryTitleDebug: (
                            typeof this._dictionaryDatabase.getLastReplaceDictionaryTitleDebug === 'function' ?
                                this._dictionaryDatabase.getLastReplaceDictionaryTitleDebug() :
                                null
                        ),
                        startupCleanupIncompleteImportsSummary: (
                            typeof this._dictionaryDatabase.getStartupCleanupIncompleteImportsSummary === 'function' ?
                                this._dictionaryDatabase.getStartupCleanupIncompleteImportsSummary() :
                                null
                        ),
                        startupCleanupMissingTermRecordShardsSummary: (
                            typeof this._dictionaryDatabase.getStartupCleanupMissingTermRecordShardsSummary === 'function' ?
                                this._dictionaryDatabase.getStartupCleanupMissingTermRecordShardsSummary() :
                                null
                        ),
                        termRecordShardFileNames: (
                            typeof getShardFileNames === 'function' ?
                                getShardFileNames.call(termRecordStore) :
                                []
                        ),
                    };
                }
            case 'debugDictionaryLookupStateOffscreen':
                await this._ensureDatabasePrepared();
                return await this._debugDictionaryLookupState(
                    /** @type {string} */ (params.text ?? ''),
                    /** @type {string[]} */ (params.dictionaryNames ?? []),
                );
            case 'databasePurgeOffscreen':
                await this._ensureDatabasePrepared();
                return await this._dictionaryDatabase.purge();
            case 'databaseRefreshOffscreen':
                if (this._dictionaryDatabase.isPrepared()) {
                    await this._dictionaryDatabase.close();
                }
                this._translator.clearDatabaseCaches();
                await this._ensureDatabasePrepared();
                return;
            case 'databaseGetMediaOffscreen': {
                await this._ensureDatabasePrepared();
                const targets = /** @type {import('dictionary-database').MediaRequest[]} */ (params.targets ?? []);
                const media = await this._dictionaryDatabase.getMedia(targets);
                return media.map((m) => ({...m, content: arrayBufferToBase64(m.content)}));
            }
            case 'translatorPrepareOffscreen':
                await this._ensureDatabasePrepared();
                this._translator.prepare();
                return;
            case 'findKanjiOffscreen': {
                await this._ensureDatabasePrepared();
                const options = /** @type {import('offscreen').FindKanjiOptionsOffscreen} */ (params.options);
                /** @type {import('translation').FindKanjiOptions} */
                const modifiedOptions = {
                    ...options,
                    enabledDictionaryMap: new Map(options.enabledDictionaryMap),
                };
                const text = /** @type {string} */ (params.text ?? '');
                return await this._translator.findKanji(text, modifiedOptions);
            }
            case 'findTermsOffscreen': {
                await this._ensureDatabasePrepared();
                const mode = /** @type {import('translator').FindTermsMode} */ (params.mode);
                const text = /** @type {string} */ (params.text ?? '');
                const options = /** @type {import('offscreen').FindTermsOptionsOffscreen} */ (params.options);
                const enabledDictionaryMap = new Map(options.enabledDictionaryMap);
                const excludeDictionaryDefinitions = (
                    options.excludeDictionaryDefinitions !== null ?
                        new Set(options.excludeDictionaryDefinitions) :
                        null
                );
                const textReplacements = options.textReplacements.map((group) => {
                    if (group === null) { return null; }
                    return group.map((opt) => {
                        const {source, flags} = opt.pattern;
                        return {...opt, pattern: new RegExp(source, flags)};
                    });
                });
                /** @type {import('translation').FindTermsOptions} */
                const modifiedOptions = {
                    ...options,
                    enabledDictionaryMap,
                    excludeDictionaryDefinitions,
                    textReplacements,
                };
                return await this._translator.findTerms(mode, text, modifiedOptions);
            }
            case 'findTermsStructuredOffscreen':
                await this._ensureDatabasePrepared();
                return await this._translator.findTerms(
                    /** @type {import('translator').FindTermsMode} */ (params.mode),
                    /** @type {string} */ (params.text ?? ''),
                    /** @type {import('translation').FindTermsOptions} */ (params.options),
                );
            case 'getTermFrequenciesOffscreen':
                await this._ensureDatabasePrepared();
                return await this._translator.getTermFrequencies(
                    /** @type {import('translator').TermReadingList} */ (params.termReadingList ?? []),
                    /** @type {string[]} */ (params.dictionaries ?? []),
                );
            case 'clearDatabaseCachesOffscreen':
                this._translator.clearDatabaseCaches();
                return;
            case 'cancelDictionaryImportOffscreen':
                if (this._activeImportAbortController !== null) {
                    this._activeImportAbortController.abort();
                } else if (this._queuedImportCancellationCount < this._queuedImportRequestCount) {
                    ++this._queuedImportCancellationCount;
                }
                return;
            case 'importDictionaryOffscreen':
                if (ports.length === 0) {
                    this._consumeQueuedImportRequest();
                    throw new Error('Offscreen import response port missing');
                }
                await this._importDictionaryOffscreen(
                    /** @type {import('dictionary-importer').ImportDetails} */ (params.details),
                    /** @type {ArrayBuffer|Blob|null} */ (params.archiveContent ?? null),
                    ports[0],
                );
                return;
            case 'connectToDatabaseWorker':
                await this._ensureDatabasePrepared();
                if (ports.length > 0) {
                    await this._dictionaryDatabase.connectToDatabaseWorker(ports[0]);
                }
                return;
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    /**
     * @param {string} text
     * @param {string[]} dictionaryNames
     * @returns {Promise<unknown>}
     */
    async _debugDictionaryLookupState(text, dictionaryNames) {
        const findDirectTermIds = Reflect.get(this._dictionaryDatabase, '_findDirectTermIds');
        const fetchTermRowsByIds = Reflect.get(this._dictionaryDatabase, '_fetchTermRowsByIds');
        const requireDb = Reflect.get(this._dictionaryDatabase, '_requireDb');
        const ensureRecordDictionariesLoaded = Reflect.get(this._dictionaryDatabase, '_ensureDirectTermIndexesLoaded');
        if (typeof findDirectTermIds !== 'function' || typeof fetchTermRowsByIds !== 'function') {
            return {ok: false, reason: 'debug lookup unavailable', text, dictionaryNames};
        }
        if (typeof ensureRecordDictionariesLoaded === 'function') {
            await ensureRecordDictionariesLoaded.call(this._dictionaryDatabase, dictionaryNames);
        }
        /** @type {Map<number, {dictionary: string, matchSource: string}>} */
        const ids = new Map();
        /** @type {Array<Record<string, unknown>>} */
        const directHits = [];
        const termRecordStore = Reflect.get(this._dictionaryDatabase, '_termRecordStore');
        const getRecordById = Reflect.get(termRecordStore, 'getById');
        const textDecoder = new TextDecoder();
        /** @type {Map<string, Record<string, unknown>>} */
        const sqlRowsByKey = new Map();
        if (typeof requireDb === 'function') {
            try {
                const db = requireDb.call(this._dictionaryDatabase);
                for (const dictionaryNameRaw of dictionaryNames) {
                    const dictionaryName = String(dictionaryNameRaw || '').trim();
                    if (dictionaryName.length === 0) { continue; }
                    const rows = /** @type {Array<Record<string, unknown>>} */ (db.selectObjects(
                        `
                            SELECT
                                dictionary,
                                expression,
                                reading,
                                entryContentId,
                                entryContentOffset,
                                entryContentLength
                            FROM terms
                            WHERE dictionary = $dictionary AND (expression = $text OR reading = $text)
                            LIMIT 10
                        `,
                        {$dictionary: dictionaryName, $text: text},
                    ));
                    for (const row of rows) {
                        const key = this._createDebugTermRowKey(row.dictionary, row.expression, row.reading);
                        if (!sqlRowsByKey.has(key)) {
                            sqlRowsByKey.set(key, {
                                dictionary: row.dictionary ?? null,
                                expression: row.expression ?? null,
                                reading: row.reading ?? null,
                                entryContentId: row.entryContentId ?? null,
                                entryContentOffset: row.entryContentOffset ?? null,
                                entryContentLength: row.entryContentLength ?? null,
                            });
                        }
                    }
                }
            } catch (_) {
                // NOP
            }
        }
        for (const dictionaryNameRaw of dictionaryNames) {
            const dictionaryName = String(dictionaryNameRaw || '').trim();
            if (dictionaryName.length === 0) { continue; }
            const expressionIds = /** @type {number[]} */ (
                findDirectTermIds.call(this._dictionaryDatabase, dictionaryName, text, 'expression')
            );
            const readingIds = /** @type {number[]} */ (
                findDirectTermIds.call(this._dictionaryDatabase, dictionaryName, text, 'reading')
            );
            for (const id of expressionIds) {
                if (typeof id === 'number' && id > 0 && !ids.has(id)) {
                    ids.set(id, {dictionary: dictionaryName, matchSource: 'expression'});
                }
            }
            for (const id of readingIds) {
                if (typeof id === 'number' && id > 0 && !ids.has(id)) {
                    ids.set(id, {dictionary: dictionaryName, matchSource: 'reading'});
                }
            }
            directHits.push({
                dictionary: dictionaryName,
                expressionHitCount: expressionIds.length,
                readingHitCount: readingIds.length,
                firstExpressionIds: expressionIds.slice(0, 5),
                firstReadingIds: readingIds.slice(0, 5),
            });
        }
        const rowsById = await fetchTermRowsByIds.call(this._dictionaryDatabase, ids.keys());
        /** @type {Array<Record<string, unknown>>} */
        const rowSample = [];
        for (const [id, match] of ids) {
            const row = rowsById.get(id);
            const rawRecord = (typeof getRecordById === 'function') ? getRecordById.call(termRecordStore, id) : null;
            let rawContentPreview = null;
            let decodedContentDebug = null;
            let readErrorDetails = null;
            if (
                rawRecord &&
                typeof rawRecord.entryContentOffset === 'number' &&
                rawRecord.entryContentOffset >= 0 &&
                typeof rawRecord.entryContentLength === 'number' &&
                rawRecord.entryContentLength > 0
            ) {
                try {
                    const bytes = await this._dictionaryDatabase.readRawTermContentBytesForDiagnostics(
                        rawRecord.entryContentOffset,
                        Math.min(rawRecord.entryContentLength, 120),
                    );
                    if (!(bytes instanceof Uint8Array)) {
                        rawContentPreview = '<read-null>';
                        readErrorDetails = this._dictionaryDatabase.getTermContentDiagnostics().opfsReadError;
                    } else {
                        rawContentPreview = textDecoder.decode(bytes).replaceAll(/\s+/g, ' ').slice(0, 120);
                    }
                    const decodedBytes = await this._dictionaryDatabase.readTermEntryContentBytesForDiagnostics(
                        rawRecord.entryContentOffset,
                        rawRecord.entryContentLength,
                        rawRecord.entryContentDictName ?? '',
                    );
                    decodedContentDebug = decodedBytes instanceof Uint8Array ?
                        {
                            length: decodedBytes.byteLength,
                            prefixBytes: [...decodedBytes.subarray(0, 24)],
                            textPrefix: textDecoder.decode(decodedBytes.subarray(0, 120)).replaceAll(/\s+/g, ' ').slice(0, 120),
                        } :
                        {length: null, prefixBytes: null, textPrefix: '<read-null>'};
                } catch (_) {
                    rawContentPreview = '<read-failed>';
                    readErrorDetails = this._dictionaryDatabase.getTermContentDiagnostics().opfsReadError;
                }
            }
            rowSample.push({
                id,
                dictionary: row?.dictionary ?? match.dictionary,
                matchSource: match.matchSource,
                expression: row?.expression ?? '',
                reading: row?.reading ?? '',
                glossaryLength: Array.isArray(row?.glossary) ? row.glossary.length : null,
                rawEntryContentOffset: rawRecord?.entryContentOffset ?? null,
                rawEntryContentLength: rawRecord?.entryContentLength ?? null,
                rawEntryContentDictName: rawRecord?.entryContentDictName ?? null,
                sqlTermRow: sqlRowsByKey.get(this._createDebugTermRowKey(row?.dictionary ?? match.dictionary, row?.expression, row?.reading)) ?? null,
                rawContentPreview,
                decodedContentDebug,
                readErrorDetails,
            });
            if (rowSample.length >= 10) { break; }
        }
        return {
            ok: true,
            text,
            dictionaryNames,
            directHits,
            rowSample,
            termContentDiagnostics: this._dictionaryDatabase.getTermContentDiagnostics(dictionaryNames),
        };
    }

    /**
     * @param {unknown} dictionary
     * @param {unknown} expression
     * @param {unknown} reading
     * @returns {string}
     */
    _createDebugTermRowKey(dictionary, expression, reading) {
        return `${this._debugValueToKeyPart(dictionary)}\u0000${this._debugValueToKeyPart(expression)}\u0000${this._debugValueToKeyPart(reading)}`;
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    _debugValueToKeyPart(value) {
        return (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ?
                String(value) :
                ''
        );
    }
}

/** Entry point. */
function main() {
    const handler = new OffscreenDictionaryWorkerHandler();
    handler.prepare();
}

main();
