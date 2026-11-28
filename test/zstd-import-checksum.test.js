/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js';

const state = vi.hoisted(() => ({create: vi.fn()}));
vi.mock('../dev/lib/zstd-simd-module.js', () => ({default: state.create}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

/** @returns {Promise<{api: typeof import('../dev/lib/zstd-wasm.js'), module: import('../dev/lib/zstd-simd-module.js').ZstdModule}>} */
async function setup() {
    const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'));
    const wasmBinary = await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url));
    const module = await create({wasmBinary});
    state.create.mockResolvedValue(module);
    const api = await import('../dev/lib/zstd-wasm.js');
    await api.init();
    return {api, module};
}

describe('import checksum reuse of initialized Zstd', () => {
    test('keeps portable hashing before codec initialization', async () => {
        const api = await import('../dev/lib/zstd-wasm.js');
        expect(api.tryHashImportBytes(new Uint8Array(2048))).toBeNull();
        expect(state.create).not.toHaveBeenCalled();
    });

    // Existing independent vectors from term-key-hash.test.js, generated with
    // upstream XXH32 via Python xxhash 4.0.2 and seed 0x811c9dc5.
    test.each([
        [1024, 3057859126],
        [65537, 2379506235],
    ])('matches the fixed upstream XXH32 vector at %i bytes', async (length, expected) => {
        const {api} = await setup();
        const bytes = Uint8Array.from({length}, (_, index) => ((index * 131) ^ ((index >>> 7) * 17) ^ length) & 0xff);
        expect(api.tryHashImportBytes(bytes)).toBe(expected);
    });

    test('matches portable hashes for aligned and unaligned large payloads and every word tail', async () => {
        const {api} = await setup();
        for (const length of [1024, 1025, 1026, 1027, 1039, 1040, 4099, 65537, 1048579]) {
            for (const offset of [0, 1, 2, 3]) {
                const backing = Uint8Array.from({length: length + offset + 7}, (_, index) => (index * 131 + length) & 0xff);
                const bytes = backing.subarray(offset, offset + length);
                const snapshot = backing.slice();
                expect(api.tryHashImportBytes(bytes)).toBe(hashTermKeyBytes(bytes));
                expect(backing.every((value, index) => value === snapshot[index])).toBe(true);
            }
        }
    });

    test('keeps small, shared, decorated and module-backed inputs portable without allocating', async () => {
        const {api, module} = await setup();
        const allocate = vi.spyOn(module, '_malloc');
        const shared = new Uint8Array(new SharedArrayBuffer(2048));
        const decorated = new Uint8Array(2048);
        Object.defineProperty(decorated, 'byteOffset', {get() { throw new Error('decorated view'); }});
        expect(api.tryHashImportBytes(new Uint8Array(1023))).toBeNull();
        expect(api.tryHashImportBytes(shared)).toBeNull();
        expect(api.tryHashImportBytes(decorated)).toBeNull();
        expect(api.tryHashImportBytes(module.HEAPU8.subarray(4096, 6144))).toBeNull();
        expect(allocate).not.toHaveBeenCalled();
    });

    test('falls back when scratch allocation fails', async () => {
        const {api, module} = await setup();
        vi.spyOn(module, '_malloc').mockReturnValueOnce(0);
        const release = vi.spyOn(module, '_free');
        expect(api.tryHashImportBytes(new Uint8Array(2048))).toBeNull();
        expect(release).not.toHaveBeenCalled();
    });

    test('recomputes the ambiguous normalized zero pair and releases its allocation', async () => {
        const {api, module} = await setup();
        vi.spyOn(module, '_manabitan_write_block_envelope').mockImplementationOnce((pointer) => {
            const view = new DataView(module.HEAPU8.buffer, pointer, 12);
            view.setUint32(4, 1, true);
            view.setUint32(8, 0, true);
            return 1;
        });
        const release = vi.spyOn(module, '_free');
        expect(api.tryHashImportBytes(new Uint8Array(2048))).toBeNull();
        expect(release).toHaveBeenCalledOnce();
    });

    test('releases scratch after a native exception', async () => {
        const {api, module} = await setup();
        vi.spyOn(module, '_manabitan_write_block_envelope').mockImplementationOnce(() => { throw new Error('native failure'); });
        const release = vi.spyOn(module, '_free');
        expect(() => api.tryHashImportBytes(new Uint8Array(2048))).toThrow('native failure');
        expect(release).toHaveBeenCalledOnce();
    });

    test('does not invalidate a prepared compression context', async () => {
        const {api} = await setup();
        const context = api.createCCtx();
        const bytes = new TextEncoder().encode('prepared source with repeated source with repeated source');
        try {
            const prepared = api.prepareSpanCompression(context, bytes, new Uint32Array([0]), new Uint32Array([bytes.length]), bytes.length, new Uint8Array(), 0);
            const payload = new Uint8Array(1048577).fill(71);
            expect(api.tryHashImportBytes(payload)).toBe(hashTermKeyBytes(payload));
            const compressed = api.finishPreparedSpanCompression(prepared);
            expect(api.decompress(compressed)).toEqual(bytes);
        } finally { api.freeCCtx(context); }
    });

    test('preserves prepared compression when checksum scratch forces module heap growth', async () => {
        const {api, module} = await setup();
        const context = api.createCCtx();
        const bytes = new TextEncoder().encode('prepared bytes must survive growth of the shared codec module');
        try {
            const prepared = api.prepareSpanCompression(context, bytes, new Uint32Array([0]), new Uint32Array([bytes.length]), bytes.length, new Uint8Array(), 0);
            const heapBefore = module.HEAPU8.buffer;
            const heapBytesBefore = module.HEAPU8.byteLength;
            // More scratch than the complete current heap guarantees growth.
            // Bound the fixture before allocation if the codec's initial heap
            // changes, instead of silently expanding this test's memory cost.
            const payloadLength = heapBytesBefore + 65536;
            expect(payloadLength).toBeLessThanOrEqual(32 * 1024 * 1024);
            const payload = new Uint8Array(payloadLength).fill(71);
            const expected = hashTermKeyBytes(payload);
            expect(api.tryHashImportBytes(payload)).toBe(expected);
            expect(module.HEAPU8.buffer).not.toBe(heapBefore);
            expect(module.HEAPU8.byteLength).toBeGreaterThan(heapBytesBefore);
            const compressed = api.finishPreparedSpanCompression(prepared);
            expect(api.decompress(compressed)).toEqual(bytes);
        } finally { api.freeCCtx(context); }
    });
});
