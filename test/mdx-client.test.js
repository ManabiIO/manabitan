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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Mdx} from '../ext/js/comm/mdx.js';

/**
 * @returns {Mdx}
 */
function createMdxForInternalTests() {
    return /** @type {Mdx} */ (Object.create(Mdx.prototype));
}

/**
 * @param {unknown} data
 * @returns {Error|null}
 */
function createNativeError(data) {
    const method = /** @type {unknown} */ (Reflect.get(Mdx.prototype, '_createNativeError'));
    if (typeof method !== 'function') {
        throw new Error('Expected Mdx._createNativeError to exist');
    }
    return /** @type {(this: Mdx, data: unknown) => Error|null} */ (method).call(createMdxForInternalTests(), data);
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('Mdx native error handling', () => {
    test('formats structured unsupported variant errors with actionable guidance', () => {
        const error = createNativeError({
            error: {
                message: 'MDX variant uses unsupported xxHash-backed LZO blocks',
                code: 'unsupported_variant',
                details: {
                    variant: 'mdx-v2',
                    compression: 'lzo',
                    encryption: 'none',
                },
            },
        });

        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toContain('unsupported compression, encryption, or format variant');
        expect(error?.message).toContain('variant: mdx-v2');
        expect(error?.message).toContain('compression: lzo');
        expect(error?.message).toContain('Native helper detail: MDX variant uses unsupported xxHash-backed LZO blocks');
    });

    test('keeps generic native host errors unchanged', () => {
        const error = createNativeError({
            error: {
                message: 'temporary failure reading uploaded file',
                type: 'ValueError',
            },
        });

        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toBe('temporary failure reading uploaded file');
    });
});

describe('Mdx port lifecycle', () => {
    test('rejects pending invocations when the native port disconnects', async () => {
        const mdx = new Mdx();
        const disconnect = vi.fn();
        const postMessage = vi.fn();
        mdx._port = /** @type {chrome.runtime.Port} */ (/** @type {unknown} */ ({
            disconnect,
            postMessage,
        }));

        vi.stubGlobal('chrome', {
            runtime: {
                lastError: {
                    message: 'Native helper disconnected unexpectedly',
                },
            },
        });

        const invocationPromise = mdx._invoke('convert', {});
        mdx._onDisconnect();

        await expect(invocationPromise).rejects.toThrow('Native helper disconnected unexpectedly');
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(mdx.isConnected()).toBe(false);
        expect(mdx.isActive()).toBe(false);
    });

    test('times out invocations and clears the pending request', async () => {
        vi.useFakeTimers();
        const mdx = new Mdx();
        const postMessage = vi.fn();
        mdx._timeout = 25;
        mdx._port = /** @type {chrome.runtime.Port} */ (/** @type {unknown} */ ({
            postMessage,
        }));

        const invocationPromise = mdx._invoke('download_chunk', {
            jobId: 'j1',
            offset: 0,
        });
        const rejection = expect(invocationPromise).rejects.toThrow('MDX converter invoke timed out after 25ms (download_chunk)');

        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(postMessage).toHaveBeenCalledWith({
            action: 'download_chunk',
            params: {
                jobId: 'j1',
                offset: 0,
            },
            sequence: 0,
        });
        expect(mdx.isActive()).toBe(false);
    });
});
