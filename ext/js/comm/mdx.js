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

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {toError} from '../core/to-error.js';
import {arrayBufferToBase64, base64ToArrayBuffer} from '../data/array-buffer-util.js';

const HOST_NAME = 'manabitan_mdx';
const UPLOAD_CHUNK_BYTES = 128 * 1024;
const DOWNLOAD_CHUNK_BYTES = 128 * 1024;
const UNSUPPORTED_VARIANT_ERROR_MESSAGE = 'This MDX file uses an unsupported compression, encryption, or format variant. Update the experimental MDX helper or convert the dictionary externally first.';

export class Mdx {
    /** */
    constructor() {
        /** @type {?chrome.runtime.Port} */
        this._port = null;
        /** @type {number} */
        this._sequence = 0;
        /** @type {Map<number, {resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: import('core').Timeout}>} */
        this._invocations = new Map();
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {number} */
        this._timeout = 10 * 60 * 1000;
        /** @type {number} */
        this._version = 1;
        /** @type {?number} */
        this._remoteVersion = null;
        /** @type {?Promise<void>} */
        this._setupPortPromise = null;
    }

    /**
     * @returns {boolean}
     */
    isConnected() {
        return (this._port !== null);
    }

    /**
     * @returns {boolean}
     */
    isActive() {
        return (this._invocations.size > 0);
    }

    /**
     * @returns {number}
     */
    getLocalVersion() {
        return this._version;
    }

    /**
     * @returns {Promise<?number>}
     */
    async getVersion() {
        try {
            await this._setupPortWrapper();
            const version = await this._invoke('get_version', {});
            this._remoteVersion = (typeof version === 'number' && Number.isFinite(version)) ? version : null;
        } catch (_error) {
            // NOP
        }
        return this._remoteVersion;
    }

    /** */
    disconnect() {
        if (this._port !== null) {
            this._clearPort();
        }
    }

    /**
     * @param {{mdxFile: File, mddFiles?: File[], titleOverride?: string, descriptionOverride?: string, revision?: string, enableAudio?: boolean, includeAssets?: boolean, termBankSize?: number}} details
     * @param {?(details: {stage: 'upload'|'convert'|'download', completed: number, total: number}) => void} onProgress
     * @returns {Promise<{archiveContent: ArrayBuffer, archiveFileName: string}>}
     */
    async convertDictionary(details, onProgress = null) {
        const {
            mdxFile,
            mddFiles = [],
            titleOverride = '',
            descriptionOverride = '',
            revision = '',
            enableAudio = false,
            includeAssets = true,
            termBankSize = 10000,
        } = details;
        await this._setupPortWrapper();

        const uploadFiles = [mdxFile, ...mddFiles];
        const totalUploadBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
        let uploadedBytes = 0;

        const mdxUploadId = await this._uploadFile(mdxFile, (completed) => {
            if (typeof onProgress === 'function') {
                onProgress({stage: 'upload', completed, total: totalUploadBytes});
            }
        });
        uploadedBytes += mdxFile.size;

        /** @type {string[]} */
        const mddUploadIds = [];
        for (const file of mddFiles) {
            const startOffset = uploadedBytes;
            const uploadId = await this._uploadFile(file, (completed) => {
                if (typeof onProgress === 'function') {
                    onProgress({stage: 'upload', completed: startOffset + completed, total: totalUploadBytes});
                }
            });
            uploadedBytes += file.size;
            mddUploadIds.push(uploadId);
        }

        if (typeof onProgress === 'function') {
            onProgress({stage: 'convert', completed: 1, total: 1});
        }

        const jobId = /** @type {string} */ (await this._invoke('convert', {
            mdxUploadId,
            mddUploadIds,
            options: {
                titleOverride,
                descriptionOverride,
                revision,
                enableAudio,
                includeAssets,
                termBankSize,
            },
        }));

        const downloadInfo = /** @type {{totalBytes?: unknown, archiveFileName?: unknown}} */ (await this._invoke('download_begin', {jobId, chunkBytes: DOWNLOAD_CHUNK_BYTES}));
        const totalBytes = typeof downloadInfo.totalBytes === 'number' && downloadInfo.totalBytes >= 0 ? downloadInfo.totalBytes : 0;
        const archiveFileName = typeof downloadInfo.archiveFileName === 'string' && downloadInfo.archiveFileName.length > 0 ? downloadInfo.archiveFileName : `${mdxFile.name.replace(/\.mdx$/i, '') || 'dictionary'}.zip`;
        const parts = [];
        let offset = 0;
        while (offset < totalBytes) {
            const response = /** @type {{data?: unknown}} */ (await this._invoke('download_chunk', {
                jobId,
                offset,
                chunkBytes: DOWNLOAD_CHUNK_BYTES,
            }));
            const data = typeof response.data === 'string' ? response.data : '';
            const part = new Uint8Array(base64ToArrayBuffer(data));
            parts.push(part);
            offset += part.byteLength;
            if (typeof onProgress === 'function') {
                onProgress({stage: 'download', completed: Math.min(offset, totalBytes), total: totalBytes});
            }
            if (part.byteLength === 0) { break; }
        }
        await this._invoke('download_end', {jobId});

        let totalLength = 0;
        for (const part of parts) {
            totalLength += part.byteLength;
        }
        const combined = new Uint8Array(totalLength);
        let writeOffset = 0;
        for (const part of parts) {
            combined.set(part, writeOffset);
            writeOffset += part.byteLength;
        }

        return {
            archiveContent: combined.buffer,
            archiveFileName,
        };
    }

    // Private

    /**
     * @param {unknown} message
     */
    _onMessage(message) {
        if (typeof message !== 'object' || message === null) { return; }

        const {sequence, data} = /** @type {import('core').SerializableObject} */ (message);
        if (typeof sequence !== 'number') { return; }

        const invocation = this._invocations.get(sequence);
        if (typeof invocation === 'undefined') { return; }

        const {resolve, reject, timer} = invocation;
        clearTimeout(timer);
        const error = this._createNativeError(data);
        if (error !== null) {
            reject(error);
        } else {
            resolve(data);
        }
        this._invocations.delete(sequence);
    }

    /**
     * @param {unknown} data
     * @returns {Error|null}
     */
    _createNativeError(data) {
        if (!(typeof data === 'object' && data !== null)) { return null; }

        const errorValue = /** @type {unknown} */ (Reflect.get(/** @type {Record<string, unknown>} */ (data), 'error'));
        if (!(typeof errorValue === 'object' && errorValue !== null)) { return null; }

        const errorRecord = /** @type {Record<string, unknown>} */ (errorValue);
        const message = typeof errorRecord.message === 'string' && errorRecord.message.length > 0 ? errorRecord.message : 'MDX conversion failed';
        const unsupportedVariant = this._isUnsupportedVariantError(errorRecord, message);
        if (!unsupportedVariant) {
            return new Error(message);
        }

        const details = [];
        const detailSources = [
            /** @type {unknown} */ (Reflect.get(errorRecord, 'details')),
            /** @type {unknown} */ (Reflect.get(errorRecord, 'metadata')),
        ];
        for (const detailSource of detailSources) {
            if (!(typeof detailSource === 'object' && detailSource !== null)) { continue; }
            const detailRecord = /** @type {Record<string, unknown>} */ (detailSource);
            for (const key of ['variant', 'compression', 'encryption', 'dictionaryType']) {
                const value = Reflect.get(detailRecord, key);
                if (typeof value === 'string' && value.length > 0) {
                    details.push(`${key}: ${value}`);
                }
            }
        }
        const detailString = details.length > 0 ? ` (${details.join(', ')})` : '';
        return new Error(`${UNSUPPORTED_VARIANT_ERROR_MESSAGE}${detailString} Native helper detail: ${message}`);
    }

    /**
     * @param {Record<string, unknown>} errorRecord
     * @param {string} message
     * @returns {boolean}
     */
    _isUnsupportedVariantError(errorRecord, message) {
        for (const key of ['code', 'kind', 'reason', 'category']) {
            const value = Reflect.get(errorRecord, key);
            if (typeof value !== 'string') { continue; }
            const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');
            if (
                normalized.includes('unsupported-variant') ||
                normalized.includes('unsupported-compression') ||
                normalized.includes('unsupported-encryption')
            ) {
                return true;
            }
        }

        const haystack = [
            message,
            typeof errorRecord.type === 'string' ? errorRecord.type : '',
            typeof errorRecord.code === 'string' ? errorRecord.code : '',
        ].join(' ').toLowerCase();
        return (
            haystack.includes('unsupported variant') ||
            haystack.includes('unsupported compression') ||
            haystack.includes('unsupported encryption') ||
            haystack.includes('xxhash') ||
            haystack.includes('lzo') ||
            haystack.includes('encrypted') ||
            haystack.includes('encryption') ||
            haystack.includes('decrypt')
        );
    }

    /** */
    _onDisconnect() {
        if (this._port === null) { return; }
        const e = chrome.runtime.lastError;
        const error = new Error(e ? e.message : 'MDX converter disconnected');
        for (const {reject, timer} of this._invocations.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this._invocations.clear();
        this._clearPort();
    }

    /**
     * @param {File} file
     * @param {?(completed: number) => void} onProgress
     * @returns {Promise<string>}
     */
    async _uploadFile(file, onProgress) {
        const response = /** @type {{uploadId?: unknown}} */ (await this._invoke('begin_upload', {
            fileName: file.name,
            totalBytes: file.size,
        }));
        const uploadId = typeof response.uploadId === 'string' ? response.uploadId : '';
        if (uploadId.length === 0) {
            throw new Error(`Failed to allocate upload for ${file.name}`);
        }

        let offset = 0;
        while (offset < file.size) {
            const nextOffset = Math.min(offset + UPLOAD_CHUNK_BYTES, file.size);
            const chunk = await file.slice(offset, nextOffset).arrayBuffer();
            await this._invoke('upload_chunk', {
                uploadId,
                offset,
                data: arrayBufferToBase64(chunk),
            });
            offset = nextOffset;
            if (typeof onProgress === 'function') {
                onProgress(offset);
            }
        }
        await this._invoke('finish_upload', {uploadId});
        return uploadId;
    }

    /**
     * @returns {Promise<void>}
     */
    async _setupPortWrapper() {
        if (this._setupPortPromise === null) {
            this._setupPortPromise = this._setupPort();
        }
        try {
            await this._setupPortPromise;
        } catch (e) {
            throw toError(e);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _setupPort() {
        const port = chrome.runtime.connectNative(HOST_NAME);
        this._eventListeners.addListener(port.onMessage, this._onMessage.bind(this));
        this._eventListeners.addListener(port.onDisconnect, this._onDisconnect.bind(this));
        this._port = port;
    }

    /** */
    _clearPort() {
        if (this._port !== null) {
            this._port.disconnect();
            this._port = null;
        }
        this._eventListeners.removeAllEventListeners();
        this._setupPortPromise = null;
    }

    /**
     * @param {string} action
     * @param {import('core').SerializableObject} params
     * @returns {Promise<unknown>}
     */
    _invoke(action, params) {
        return new Promise((resolve, reject) => {
            if (this._port === null) {
                reject(new Error('Port disconnected'));
                return;
            }

            const sequence = this._sequence++;
            const timer = setTimeout(() => {
                this._invocations.delete(sequence);
                reject(new Error(`MDX converter invoke timed out after ${this._timeout}ms (${action})`));
            }, this._timeout);

            this._invocations.set(sequence, {resolve, reject, timer});
            this._port.postMessage({action, params, sequence});
        });
    }
}
