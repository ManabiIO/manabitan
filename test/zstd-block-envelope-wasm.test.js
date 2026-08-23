/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import fs from 'node:fs/promises';

import {describe, expect, test} from 'vitest';

import createZstdModule from '../dev/lib/zstd-simd-module.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';

describe('zstd native block envelope', () => {
    test('matches the portable XXH32 integrity hash across boundary lengths', async () => {
        const wasmBinary = await fs.readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url));
        const module = await createZstdModule({wasmBinary});
        for (const length of [1, 3, 15, 16, 17, 31, 32, 33, 4099]) {
            const payload = Uint8Array.from({length}, (_, index) => (index * 131 + length) & 0xff);
            const outputLength = 12 + payload.byteLength;
            const pointer = module._malloc(outputLength);
            expect(pointer).not.toBe(0);
            try {
                module.HEAPU8.fill(0, pointer, pointer + outputLength);
                module.HEAPU8.set(payload, pointer + 12);
                expect(module._manabitan_write_block_envelope(pointer, outputLength)).toBe(1);
                const output = module.HEAPU8.slice(pointer, pointer + outputLength);
                const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
                const [hash1, hash2] = hashTermEntryContentBytesPair(payload);
                expect([...output.subarray(0, 4)]).toEqual([0x4d, 0x42, 0x43, 0x32]);
                expect(view.getUint32(4, true)).toBe(hash1);
                expect(view.getUint32(8, true)).toBe(hash2);
                expect(output.subarray(12)).toEqual(payload);
            } finally {
                module._free(pointer);
            }
        }
    });
});
