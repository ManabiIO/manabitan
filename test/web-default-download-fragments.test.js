/* SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, expect, test, vi} from 'vitest';
import {DEFAULT_DICTIONARY, downloadDefaultDictionary} from '../ext/web/presets.js';

const origin = 'https://reader.example.test/';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {ReadableStream<Uint8Array>} body
 * @returns {Promise<Blob>}
 */
function downloadStream(body) {
    vi.stubGlobal('location', new URL(origin));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    return downloadDefaultDictionary(new URL('default.zip', origin));
}

test('repeated empty chunks cannot starve the download idle deadline or accumulate memory', async () => {
    let reads = 0;
    const body = new ReadableStream({
        pull(controller) {
            ++reads;
            if (reads > 1100) {
                controller.error(new Error('Unbounded empty archive reads'));
            } else {
                controller.enqueue(new Uint8Array(0));
            }
        },
    });
    const rejected = await downloadStream(body).then(() => null, (error) => error);
    expect(rejected.code).toBe('download_failed');
    expect(reads).toBeLessThanOrEqual(1100);
});

test('interleaved empty chunks cannot evade the total no-progress budget', async () => {
    let reads = 0;
    const body = new ReadableStream({
        pull(controller) {
            ++reads;
            if (reads > 2200) {
                controller.error(new Error('Unbounded interleaved reads'));
            } else {
                controller.enqueue(reads % 2 ? new Uint8Array(0) : new Uint8Array([1]));
            }
        },
    });
    const rejected = await downloadStream(body).then(() => null, (error) => error);
    expect(rejected.code).toBe('download_failed');
    expect(reads).toBeLessThan(2200);
});

test('fragment-count limit bounds storage for a slowly fragmented archive', async () => {
    const part = new Uint8Array([1]);
    let reads = 0;
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    vi.stubGlobal('location', new URL(origin));
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        body: {getReader: () => ({
            async read() {
                if (++reads > 66_000) { throw new Error('Unbounded fragment admission'); }
                return {done: false, value: part};
            },
            cancel,
            releaseLock,
        })},
    })));
    const rejected = await downloadDefaultDictionary(new URL('default.zip', origin))
        .then(() => null, (error) => error);
    expect(rejected.code).toBe('download_failed');
    expect(reads).toBe(65_537);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
});

test('a nonsettling reader cancellation cannot suppress an early integrity error', async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const releaseLock = vi.fn();
    /** @type {AbortSignal[]} */
    const signals = [];
    vi.stubGlobal('location', new URL(origin));
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        signals.push(options.signal);
        return {
            ok: true,
            body: {getReader: () => ({
                read: async () => ({done: false, value: {byteLength: DEFAULT_DICTIONARY.bytes + 1}}),
                cancel,
                releaseLock,
            })},
        };
    }));
    const rejected = await downloadDefaultDictionary(new URL('default.zip', origin))
        .then(() => null, (error) => error);
    expect(rejected.code).toBe('integrity');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
});
