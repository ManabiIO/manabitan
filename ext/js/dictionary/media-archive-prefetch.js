/*
 * Copyright (C) 2026  Yomitan Authors
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

const MEDIA_ARCHIVE_PREFETCH_MAX_BYTES = 32 * 1024 * 1024;
const MEDIA_ARCHIVE_LOW_MEMORY_PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_ARCHIVE_PREFETCH_CONCURRENCY = 1;

/** @typedef {import('dictionary-importer').ImportFileEntry} ImportFileEntry */

/**
 * Owns a bounded set of speculative media ZIP reads. Read failures are stored
 * as values so an unused archive entry cannot fail an otherwise valid import.
 */
export class MediaArchivePrefetch {
    /**
     * @param {{
     *   entries: Array<{path: string, file: ImportFileEntry}>,
     *   read: (file: ImportFileEntry, signal: AbortSignal) => Promise<Uint8Array>,
     *   deviceMemory?: number,
     *   maxBytes?: number,
     *   concurrency?: number,
     * }} options
     */
    constructor({
        entries,
        read,
        deviceMemory = MediaArchivePrefetch.getDeviceMemory(),
        maxBytes,
        concurrency = MEDIA_ARCHIVE_PREFETCH_CONCURRENCY,
    }) {
        /** @type {(file: ImportFileEntry, signal: AbortSignal) => Promise<Uint8Array>} */
        this._read = read;
        /** @type {number} */
        let effectiveMaxBytes;
        if (typeof maxBytes === 'number') {
            effectiveMaxBytes = Math.max(0, Math.trunc(maxBytes));
        } else {
            effectiveMaxBytes = (
                typeof deviceMemory === 'number' &&
                Number.isFinite(deviceMemory) &&
                deviceMemory <= 4
            ) ?
                MEDIA_ARCHIVE_LOW_MEMORY_PREFETCH_MAX_BYTES :
                MEDIA_ARCHIVE_PREFETCH_MAX_BYTES;
        }
        /** @type {number} */
        this._maxBytes = effectiveMaxBytes;
        /** @type {number} */
        this._concurrency = Math.max(1, Math.trunc(concurrency));
        /** @type {Map<string, MediaPrefetchState>} */
        this._statesByPath = new Map();
        /** @type {MediaPrefetchState[]} */
        this._states = [];
        /** @type {MediaPrefetchState[]} */
        this._priorityStates = [];
        /** @type {number} */
        this._nextStateIndex = 0;
        /** @type {Promise<void>[]|null} */
        this._workers = null;
        /** @type {Promise<void>|null} */
        this._disposePromise = null;
        /** @type {boolean} */
        this._disposed = false;
        /** @type {number} */
        this._plannedBytes = 0;
        /** @type {number} */
        this._loadedBytes = 0;
        /** @type {number} */
        this._totalLoadedBytes = 0;
        /** @type {number} */
        this._completedCount = 0;
        /** @type {number} */
        this._failedCount = 0;
        /** @type {number} */
        this._hitCount = 0;

        /** @type {Map<ImportFileEntry, MediaPrefetchState>} */
        const statesByFile = new Map();
        for (const {path, file} of entries) {
            if (this._statesByPath.has(path)) { continue; }
            let state = statesByFile.get(file);
            if (typeof state === 'undefined') {
                const estimatedBytes = this._getEstimatedBytes(file);
                if (
                    estimatedBytes <= 0 ||
                    estimatedBytes > this._maxBytes ||
                    this._plannedBytes + estimatedBytes > this._maxBytes
                ) {
                    continue;
                }
                /** @type {(outcome: MediaPrefetchOutcome) => void} */
                let resolveOutcome = () => {};
                /** @type {Promise<MediaPrefetchOutcome>} */
                const outcomePromise = new Promise((resolve) => { resolveOutcome = resolve; });
                state = {
                    file,
                    paths: new Set(),
                    status: 'pending',
                    priorityQueued: false,
                    abortController: null,
                    outcome: null,
                    outcomePromise,
                    resolveOutcome,
                };
                statesByFile.set(file, state);
                this._states.push(state);
                this._plannedBytes += estimatedBytes;
            }
            state.paths.add(path);
            this._statesByPath.set(path, state);
        }
    }

    /**
     * @returns {{fileCount: number, pathCount: number, estimatedBytes: number, maxBytes: number}}
     * @throws {Error} If prefetch has been disposed.
     */
    start() {
        if (this._disposed) {
            throw new Error('Media archive prefetch is disposed');
        }
        if (this._workers === null) {
            this._workers = Array.from({length: Math.min(this._concurrency, this._states.length)}, async () => {
                await this._runWorker();
            });
        }
        return {
            fileCount: this._states.length,
            pathCount: this._statesByPath.size,
            estimatedBytes: this._plannedBytes,
            maxBytes: this._maxBytes,
        };
    }

    /**
     * Returns prefetched bytes once for a path, or null when the path was not
     * admitted to the bounded plan. A speculative read error becomes visible
     * only when its path is actually required.
     * @param {string} path
     * @returns {Promise<Uint8Array|null>}
     */
    async consume(path) {
        if (this._disposed) {
            throw new Error('Media archive prefetch is disposed');
        }
        const state = this._statesByPath.get(path);
        if (typeof state === 'undefined') { return null; }
        this._statesByPath.delete(path);
        state.paths.delete(path);
        ++this._hitCount;
        if (state.status === 'pending' && !state.priorityQueued) {
            state.priorityQueued = true;
            this._priorityStates.push(state);
        }
        this.start();
        const outcome = await state.outcomePromise;
        if (outcome.error !== null) { throw outcome.error; }
        const bytes = outcome.bytes;
        if (state.paths.size === 0 && state.outcome !== null) {
            this._loadedBytes -= state.outcome.bytes?.byteLength ?? 0;
            state.outcome.bytes = null;
        }
        return bytes;
    }

    /** @returns {{plannedFiles: number, plannedBytes: number, retainedBytes: number, totalLoadedBytes: number, completedCount: number, failedCount: number, hitCount: number}} */
    getStats() {
        return {
            plannedFiles: this._states.length,
            plannedBytes: this._plannedBytes,
            retainedBytes: this._loadedBytes,
            totalLoadedBytes: this._totalLoadedBytes,
            completedCount: this._completedCount,
            failedCount: this._failedCount,
            hitCount: this._hitCount,
        };
    }

    /** @returns {Promise<void>} */
    dispose() {
        this._disposed = true;
        this._disposePromise ??= (async () => {
            for (const state of this._states) {
                state.abortController?.abort();
                if (state.status === 'pending') {
                    state.status = 'settled';
                    const outcome = {bytes: null, error: null};
                    state.outcome = outcome;
                    state.resolveOutcome(outcome);
                }
            }
            if (this._workers !== null) {
                await Promise.all(this._workers);
            }
            for (const state of this._states) {
                if (state.status === 'loading') {
                    await state.outcomePromise;
                }
                if (state.outcome !== null) { state.outcome.bytes = null; }
                state.paths.clear();
            }
            this._statesByPath.clear();
            this._priorityStates.length = 0;
            this._loadedBytes = 0;
        })();
        return this._disposePromise;
    }

    /** @returns {Promise<void>} */
    async _runWorker() {
        while (!this._disposed) {
            const state = this._takeNextState();
            if (state === null) { return; }
            await this._load(state);
        }
    }

    /** @returns {MediaPrefetchState|null} */
    _takeNextState() {
        while (this._priorityStates.length > 0) {
            const state = this._priorityStates.shift();
            if (typeof state !== 'undefined' && state.status === 'pending') {
                state.priorityQueued = false;
                return state;
            }
        }
        while (this._nextStateIndex < this._states.length) {
            const state = this._states[this._nextStateIndex++];
            if (state.status === 'pending') { return state; }
        }
        return null;
    }

    /**
     * @param {MediaPrefetchState} state
     * @returns {Promise<void>}
     */
    async _load(state) {
        if (state.status !== 'pending') { return; }
        state.status = 'loading';
        const abortController = new AbortController();
        state.abortController = abortController;
        /** @type {MediaPrefetchOutcome} */
        let outcome;
        try {
            const bytes = await this._read(state.file, abortController.signal);
            outcome = {bytes, error: null};
            this._loadedBytes += bytes.byteLength;
            this._totalLoadedBytes += bytes.byteLength;
            ++this._completedCount;
        } catch (error) {
            outcome = {bytes: null, error: error instanceof Error ? error : new Error(String(error))};
            ++this._failedCount;
        }
        state.abortController = null;
        state.status = 'settled';
        state.outcome = outcome;
        state.resolveOutcome(outcome);
    }

    /**
     * @param {ImportFileEntry} file
     * @returns {number}
     */
    _getEstimatedBytes(file) {
        const uncompressedSize = /** @type {unknown} */ (Reflect.get(file, 'uncompressedSize'));
        if (typeof uncompressedSize === 'number' && Number.isSafeInteger(uncompressedSize) && uncompressedSize > 0) {
            return uncompressedSize;
        }
        const bytes = /** @type {unknown} */ (Reflect.get(file, 'bytes'));
        return bytes instanceof Uint8Array ? bytes.byteLength : 0;
    }

    /** @returns {number|undefined} */
    static getDeviceMemory() {
        const deviceMemory = /** @type {unknown} */ (
            typeof navigator === 'undefined' ? void 0 : Reflect.get(navigator, 'deviceMemory')
        );
        return typeof deviceMemory === 'number' ? deviceMemory : void 0;
    }
}

/** @typedef {{bytes: Uint8Array|null, error: Error|null}} MediaPrefetchOutcome */

/**
 * @typedef {{
 *   file: ImportFileEntry,
 *   paths: Set<string>,
 *   status: 'pending'|'loading'|'settled',
 *   priorityQueued: boolean,
 *   abortController: AbortController|null,
 *   outcome: MediaPrefetchOutcome|null,
 *   outcomePromise: Promise<MediaPrefetchOutcome>,
 *   resolveOutcome: (outcome: MediaPrefetchOutcome) => void,
 * }} MediaPrefetchState
 */
