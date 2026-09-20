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
const CONVERSION_TIMEOUT_MS = 180_000;

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
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
                !Number.isFinite(total) ||
                completed < 0 ||
                total < 0 ||
                completed > total
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
        /** @type {((error: Error) => void)|null} */
        this._activeReject = null;
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
        // One settlement path owns cleanup during both file reads and conversion.
        this._activeReject?.(new Error('MDX conversion cancelled'));
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
        // Snapshot the selection. Callers must not change a pending request by
        // mutating their resource array while a file read is in flight.
        const resourceFiles = [...mddFiles];
        this.disconnect();

        return await new Promise((resolve, reject) => {
            /** @type {Worker|null} */
            let worker = null;
            /** @type {ReturnType<typeof setTimeout>|null} */
            let timeout = null;
            let settled = false;
            let uploadedBytes = 0;
            const totalUploadBytes = mdxFile.size + resourceFiles.reduce((sum, file) => sum + file.size, 0);

            /** @returns {void} */
            const cleanup = () => {
                if (timeout !== null) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                if (worker !== null) {
                    worker.terminate();
                    worker = null;
                }
                // Late file completions and queued messages from an old request
                // must not reset the worker or timeout of a newer request.
                if (this._activeReject === fail) {
                    this._activeReject = null;
                    this._active = false;
                    this._worker = null;
                }
            };
            /** @param {Error} error */
            const fail = (error) => {
                if (settled) { return; }
                settled = true;
                cleanup();
                reject(error);
            };
            /** @param {{archiveContent: ArrayBuffer, archiveFileName: string, phaseTimings: MdxPhaseTiming[]}} result */
            const complete = (result) => {
                if (settled) { return; }
                settled = true;
                cleanup();
                resolve(result);
            };
            /** @param {MdxProgressDetails} progress */
            const reportProgress = (progress) => {
                if (!settled && typeof onProgress === 'function') {
                    onProgress(progress);
                }
            };
            /**
             * Blob.arrayBuffer itself cannot be aborted. Reject the public
             * request immediately on disconnect and ignore its late result.
             * @param {File} file
             * @returns {Promise<ArrayBuffer|null>}
             */
            const readFile = async (file) => {
                // Cancellation can run between a completed read and the next
                // continuation. Do not begin another File read in that gap.
                if (settled) { return null; }
                const bytes = await file.arrayBuffer();
                if (settled) { return null; }
                if (!(bytes instanceof ArrayBuffer)) {
                    throw new Error(`MDX import could not read ${file.name}: invalid file data`);
                }
                uploadedBytes += file.size;
                reportProgress({stage: 'upload', completed: uploadedBytes, total: totalUploadBytes});
                return settled ? null : bytes;
            };

            this._active = true;
            this._activeReject = fail;
            // Cover file reads too: a stuck read used to outlive cancellation
            // and had no timeout at all.
            timeout = setTimeout(() => {
                fail(new Error('MDX conversion timed out while reading or converting files. Try one dictionary at a time, or convert it to a Yomitan ZIP with a compatible converter.'));
            }, CONVERSION_TIMEOUT_MS);

            /** @returns {Promise<void>} */
            const prepare = async () => {
                const mdxBytes = await readFile(mdxFile);
                if (mdxBytes === null) { return; }
                /** @type {MdxWorkerInputFile[]} */
                const mddInputs = [];
                for (const file of resourceFiles) {
                    const bytes = await readFile(file);
                    if (bytes === null) { return; }
                    mddInputs.push({name: file.name, bytes});
                }
                if (settled) { return; }
                worker = new Worker('/js/dictionary/mdx-worker-main.js', {type: 'module'});
                this._worker = worker;
                worker.addEventListener('message', (event) => {
                    if (settled) { return; }
                    try {
                        const message = parseWorkerMessage(event.data);
                        if (message === null) {
                            fail(new Error('MDX conversion worker returned malformed message'));
                            return;
                        }
                        if (message.action === 'progress') {
                            reportProgress(message.params.details);
                            return;
                        }
                        const {error = '', result} = message.params;
                        if (error.length > 0) {
                            fail(this._normalizeError(error));
                            return;
                        }
                        const archiveContent = result?.archiveContent;
                        if (!(archiveContent instanceof ArrayBuffer)) {
                            fail(new Error('MDX conversion worker returned invalid archive data'));
                            return;
                        }
                        const archiveFileName = typeof result?.archiveFileName === 'string' && result.archiveFileName.length > 0 ? result.archiveFileName : `${mdxFile.name.replace(/\.mdx$/iu, '') || 'dictionary'}.zip`;
                        complete({archiveContent, archiveFileName, phaseTimings: result?.phaseTimings ?? []});
                    } catch (error) {
                        fail(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                worker.addEventListener('error', /** @param {ErrorEvent} event */ (event) => {
                    fail(new Error(event.message || 'MDX conversion worker failed'));
                });
                worker.addEventListener('messageerror', () => {
                    fail(new Error('MDX conversion worker message deserialization failed'));
                });
                /** @type {MdxWorkerConvertParams} */
                const params = {
                    mdxFileName: mdxFile.name,
                    mdxBytes,
                    mddFiles: mddInputs,
                    options: {titleOverride, descriptionOverride, revision, enableAudio, includeAssets, termBankSize},
                };
                /** @type {Transferable[]} */
                const transferables = [mdxBytes, ...mddInputs.map(({bytes}) => bytes)];
                worker.postMessage({action: 'convertDictionary', params}, transferables);
            };
            // Handle rejection even after cancellation so a late file failure
            // never becomes an unhandled promise rejection.
            void prepare().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
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
        if (lowered.includes('checksum') || lowered.includes('truncated') || lowered.includes('out of bounds') || lowered.includes('length mismatch')) {
            return new Error(`This MDX or MDD file could not be read completely or failed an integrity check. Try a fresh copy of the original files; renaming them will not repair the data. Worker detail: ${message}`);
        }
        return new Error(message);
    }
}
