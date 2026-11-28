/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {planContentIdentityLayouts} from '../ext/js/dictionary/term-content-identity-layout.js';
import {createContentLayoutResolver} from '../ext/js/dictionary/term-content-layout.js';

test('preserves a partial legacy tail and appends an arena at the exact logical address', () => {
    const legacy = planContentIdentityLayouts('legacy', 0, 7, [{
        fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 7, logicalStart: 0, logicalEnd: 7,
    }]);
    const arena = planContentIdentityLayouts('import-1', 7, 12, [{
        fileId: 'arena-1',
        path: 'manabitan-term-content-arenas-v1/import-1/manabitan-term-content.bin',
        byteLength: 5,
        logicalStart: 7,
        logicalEnd: 12,
    }]);
    const files = [...legacy.files, ...arena.files].map((file) => ({fileId: file.fileId, byteLength: file.byteLength, sha256: null}));
    const resolver = createContentLayoutResolver({
        manifests: [...legacy.layouts, ...arena.layouts].map(({manifest}) => manifest),
        externalFrames: [],
        files,
        physicalFiles: files,
        codecs: [],
    });
    expect(resolver.resolveLogical(5, 5)).toEqual([
        {fileId: 'legacy-0', physicalOffset: 5, length: 2},
        {fileId: 'arena-1', physicalOffset: 0, length: 3},
    ]);
});

test('splits a large closed file while keeping absolute offsets above 32 bits', () => {
    const start = 2 ** 32 + 13;
    const byteLength = 128 * 1024 * 1024 + 7;
    const plan = planContentIdentityLayouts('large', start, start + byteLength, [{
        fileId: 'arena-large',
        path: 'manabitan-term-content-arenas-v1/large/manabitan-term-content.bin',
        byteLength,
        logicalStart: start,
        logicalEnd: start + byteLength,
    }]);
    expect(plan.regions.map(({logicalStart, logicalLength}) => [logicalStart, logicalLength])).toEqual([
        [start, 128 * 1024 * 1024], [start + 128 * 1024 * 1024, 7],
    ]);
    expect(plan.layouts[1].manifest.extents[0].physicalOffset).toBe(128 * 1024 * 1024);
});

test('dedupe-only imports require no new region or file', () => {
    expect(planContentIdentityLayouts('empty', 9, 9, [])).toEqual({regions: [], layouts: [], files: []});
    expect(planContentIdentityLayouts('empty', 0, 0, [{
        fileId: 'empty', path: 'manabitan-term-content.bin', byteLength: 0, logicalStart: 0, logicalEnd: 0,
    }])).toEqual({regions: [], layouts: [], files: []});
});

test.each([
    [{fileId: 'a', path: 'manabitan-term-content.bin', byteLength: 3, logicalStart: 1, logicalEnd: 4}],
    [{fileId: 'a', path: 'manabitan-term-content.bin', byteLength: 3, logicalStart: 0, logicalEnd: 2}],
    [{fileId: 'a', path: '../foreign', byteLength: 3, logicalStart: 0, logicalEnd: 3}],
    [{fileId: 'a', path: 'manabitan-term-content.bin', byteLength: 2, logicalStart: 0, logicalEnd: 2},
        {fileId: 'a', path: 'manabitan-term-content^1.bin', byteLength: 1, logicalStart: 2, logicalEnd: 3}],
    [{fileId: 'a', path: 'manabitan-term-content.bin', byteLength: 2, logicalStart: 0, logicalEnd: 2},
        {fileId: 'b', path: 'manabitan-term-content.bin', byteLength: 1, logicalStart: 2, logicalEnd: 3}],
].map((files) => ({files})))('rejects ambiguous physical or logical identity %#', ({files}) => {
    expect(() => planContentIdentityLayouts('invalid', 0, 3, files)).toThrow();
});
