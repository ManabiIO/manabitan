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

import {toError} from '../core/to-error.js';

export class DictionaryImportSession {
    /**
     * @param {{
     *   dictionaryDatabase: import('./dictionary-database.js').DictionaryDatabase,
     *   dictionaryTitle: string,
     *   dictionarySummaryPrimaryKey: number,
     *   errors: Error[],
     *   archiveReader: {close: () => Promise<void>}|null,
     *   disposeParser: () => Promise<void>,
     * }} options
     */
    constructor({dictionaryDatabase, dictionaryTitle, dictionarySummaryPrimaryKey, errors, archiveReader, disposeParser}) {
        /** @type {import('./dictionary-database.js').DictionaryDatabase} */
        this._dictionaryDatabase = dictionaryDatabase;
        /** @type {string} */
        this._dictionaryTitle = dictionaryTitle;
        /** @type {number} */
        this._dictionarySummaryPrimaryKey = dictionarySummaryPrimaryKey;
        /** @type {Error[]} */
        this._errors = errors;
        /** @type {Set<Error>} */
        this._recordedErrors = new Set(errors);
        /** @type {{close: () => Promise<void>}|null} */
        this._archiveReader = archiveReader;
        /** @type {() => Promise<void>} */
        this._disposeParser = disposeParser;
        /** @type {{dispose: () => Promise<void>}|null} */
        this._sourcePipeline = null;
        /** @type {Promise<void>|null} */
        this._startPromise = null;
        /** @type {Promise<void>|null} */
        this._resourceDisposalPromise = null;
        /** @type {Promise<void>|null} */
        this._archiveClosePromise = null;
        /** @type {Promise<Record<string, unknown>|null>|null} */
        this._bulkFinalizationPromise = null;
        /** @type {Promise<void>|null} */
        this._placeholderCleanupPromise = null;
        /** @type {'idle'|'starting'|'active'|'committed'|'aborted'|'failed'} */
        this._bulkState = 'idle';
        /** @type {boolean} */
        this._published = false;
        /** @type {boolean} */
        this._failed = false;
        /** @type {boolean} */
        this._commitAttempted = false;
    }

    /** @returns {boolean} */
    get failed() {
        return this._failed;
    }

    /** @returns {string} */
    get state() {
        if (this._published) { return 'published'; }
        return this._bulkState;
    }

    /**
     * @param {{dispose: () => Promise<void>}} sourcePipeline
     * @throws {Error} If resources are already owned or being disposed.
     */
    setSourcePipeline(sourcePipeline) {
        if (this._sourcePipeline !== null && this._sourcePipeline !== sourcePipeline) {
            throw new Error('Dictionary import source pipeline is already owned');
        }
        if (this._resourceDisposalPromise !== null) {
            throw new Error('Dictionary import resources are already being disposed');
        }
        this._sourcePipeline = sourcePipeline;
    }

    /**
     * @param {unknown} error
     * @returns {Error}
     */
    recordFailure(error) {
        const normalizedError = toError(error);
        this._failed = true;
        if (!this._recordedErrors.has(normalizedError)) {
            this._recordedErrors.add(normalizedError);
            this._errors.push(normalizedError);
        }
        return normalizedError;
    }

    /** @returns {Promise<void>} */
    startBulkImport() {
        if (this._startPromise !== null) { return this._startPromise; }
        this._bulkState = 'starting';
        this._startPromise = (async () => {
            try {
                await this._dictionaryDatabase.startBulkImport();
                this._bulkState = 'active';
            } catch (error) {
                this._bulkState = 'failed';
                throw this.recordFailure(error);
            }
        })();
        return this._startPromise;
    }

    /**
     * Source reads and parser workers settle before the archive is closed.
     * @returns {Promise<void>}
     */
    disposeImportResources() {
        this._resourceDisposalPromise ??= (async () => {
            if (this._sourcePipeline !== null) {
                try {
                    await this._sourcePipeline.dispose();
                } catch (error) {
                    this.recordFailure(error);
                }
            }
            try {
                await this._disposeParser();
            } catch (error) {
                this.recordFailure(error);
            }
            try {
                await this.closeArchive();
            } catch (error) {
                const closeError = toError(error);
                this.recordFailure(new Error(`Failed to close dictionary archive: ${closeError.message}`));
            }
        })();
        return this._resourceDisposalPromise;
    }

    /** @returns {Promise<void>} */
    closeArchive() {
        if (this._archiveClosePromise === null) {
            const archiveReader = this._archiveReader;
            this._archiveReader = null;
            this._archiveClosePromise = archiveReader === null ?
                Promise.resolve() :
                Promise.resolve().then(async () => { await archiveReader.close(); });
        }
        return this._archiveClosePromise;
    }

    /**
     * @param {(checkpointIndex: number, total: number) => void} onCheckpoint
     * @param {import('dictionary-importer').Summary} summary
     * @returns {Promise<Record<string, unknown>|null>}
     */
    finalizeBulkImport(onCheckpoint, summary) {
        this._bulkFinalizationPromise ??= (async () => {
            try {
                await this.disposeImportResources();
                if (this._startPromise !== null) {
                    try {
                        await this._startPromise;
                    } catch (_) {
                        // startBulkImport already recorded the failure.
                    }
                }
                if (this._failed) {
                    await this._dictionaryDatabase.abortBulkImport();
                    this._bulkState = 'aborted';
                    return {aborted: true};
                }
                this._commitAttempted = true;
                const details = await this._dictionaryDatabase.finishBulkImport(onCheckpoint, {
                    summary,
                    primaryKey: this._dictionarySummaryPrimaryKey,
                });
                this._bulkState = 'committed';
                this._published = true;
                return details;
            } catch (error) {
                this._bulkState = 'failed';
                this.recordFailure(error);
                return null;
            }
        })();
        return this._bulkFinalizationPromise;
    }

    /** @returns {Promise<void>} */
    cleanupIncompleteSummary() {
        this._placeholderCleanupPromise ??= (async () => {
            if (!this._failed || this._published) { return; }
            try {
                await (this._commitAttempted ?
                    this._dictionaryDatabase.deleteDictionary(this._dictionaryTitle, 1000, () => {}) :
                    this._dictionaryDatabase.deleteDictionaryImportPlaceholder(this._dictionarySummaryPrimaryKey));
            } catch (error) {
                const cleanupError = toError(error);
                const target = this._commitAttempted ? 'partially imported dictionary' : 'incomplete dictionary summary';
                this.recordFailure(new Error(`Failed to remove ${target} ${this._dictionaryTitle}: ${cleanupError.message}`));
            }
        })();
        return this._placeholderCleanupPromise;
    }
}
