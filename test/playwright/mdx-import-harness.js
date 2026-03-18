/*
 * Copyright (C) 2026  Manabitan authors
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

import {BlobWriter, Uint8ArrayReader, ZipWriter} from '@zip.js/zip.js';

export const mdxListingUrl = 'https://mdx.mdict.org/%E5%85%AD%E5%A4%A7%E7%9F%A5%E5%90%8D%E8%AF%8D%E5%85%B8/%E7%89%9B%E6%B4%A5_Oxford/Oxford%20English%20Dictionary%202nd%20v4_%2014-10-9/?sort=size&order=desc';
export const mdxDictionaryTitle = 'Oxford English Dictionary 2nd v4.0 (Playwright)';
export const mdxDescriptionOverride = 'Playwright-routed MDX import fixture for the Oxford listing workflow.';
export const mdxRevisionOverride = 'playwright-mdx-import';
export const mdxLookupTerm = 'dictionary';
export const mdxLookupGlossary = 'a reference book that lists words and explains what they mean';
export const localMdxFixtureFileName = 'playwright-yome.mdx';
export const localMdxDictionaryTitle = 'Playwright Yome MDX';
export const localMdxDescription = 'Playwright local drag-and-drop MDX fixture for the Japanese lookup workflow.';
export const localMdxRevision = 'playwright-mdx-local';
export const localMdxLookupTerm = '読め';
export const localMdxLookupGlossary = 'playwright mdx fixture result for 読め';
export const localEnglishMdxFixtureFileName = 'playwright-read.mdx';
export const localEnglishMdxDictionaryTitle = 'Playwright Read MDX';
export const localEnglishMdxDescription = 'Playwright local drag-and-drop MDX fixture for the English lookup workflow.';
export const localEnglishMdxRevision = 'playwright-mdx-english';
export const localEnglishMdxLookupTerm = 'Read';
export const localEnglishMdxLookupGlossary = 'playwright mdx fixture result for Read';

const mdxFileName = 'Oxford English Dictionary 2nd v4.0.mdx';
const mddFileName = 'Oxford English Dictionary 2nd v4.0.mdd';
const mdxFileUrl = 'https://mdx.mdict.org/%E5%85%AD%E5%A4%A7%E7%9F%A5%E5%90%8D%E8%AF%8D%E5%85%B8/%E7%89%9B%E6%B4%A5_Oxford/Oxford%20English%20Dictionary%202nd%20v4_%2014-10-9/Oxford%20English%20Dictionary%202nd%20v4.0.mdx';
const mddFileUrl = 'https://mdx.mdict.org/%E5%85%AD%E5%A4%A7%E7%9F%A5%E5%90%8D%E8%AF%8D%E5%85%B8/%E7%89%9B%E6%B4%A5_Oxford/Oxford%20English%20Dictionary%202nd%20v4_%2014-10-9/Oxford%20English%20Dictionary%202nd%20v4.0.mdd';
const defaultMdxHarnessOptions = {
    dictionaryTitle: mdxDictionaryTitle,
    descriptionOverride: mdxDescriptionOverride,
    revisionOverride: mdxRevisionOverride,
    lookupTerm: mdxLookupTerm,
    lookupGlossary: mdxLookupGlossary,
    mdxBuffer: Buffer.from('playwright-mdx-fixture-data', 'utf8'),
    mddBuffer: Buffer.from('playwright-mdd-fixture-data', 'utf8'),
    listingUrl: mdxListingUrl,
    mdxUrl: mdxFileUrl,
    mddUrl: mddFileUrl,
    mdxFileName,
    mddFileName,
};

/**
 * @typedef {{
 *   dictionaryTitle: string,
 *   descriptionOverride: string,
 *   revisionOverride: string,
 *   lookupTerm: string,
 *   lookupGlossary: string,
 *   archiveFileName?: string,
 *   mdxBuffer?: Buffer,
 *   mddBuffer?: Buffer|null,
 *   listingUrl?: string|null,
 *   mdxUrl?: string|null,
 *   mddUrl?: string|null,
 *   mdxFileName?: string,
 *   mddFileName?: string,
 * }} PlaywrightMdxFixtureOptions
 */

/** @type {Map<string, Promise<{archiveBase64: string, archiveFileName: string, mdxBuffer: Buffer, mddBuffer: Buffer|null}>>} */
const mdxFixturePromiseMap = new Map();

/**
 * @param {ArrayBuffer} arrayBuffer
 * @returns {string}
 */
function arrayBufferToBase64(arrayBuffer) {
    return Buffer.from(arrayBuffer).toString('base64');
}

/**
 * @param {{title: string, description: string, revision: string, expression: string, glossary: string}} details
 * @returns {Promise<ArrayBuffer>}
 */
async function createDictionaryArchiveData(details) {
    const {
        title,
        description,
        revision,
        expression,
        glossary,
    } = details;

    const files = new Map([
        ['index.json', JSON.stringify({title, format: 3, revision, description, sequenced: true})],
        ['term_bank_1.json', JSON.stringify([[expression, '', 'n', '', 1, [glossary], 1, '']])],
        ['tag_bank_1.json', JSON.stringify([])],
        ['styles.css', '.mdx-playwright-entry { font-style: italic; }'],
    ]);

    const writer = new BlobWriter();
    const zipWriter = new ZipWriter(writer, {level: 0});
    for (const [fileName, content] of files) {
        await zipWriter.add(fileName, new Uint8ArrayReader(Buffer.from(content, 'utf8')));
    }
    const blob = await zipWriter.close();
    return await blob.arrayBuffer();
}

/**
 * @param {PlaywrightMdxFixtureOptions} options
 * @returns {Promise<{archiveBase64: string, archiveFileName: string, mdxBuffer: Buffer, mddBuffer: Buffer|null}>}
 */
async function getMdxFixture(options) {
    const cacheKey = JSON.stringify({
        dictionaryTitle: options.dictionaryTitle,
        descriptionOverride: options.descriptionOverride,
        revisionOverride: options.revisionOverride,
        lookupTerm: options.lookupTerm,
        lookupGlossary: options.lookupGlossary,
        archiveFileName: options.archiveFileName ?? null,
        mdxBufferBase64: (options.mdxBuffer ?? Buffer.from('playwright-mdx-fixture-data', 'utf8')).toString('base64'),
        mddBufferBase64: options.mddBuffer instanceof Buffer ? options.mddBuffer.toString('base64') : null,
    });
    let promise = mdxFixturePromiseMap.get(cacheKey);
    if (typeof promise !== 'undefined') {
        return await promise;
    }

    promise = (async () => {
        const archiveFileName = options.archiveFileName ?? `${options.dictionaryTitle}.zip`;
        const archiveBuffer = await createDictionaryArchiveData({
            title: options.dictionaryTitle,
            description: options.descriptionOverride,
            revision: options.revisionOverride,
            expression: options.lookupTerm,
            glossary: options.lookupGlossary,
        });

        return {
            archiveBase64: arrayBufferToBase64(archiveBuffer),
            archiveFileName,
            mdxBuffer: options.mdxBuffer ?? Buffer.from('playwright-mdx-fixture-data', 'utf8'),
            mddBuffer: options.mddBuffer ?? null,
        };
    })();
    mdxFixturePromiseMap.set(cacheKey, promise);
    return await promise;
}

/**
 * @param {{mdxFileName: string, mddFileName: string}} details
 * @returns {string}
 */
function createListingHtml({mdxFileName: currentMdxFileName, mddFileName: currentMddFileName}) {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<body>',
        `<a href="${encodeURIComponent(currentMdxFileName)}">${currentMdxFileName}</a>`,
        `<a href="${encodeURIComponent(currentMddFileName)}">${currentMddFileName}</a>`,
        '</body>',
        '</html>',
    ].join('');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {PlaywrightMdxFixtureOptions} [options]
 * @returns {Promise<{requestCounts: {listing: number, mdx: number, mdd: number}, archiveFileName: string}>}
 */
export async function setupMdxImportHarness(page, options = defaultMdxHarnessOptions) {
    const normalizedOptions = {
        dictionaryTitle: options.dictionaryTitle,
        descriptionOverride: options.descriptionOverride,
        revisionOverride: options.revisionOverride,
        lookupTerm: options.lookupTerm,
        lookupGlossary: options.lookupGlossary,
        archiveFileName: options.archiveFileName,
        mdxBuffer: options.mdxBuffer,
        mddBuffer: options.mddBuffer ?? null,
        listingUrl: options.listingUrl ?? null,
        mdxUrl: options.mdxUrl ?? null,
        mddUrl: options.mddUrl ?? null,
        mdxFileName: options.mdxFileName ?? 'fixture.mdx',
        mddFileName: options.mddFileName ?? 'fixture.mdd',
    };
    const fixture = await getMdxFixture(normalizedOptions);
    const requestCounts = {
        listing: 0,
        mdx: 0,
        mdd: 0,
    };

    if (typeof normalizedOptions.listingUrl === 'string') {
        await page.route(normalizedOptions.listingUrl, async (route) => {
            requestCounts.listing += 1;
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: createListingHtml({
                    mdxFileName: normalizedOptions.mdxFileName,
                    mddFileName: normalizedOptions.mddFileName,
                }),
            });
        });
    }
    if (typeof normalizedOptions.mdxUrl === 'string') {
        await page.route(normalizedOptions.mdxUrl, async (route) => {
            requestCounts.mdx += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/octet-stream',
                body: fixture.mdxBuffer,
            });
        });
    }
    if (typeof normalizedOptions.mddUrl === 'string' && fixture.mddBuffer !== null) {
        const mddBuffer = fixture.mddBuffer;
        await page.route(normalizedOptions.mddUrl, async (route) => {
            requestCounts.mdd += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/octet-stream',
                body: mddBuffer,
            });
        });
    }

    await page.evaluate(({
        archiveBase64,
        archiveFileName,
    }) => {
        /**
         * @param {string} base64
         * @returns {Uint8Array}
         */
        const base64ToBytes = (base64) => {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; ++i) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        };

        /**
         * @param {ArrayBuffer|Uint8Array} value
         * @returns {string}
         */
        const bytesToBase64 = (value) => {
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            let binary = '';
            for (const byte of bytes) {
                binary += String.fromCharCode(byte);
            }
            return btoa(binary);
        };

        /** @type {{uploads: Array<{fileName: string, totalBytes: number, uploadedBytes: number}>, convertCalls: number, lastConvert: unknown, childFetches: Array<{url: string, sizeBytes: number}>}} */
        const state = /** @type {{uploads: Array<{fileName: string, totalBytes: number, uploadedBytes: number}>, convertCalls: number, lastConvert: unknown, childFetches: Array<{url: string, sizeBytes: number}>}} */ (
            Reflect.get(globalThis, '__manabitanPlaywrightMdxState') || {}
        );
        state.uploads = [];
        state.convertCalls = 0;
        state.lastConvert = null;
        state.childFetches = [];
        Reflect.set(globalThis, '__manabitanPlaywrightMdxState', state);

        if (chrome.permissions) {
            chrome.permissions.contains = (permissions, /** @type {unknown} */ callback) => {
                const permissionList = Array.isArray(permissions?.permissions) ? permissions.permissions : [];
                const result = permissionList.includes('nativeMessaging');
                const notify = typeof callback === 'function' ? callback : () => {};
                notify(result);
                return Promise.resolve(result);
            };
            chrome.permissions.request = (_permissions, /** @type {unknown} */ callback) => {
                const notify = typeof callback === 'function' ? callback : () => {};
                notify(true);
                return Promise.resolve(true);
            };
        }

        const archiveBytes = base64ToBytes(archiveBase64);
        let uploadSequence = 0;
        let jobSequence = 0;
        /** @type {Map<string, {fileName: string, totalBytes: number, uploadedBytes: number}>} */
        const uploads = new Map();
        /** @type {Map<string, {archiveBytes: Uint8Array, archiveFileName: string}>} */
        const jobs = new Map();

        Object.defineProperty(chrome.runtime, 'connectNative', {
            configurable: true,
            value: (/** @type {string} */ hostName) => {
                /** @type {Set<(message: unknown) => void>} */
                const messageListeners = new Set();
                /** @type {Set<() => void>} */
                const disconnectListeners = new Set();

                /**
                 * @param {number} sequence
                 * @param {unknown} data
                 * @returns {void}
                 */
                const emitMessage = (sequence, data) => {
                    queueMicrotask(() => {
                        for (const listener of messageListeners) {
                            listener({sequence, data});
                        }
                    });
                };

                /**
                 * @param {string} action
                 * @param {Record<string, unknown>} params
                 * @returns {unknown}
                 */
                const handleAction = (action, params) => {
                    switch (action) {
                        case 'get_version':
                            return 1;
                        case 'begin_upload': {
                            const uploadId = `upload-${uploadSequence++}`;
                            const fileName = typeof params.fileName === 'string' ? params.fileName : 'unknown';
                            const totalBytes = typeof params.totalBytes === 'number' ? params.totalBytes : 0;
                            uploads.set(uploadId, {fileName, totalBytes, uploadedBytes: 0});
                            return {uploadId};
                        }
                        case 'upload_chunk': {
                            const uploadId = typeof params.uploadId === 'string' ? params.uploadId : '';
                            const upload = uploads.get(uploadId);
                            if (!upload) { throw new Error(`Unknown upload ${uploadId}`); }
                            const data = typeof params.data === 'string' ? params.data : '';
                            upload.uploadedBytes += atob(data).length;
                            return {};
                        }
                        case 'finish_upload': {
                            const uploadId = typeof params.uploadId === 'string' ? params.uploadId : '';
                            const upload = uploads.get(uploadId);
                            if (!upload) { throw new Error(`Unknown upload ${uploadId}`); }
                            state.uploads.push({
                                fileName: upload.fileName,
                                totalBytes: upload.totalBytes,
                                uploadedBytes: upload.uploadedBytes,
                            });
                            return {};
                        }
                        case 'convert': {
                            const jobId = `job-${jobSequence++}`;
                            state.convertCalls = Number(state.convertCalls || 0) + 1;
                            state.lastConvert = {
                                hostName,
                                mdxUploadId: typeof params.mdxUploadId === 'string' ? params.mdxUploadId : '',
                                mddUploadIds: Array.isArray(params.mddUploadIds) ? params.mddUploadIds : [],
                                options: typeof params.options === 'object' && params.options !== null ? params.options : {},
                            };
                            jobs.set(jobId, {archiveBytes, archiveFileName});
                            return jobId;
                        }
                        case 'download_begin': {
                            const jobId = typeof params.jobId === 'string' ? params.jobId : '';
                            const job = jobs.get(jobId);
                            if (!job) { throw new Error(`Unknown job ${jobId}`); }
                            return {
                                totalBytes: job.archiveBytes.byteLength,
                                archiveFileName: job.archiveFileName,
                            };
                        }
                        case 'download_chunk': {
                            const jobId = typeof params.jobId === 'string' ? params.jobId : '';
                            const offset = typeof params.offset === 'number' ? params.offset : 0;
                            const chunkBytes = typeof params.chunkBytes === 'number' ? params.chunkBytes : archiveBytes.byteLength;
                            const job = jobs.get(jobId);
                            if (!job) { throw new Error(`Unknown job ${jobId}`); }
                            const chunk = job.archiveBytes.slice(offset, offset + chunkBytes);
                            return {data: bytesToBase64(chunk)};
                        }
                        case 'download_end': {
                            const jobId = typeof params.jobId === 'string' ? params.jobId : '';
                            jobs.delete(jobId);
                            return {};
                        }
                        default:
                            throw new Error(`Unsupported fake native action: ${action}`);
                    }
                };

                return {
                    name: hostName,
                    onMessage: {
                        addListener(/** @type {(message: unknown) => void} */ listener) {
                            messageListeners.add(listener);
                        },
                        removeListener(/** @type {(message: unknown) => void} */ listener) {
                            messageListeners.delete(listener);
                        },
                    },
                    onDisconnect: {
                        addListener(/** @type {() => void} */ listener) {
                            disconnectListeners.add(listener);
                        },
                        removeListener(/** @type {() => void} */ listener) {
                            disconnectListeners.delete(listener);
                        },
                    },
                    postMessage(/** @type {unknown} */ message) {
                        const payload = /** @type {{action?: unknown, params?: unknown, sequence?: unknown}} */ (
                            typeof message === 'object' && message !== null ? message : {}
                        );
                        const action = typeof payload.action === 'string' ? payload.action : '';
                        const params = /** @type {Record<string, unknown>} */ (
                            typeof payload.params === 'object' && payload.params !== null ? payload.params : {}
                        );
                        const sequence = typeof payload.sequence === 'number' ? payload.sequence : -1;
                        try {
                            emitMessage(sequence, handleAction(action, params));
                        } catch (error) {
                            const value = error instanceof Error ? error.message : 'Unknown fake native error';
                            emitMessage(sequence, {error: {message: value}});
                        }
                    },
                    disconnect() {
                        for (const listener of disconnectListeners) {
                            listener();
                        }
                        disconnectListeners.clear();
                        messageListeners.clear();
                    },
                };
            },
        });
    }, {
        archiveBase64: fixture.archiveBase64,
        archiveFileName: fixture.archiveFileName,
    });

    return {
        requestCounts,
        archiveFileName: fixture.archiveFileName,
    };
}
