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

import {isGenerationMediaDescriptor} from './dictionary-generation-media-store.js';

const TIMEOUT_MS = 60_000;
const CHECK_CANCEL_MS = 50;

/** @typedef {{blob: Blob, plan: import('./dictionary-generation-media-store.js').GenerationMediaIndex, metrics: Omit<NonNullable<Awaited<ReturnType<typeof import('./source-zip-media-pack.js').preparePackedSourceZipMedia>>>, 'blob'|'records'>}} SpeculativeSourceMedia */

/**
 * The worker only reads the immutable ZIP. It cannot publish or write to OPFS.
 * @param {Blob} archive
 * @param {() => boolean} isCancelled
 * @returns {{result: Promise<SpeculativeSourceMedia|null>, cancel: () => void}|null}
 */
export function startSourceZipMediaPreparation(archive, isCancelled) {
    if (typeof Worker !== 'function') { return null; }
    /** @type {Worker} */
    let worker;
    try {
        worker = new Worker(new URL('source-zip-media-preparation-worker.js', import.meta.url), {type: 'module'});
    } catch (_) {
        return null;
    }
    /** @type {(result: SpeculativeSourceMedia|null) => void} */
    let resolveResult = () => {};
    /** @type {Promise<SpeculativeSourceMedia|null>} */
    const result = new Promise((resolve) => { resolveResult = resolve; });
    let settled = false;
    const timeout = setTimeout(() => finish(null), TIMEOUT_MS);
    const cancelCheck = setInterval(() => {
        try {
            if (isCancelled()) { finish(null); }
        } catch (_) {
            finish(null);
        }
    }, CHECK_CANCEL_MS);
    /** @param {SpeculativeSourceMedia|null} value */
    function finish(value) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        clearInterval(cancelCheck);
        worker.terminate();
        resolveResult(value);
    }
    worker.onmessage = (event) => {
        const data = /** @type {unknown} */ (event.data);
        if (data === null || typeof data !== 'object') {
            finish(null);
            return;
        }
        const value = /** @type {SpeculativeSourceMedia} */ (data);
        const valid = value.blob instanceof Blob && value.plan?.index instanceof Uint8Array &&
        isGenerationMediaDescriptor(value.plan.descriptor) &&
        value.plan.descriptor.dataBytes === value.blob.size &&
        typeof value.metrics === 'object' && value.metrics !== null;
        finish(valid ? value : null);
    };
    worker.onerror = (event) => {
        event.preventDefault();
        finish(null);
    };
    worker.onmessageerror = () => finish(null);
    try {
        worker.postMessage(archive);
    } catch (_) {
        finish(null);
    }
    return {result, cancel: () => finish(null)};
}
