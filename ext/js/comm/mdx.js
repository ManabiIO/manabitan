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

const UNSUPPORTED_VARIANT_ERROR_MESSAGE = 'This MDX file uses an unsupported compression, encryption, or format variant. Convert it externally first or try a different MDX source.';

/**
 * @typedef {{stage: 'upload'|'convert'|'download', completed: number, total: number}} MdxProgressDetails
 */

/**
 * @typedef {{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}} MdxPhaseTiming
 */

/**
 * @typedef {{name: string, bytes: ArrayBuffer}} MdxWorkerInputFile
 */

/**
 * @typedef {{titleOverride: string, descriptionOverride: string, revision: string, enableAudio: boolean, includeAssets: boolean, termBankSize: number}} MdxWorkerConvertOptions
 */

/**
 * @typedef {{mdxFileName: string, mdxBytes: ArrayBuffer, mddFiles: MdxWorkerInputFile[], options: MdxWorkerConvertOptions}} MdxWorkerConvertParams
 */

/**
 * @typedef {{action: 'progress', params: {details: MdxProgressDetails}} | {action: 'complete', params: {result?: {archiveContent?: ArrayBuffer, archiveFileName?: string, phaseTimings?: MdxPhaseTiming[]}, error?: string}}} MdxWorkerMessage
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value
 * @returns {MdxPhaseTiming[]}
 */
function parsePhaseTimings(value) {
    if (!Array.isArray(value)) { return []; }
    /** @type {MdxPhaseTiming[]} */
    const timings = [];
    for (const item of value) {
        if (!isRecord(item)) { continue; }
        const {phase, elapsedMs, details} = item;
        if (typeof phase !== 'string' || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) { continue; }
        /** @type {MdxPhaseTiming} */
        const timing = {phase, elapsedMs};
        if (isRecord(details)) {
            /** @type {Record<string, string|number|boolean|null>} */
            const normalizedDetails = {};
            for (const [key, detailValue] of Object.entries(details)) {
                if (
                    typeof detailValue === 'string' ||
                    typeof detailValue === 'number' ||
                    typeof detailValue === 'boolean' ||
                    detailValue === null
                ) {
                    normalizedDetails[key] = detailValue;
                }
            }
            timing.details = normalizedDetails;
        }
        timings.push(timing);
    }
    return timings;
}

/**
 * @param {unknown} value
 * @returns {MdxWorkerMessage|null}
 */
function parseWorkerMessage(value) {
    if (!isRecord(value)) { return null; }
    const action = value.action;
    const params = value.params;
    if (!isRecord(params)) { return null; }
    switch (action) {
        case 'progress': {
            const details = params.details;
            if (!isRecord(details)) { return null; }
            const stage = details.stage;
            const completed = details.completed;
            const total = details.total;
            if (
                (stage !== 'upload' && stage !== 'convert' && stage !== 'download') ||
                typeof completed !== 'number' ||
                typeof total !== 'number' ||
                !Number.isFinite(completed) ||
                !Number.isFinite(total)
            ) {
                return null;
            }
            return {action, params: {details: {stage, completed, total}}};
        }
        case 'complete': {
            const result = params.result;
            const error = params.error;
            /** @type {{result?: {archiveContent?: ArrayBuffer, archiveFileName?: string}, error?: string}} */
            const completeParams = {};
            if (typeof error === 'string') {
                completeParams.error = error;
            }
            if (isRecord(result)) {
                /** @type {{archiveContent?: ArrayBuffer, archiveFileName?: string, phaseTimings?: MdxPhaseTiming[]}} */
                const archiveResult = {};
                if (result.archiveContent instanceof ArrayBuffer) {
                    archiveResult.archiveContent = result.archiveContent;
                }
                if (typeof result.archiveFileName === 'string') {
                    archiveResult.archiveFileName = result.archiveFileName;
                }
                archiveResult.phaseTimings = parsePhaseTimings(result.phaseTimings);
                completeParams.result = archiveResult;
            }
            return {action, params: completeParams};
        }
        default: {
            return null;
        }
    }
}

export class Mdx {
    /** */
    constructor() {
        /** @type {Worker|null} */
        this._worker = null;
        /** @type {number} */
        this._version = 2;
        /** @type {boolean} */
        this._active = false;
    }

    /**
     * @returns {boolean}
     */
    isConnected() {
        return this._worker !== null;
    }

    /**
     * @returns {boolean}
     */
    isActive() {
        return this._active;
    }

    /**
     * @returns {number}
     */
    getLocalVersion() {
        return this._version;
    }

    /**
     * @returns {Promise<number>}
     */
    async getVersion() {
        return this._version;
    }

    /** */
    disconnect() {
        if (this._worker !== null) {
            this._worker.terminate();
            this._worker = null;
        }
        this._active = false;
    }

    /**
     * @param {{mdxFile: File, mddFiles?: File[], titleOverride?: string, descriptionOverride?: string, revision?: string, enableAudio?: boolean, includeAssets?: boolean, termBankSize?: number}} details
     * @param {?(details: {stage: 'upload'|'convert'|'download', completed: number, total: number}) => void} onProgress
     * @returns {Promise<{archiveContent: ArrayBuffer, archiveFileName: string, phaseTimings: MdxPhaseTiming[]}>}
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

        const uploadFiles = [mdxFile, ...mddFiles];
        const totalUploadBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
        let uploadedBytes = 0;
        /**
         * @param {File} file
         * @returns {Promise<ArrayBuffer>}
         */
        const readFileWithProgress = async (file) => {
            const buffer = await file.arrayBuffer();
            uploadedBytes += file.size;
            if (typeof onProgress === 'function') {
                onProgress({stage: 'upload', completed: uploadedBytes, total: totalUploadBytes});
            }
            return buffer;
        };

        const mdxBytes = await readFileWithProgress(mdxFile);
        /** @type {MdxWorkerInputFile[]} */
        const mddInputs = [];
        for (const file of mddFiles) {
            mddInputs.push({
                name: file.name,
                bytes: await readFileWithProgress(file),
            });
        }

        this.disconnect();
        this._active = true;

        return await new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker('/js/dictionary/mdx-worker-main.js', {type: 'module'});
            } catch (e) {
                this._active = false;
                reject(e instanceof Error ? e : new Error(String(e)));
                return;
            }
            this._worker = worker;

            /**
             * @param {Error} error
             */
            const fail = (error) => {
                this.disconnect();
                reject(error);
            };

            worker.addEventListener('message', (event) => {
                const message = parseWorkerMessage(event.data);
                if (message === null) {
                    fail(new Error('MDX conversion worker returned malformed message'));
                    return;
                }
                switch (message.action) {
                    case 'progress': {
                        if (typeof onProgress === 'function') {
                            onProgress(message.params.details);
                        }
                        break;
                    }
                    case 'complete': {
                        this._active = false;
                        const {error = '', result} = message.params;
                        if (error.length > 0) {
                            fail(this._normalizeError(error));
                            return;
                        }
                        const archiveContent = result?.archiveContent;
                        const archiveFileName = typeof result?.archiveFileName === 'string' && result.archiveFileName.length > 0 ? result.archiveFileName : `${mdxFile.name.replace(/\.mdx$/iu, '') || 'dictionary'}.zip`;
                        if (!(archiveContent instanceof ArrayBuffer)) {
                            fail(new Error('MDX conversion worker returned invalid archive data'));
                            return;
                        }
                        this.disconnect();
                        resolve({archiveContent, archiveFileName, phaseTimings: result?.phaseTimings ?? []});
                        break;
                    }
                }
            });
            worker.addEventListener('error', /** @param {ErrorEvent} event */ (event) => {
                fail(new Error(event.message || 'MDX conversion worker failed'));
            });
            worker.addEventListener('messageerror', () => {
                fail(new Error('MDX conversion worker message deserialization failed'));
            });
            try {
                /** @type {MdxWorkerConvertParams} */
                const params = {
                    mdxFileName: mdxFile.name,
                    mdxBytes,
                    mddFiles: mddInputs,
                    options: {
                        titleOverride,
                        descriptionOverride,
                        revision,
                        enableAudio,
                        includeAssets,
                        termBankSize,
                    },
                };
                /** @type {Transferable[]} */
                const transferables = [mdxBytes, ...mddInputs.map(({bytes}) => bytes)];
                worker.postMessage({
                    action: 'convertDictionary',
                    params,
                }, transferables);
            } catch (e) {
                fail(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    /**
     * @param {string} message
     * @returns {Error}
     */
    _normalizeError(message) {
        const lowered = message.toLowerCase();
        if (
            lowered.includes('unsupported compression') ||
            lowered.includes('unsupported encryption') ||
            lowered.includes('unsupported variant') ||
            lowered.includes('xxhash') ||
            lowered.includes('lzo') ||
            lowered.includes('encrypted')
        ) {
            return new Error(`${UNSUPPORTED_VARIANT_ERROR_MESSAGE} Worker detail: ${message}`);
        }
        return new Error(message);
    }
}
