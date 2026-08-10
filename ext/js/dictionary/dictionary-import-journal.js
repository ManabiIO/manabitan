/*
 * Copyright (C) 2026 Manabitan authors
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

import {parseJson} from '../core/json.js';

const FILE_NAME = 'manabitan-dictionary-import-journal.json';
const JOURNAL_VERSION = 1;
const MAX_CHECKPOINT_FILES = 100000;

export class DictionaryImportJournal {
    /**
     * @returns {Promise<import('dictionary-import-journal').DictionaryImportJournalRecord|null>}
     */
    async read() {
        const root = await this._getRoot();
        if (root === null) { return null; }
        let handle;
        try {
            handle = await root.getFileHandle(FILE_NAME);
        } catch (error) {
            if (this._isNotFoundError(error)) { return null; }
            throw error;
        }
        const file = await handle.getFile();
        if (file.size <= 0) {
            throw new Error('Invalid empty dictionary import journal');
        }
        const value = /** @type {unknown} */ (parseJson(await file.text()));
        if (!this._isRecord(value)) {
            throw new Error('Invalid dictionary import journal');
        }
        return value;
    }

    /**
     * @param {import('dictionary-import-journal').DictionaryImportJournalRecord} record
     * @returns {Promise<void>}
     */
    async write(record) {
        if (!this._isRecord(record)) {
            throw new Error('Invalid dictionary import journal record');
        }
        const root = await this._getRoot();
        if (root === null) {
            throw new Error('Dictionary import journal requires OPFS');
        }
        const handle = await root.getFileHandle(FILE_NAME, {create: true});
        const writable = await handle.createWritable();
        try {
            await writable.write(JSON.stringify(record));
            await writable.close();
        } catch (error) {
            const writeError = error instanceof Error ? error : new Error(String(error));
            try {
                await writable.abort(writeError);
            } catch (abortError) {
                throw new AggregateError(
                    [
                        writeError,
                        abortError instanceof Error ? abortError : new Error(String(abortError)),
                    ],
                    'Dictionary import journal write and abort failed',
                );
            }
            throw writeError;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async clear() {
        const root = await this._getRoot();
        if (root === null) {
            throw new Error('Dictionary import journal requires OPFS');
        }
        try {
            await root.removeEntry(FILE_NAME);
        } catch (error) {
            if (!this._isNotFoundError(error)) { throw error; }
        }
    }

    /**
     * @returns {Promise<FileSystemDirectoryHandle|null>}
     */
    async _getRoot() {
        if (
            typeof navigator === 'undefined' ||
            !('storage' in navigator) ||
            typeof navigator.storage.getDirectory !== 'function'
        ) {
            return null;
        }
        return await navigator.storage.getDirectory();
    }

    /**
     * @param {unknown} value
     * @returns {value is import('dictionary-import-journal').DictionaryImportJournalRecord}
     */
    _isRecord(value) {
        if (typeof value !== 'object' || value === null) { return false; }
        const record = /** @type {Record<string, unknown>} */ (value);
        return (
            record.version === JOURNAL_VERSION &&
            typeof record.sessionId === 'string' &&
            record.sessionId.length > 0 &&
            record.sessionId.length <= 256 &&
            Number.isSafeInteger(record.createdAt) &&
            /** @type {number} */ (record.createdAt) >= 0 &&
            this._isCheckpoint(record.contentCheckpoint, 'segments') &&
            this._isCheckpoint(record.recordCheckpoint, 'shards')
        );
    }

    /**
     * @param {unknown} value
     * @param {'segments'|'shards'} key
     * @returns {boolean}
     */
    _isCheckpoint(value, key) {
        if (typeof value !== 'object' || value === null) { return false; }
        const checkpoint = /** @type {Record<string, unknown>} */ (value);
        const files = checkpoint[key];
        if (!Array.isArray(files) || files.length > MAX_CHECKPOINT_FILES) { return false; }
        const names = new Set();
        for (const file of files) {
            if (typeof file !== 'object' || file === null) { return false; }
            /** @type {unknown} */
            const checkpointFileValue = file;
            const checkpointFile = /** @type {Record<string, unknown>} */ (checkpointFileValue);
            const fileName = checkpointFile.fileName;
            const fileLength = checkpointFile.fileLength;
            if (
                typeof fileName !== 'string' ||
                fileName.length === 0 ||
                fileName.length > 512 ||
                fileName === '.' ||
                fileName === '..' ||
                /[/\\\0]/.test(fileName) ||
                names.has(fileName) ||
                !Number.isSafeInteger(fileLength) ||
                /** @type {number} */ (fileLength) < 0
            ) {
                return false;
            }
            names.add(fileName);
        }
        return true;
    }

    /**
     * @param {unknown} error
     * @returns {boolean}
     */
    _isNotFoundError(error) {
        return (
            (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'NotFoundError') ||
            (error instanceof Error && error.name === 'NotFoundError')
        );
    }
}

/**
 * @returns {string}
 */
export function createDictionaryImportSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
