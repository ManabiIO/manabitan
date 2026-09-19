/* SPDX-License-Identifier: GPL-3.0-or-later */
import {DictionaryDatabase} from '../js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../js/dictionary/dictionary-importer-media-loader.js';
import {Translator} from '../js/language/translator.js';
import {parseJson} from '../js/core/json.js';
import {API_VERSION, STORAGE_LOCK, MAX_ARCHIVE_BYTES, WebRuntimeError, isRequest, record, text, type Preferences, type Request, type Reply, type Status} from './protocol.js';
import type {TermEnabledDictionaryMap, FindTermsOptions} from '../../types/ext/translation';

const host = self as unknown as DedicatedWorkerGlobalScope;
const database = new DictionaryDatabase();
const translator = new Translator(database);
let ready = false;
let closing = false;
let current: {id: number, cancelled: boolean} | null = null;
const pending: Request[] = [];
const ids = new Set<number>();
let preferenceDirectory: FileSystemDirectoryHandle | undefined;
let preferences: Preferences = {version: 1, disabled: [], defaultChoice: 'unasked', defaultTitle: null};

/**
 *
 * @param id
 * @param value
 */
function reply(id: number, value: Omit<Reply, 'id' | 'version'>) {
    host.postMessage({version: API_VERSION, id, ...value});
}
/**
 *
 */
function abortIfCancelled() {
    if (closing || current?.cancelled) {throw new DOMException('Dictionary operation cancelled', 'AbortError');}
}
/**
 *
 * @param next
 */
async function writePreferences(next: Preferences) {
    if (!preferenceDirectory) {throw new Error('Dictionary settings are not open');}
    const file = await preferenceDirectory.getFileHandle('preferences.json', {create: true});
    const writer = await file.createWritable();
    try {
        await writer.write(JSON.stringify(next));
        await writer.close();
    } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
    }
    preferences = next;
}
/**
 *
 */
async function initializeStorage() {
    const root = await navigator.storage.getDirectory();
    preferenceDirectory = await root.getDirectoryHandle('manabitan-web', {create: true});
    try {
        const file = await (await preferenceDirectory.getFileHandle('preferences.json')).getFile();
        if (file.size > 1024 * 1024) {throw new Error('Dictionary settings are too large');}
        const value: unknown = parseJson(await file.text());
        let validDefaultTitle = record(value) && value.defaultTitle === null;
        if (record(value) && typeof value.defaultTitle === 'string') {
            validDefaultTitle = value.defaultTitle.length <= 256;
        }
        if (!record(value) || value.version !== 1 || !Array.isArray(value.disabled) || value.disabled.length > 4096 ||
            !value.disabled.every((name) => typeof name === 'string' && name.length <= 256) ||
            !['unasked', 'declined', 'installed', 'deleted'].includes(String(value.defaultChoice)) ||
            !validDefaultTitle) {
            throw new Error('Invalid dictionary settings; restore or reset them explicitly');
        }
        preferences = value as unknown as Preferences;
    } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) {throw error;}
    }
    await database.prepare();
    if (database.usesFallbackStorage()) {throw new WebRuntimeError('not_persistent', 'Persistent OPFS storage is required');}
    translator.prepare();
    ready = true;
}
/**
 *
 */
async function open() {
    if (ready) {return status();}
    if (!navigator.locks || !navigator.storage?.getDirectory) {
        throw new WebRuntimeError('unsupported', 'This browser does not provide OPFS and Web Locks for persistent dictionaries');
    }
    const wait = new AbortController();
    const timer = setTimeout(() => wait.abort(), 2500);
    // The lock covers SQLite, its SAH pool, term/content sidecars, journal and
    // preferences. It lasts until this worker dies, not merely DB.close().
    await new Promise<void>((resolve, reject) => {
        navigator.locks.request(STORAGE_LOCK, {mode: 'exclusive', signal: wait.signal}, async () => {
            clearTimeout(timer);
            try {
                await initializeStorage();
                resolve();
            } catch (error) {
                reject(error);
            }
            // Never unlock while SAH-pool handles can remain owned by this worker.
            await new Promise<void>(() => {});
        }).catch((error) => {
            clearTimeout(timer);
            reject(error instanceof DOMException && error.name === 'AbortError' ?
                new WebRuntimeError('storage_busy', 'The built-in dictionary is open in another Reader tab. Close its dictionary or switch that tab to extension/off, then retry.') :
error);
        });
    });
    return status();
}
/**
 *
 */
async function status(): Promise<Status> {
    const dictionaries = await database.getDictionaryInfo();
    const [counts, estimate, persisted] = await Promise.all([
        database.getDictionaryCounts(dictionaries.map((d) => d.title), true),
        navigator.storage.estimate(),
        navigator.storage.persisted(),
    ]);
    return {dictionaries, counts, preferences, storage: {usage: estimate.usage, quota: estimate.quota, persisted}};
}
/**
 *
 */
async function lookupOptions(): Promise<FindTermsOptions> {
    const enabledDictionaryMap: TermEnabledDictionaryMap = new Map();
    const info = await database.getDictionaryInfo();
    for (const [index, dictionary] of info.entries()) {
        if (!preferences.disabled.includes(dictionary.title) && dictionary.importSuccess !== false) {
            enabledDictionaryMap.set(dictionary.title, {index,
                alias: '',
                allowSecondarySearches: true,
                partsOfSpeechFilter: true,
                useDeinflections: true});
        }
    }
    return {matchType: 'exact',
        deinflect: true,
        primaryReading: '',
        mainDictionary: '',
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'ascending',
        removeNonJapaneseCharacters: true,
        textReplacements: [null],
        enabledDictionaryMap,
        excludeDictionaryDefinitions: null,
        searchResolution: 'letter',
        language: 'ja',
        useAllFrequencyDictionaries: true};
}
/**
 *
 * @param request
 */
async function dispatch(request: Request): Promise<unknown> {
    if (request.operation === 'open') {return open();}
    if (!ready) {throw new WebRuntimeError('not_open', 'Open the persistent dictionary runtime first');}
    const p = record(request.parameters) ? request.parameters : {};
    switch (request.operation) {
        case 'status': return status();
        case 'lookup': {
            const result = await translator.findTerms('group', text(p.text, 256), await lookupOptions());
            abortIfCancelled();
            // Bound UI work, without replacing the real translator or importer.
            return {...result, dictionaryEntries: result.dictionaryEntries.slice(0, 100)};
        }
        case 'import': {
            if (!(p.archive instanceof Blob) || p.archive.size <= 0 || p.archive.size > MAX_ARCHIVE_BYTES) {
                throw new WebRuntimeError('archive_size', 'Dictionary archive must be between 1 byte and 256 MiB');
            }
            const importer = new DictionaryImporter(
                new DictionaryImporterMediaLoader(),
                (progress) => reply(request.id, {progress}),
                () => !!current?.cancelled || closing,
            );
            const imported = await importer.importDictionary(database, p.archive, {
                prefixWildcardsSupported: true,
                yomitanVersion: '0.0.0.0',
                mediaResolutionConcurrency: 2,
                zipMaxWorkers: 2,
                zipUseWebWorkers: false,
            });
            translator.clearDatabaseCaches();
            if (!imported.result) {
                throw new WebRuntimeError('import_failed', imported.errors.map((e) => e.message).slice(0, 8).join('; ') || 'Dictionary import did not commit');
            }
            // Cancellation during commit is not a rollback. Report the committed
            // result; the caller must not claim that this dictionary was removed.
            return {summary: imported.result, warnings: imported.errors.map((error) => error.message).slice(0, 8), cancelledAfterCommit: !!current?.cancelled, status: await status()};
        }
        case 'delete': {
            const title = text(p.title);
            if (title === preferences.defaultTitle) {await writePreferences({...preferences, defaultChoice: 'deleted'});}
            await database.deleteDictionary(title, 1000, (progress) => reply(request.id, {progress}));
            translator.clearDatabaseCaches();
            return status();
        }
        case 'enable': {
            const title = text(p.title);
            if (typeof p.enabled !== 'boolean') {throw new WebRuntimeError('invalid_request', 'Expected dictionary enabled state');}
            const info = await database.getDictionaryInfo();
            if (!info.some((d) => d.title === title)) {throw new WebRuntimeError('not_found', 'Dictionary is not installed');}
            const disabled = new Set(preferences.disabled);
            if (p.enabled) {
                disabled.delete(title);
            } else {
                disabled.add(title);
            }
            await writePreferences({...preferences, disabled: [...disabled]});
            translator.clearDatabaseCaches();
            return status();
        }
        case 'default': {
            if (!['declined', 'installed', 'deleted'].includes(String(p.choice))) {throw new Error('Invalid default-dictionary choice');}
            const title = p.choice === 'installed' ? text(p.title) : preferences.defaultTitle;
            if (p.choice === 'installed' && !(await database.getDictionaryInfo()).some((d) => d.title === title)) {throw new Error('Default dictionary has not committed');}
            await writePreferences({...preferences, defaultChoice: p.choice as Preferences['defaultChoice'], defaultTitle: title});
            return status();
        }
        case 'media': {
            const result = await database.getMedia([{dictionary: text(p.dictionary), path: text(p.path, 4096)}]);
            return result[0] ?? null;
        }
        default: throw new WebRuntimeError('invalid_request', 'Unsupported dictionary operation');
    }
}
/**
 *
 */
async function drain() {
    if (current) {return;}
    while (pending.length > 0) {
        const request = pending.shift()!;
        current = {id: request.id, cancelled: false};
        try {
            if (request.operation === 'close') {
                await database.close();
                reply(request.id, {result: null});
                host.close();
                return;
            }
            abortIfCancelled();
            reply(request.id, {result: await dispatch(request)});
        } catch (error) {
            const e = error instanceof Error ? error : new Error(String(error));
            reply(request.id, {error: {name: e.name, message: e.message, ...e instanceof WebRuntimeError ? {code: e.code} : {}}});
        } finally {
            ids.delete(request.id);
            current = null;
        }
    }
}
host.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isRequest(event.data)) {return;}
    const message = event.data;
    if (message.operation === 'cancel') {
        if (current?.id === message.id) {current.cancelled = true;}
        const index = pending.findIndex((p) => p.id === message.id);
        if (index >= 0) {
            pending.splice(index, 1);
            ids.delete(message.id);
            reply(message.id, {error: {name: 'AbortError', message: 'Dictionary operation cancelled'}});
        }
        return;
    }
    if (ids.has(message.id)) {return;}
    if (message.operation === 'close') {
        closing = true;
        if (current) {current.cancelled = true;}
        for (const queued of pending.splice(0)) {
            ids.delete(queued.id);
            reply(queued.id, {error: {name: 'AbortError', message: 'Dictionary runtime closed'}});
        }
    } else if (closing || pending.length >= 32) {
        reply(message.id, {error: {name: 'WebRuntimeError', code: 'busy', message: 'Dictionary runtime is closing or busy'}});
        return;
    }
    ids.add(message.id);
    pending.push(message);
    void drain();
});
