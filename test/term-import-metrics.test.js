/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {addTermImportMetrics, copyTermImportMetrics, createTermImportMetrics, TERM_IMPORT_METRIC_KEYS} from '../ext/js/dictionary/term-import-metrics.js';

describe('term import metrics', () => {
    test('creates a complete zero-valued accumulator', () => {
        const metrics = createTermImportMetrics();
        expect(Object.keys(metrics)).toStrictEqual([...TERM_IMPORT_METRIC_KEYS]);
        expect(Object.values(metrics).every((value) => value === 0)).toBe(true);
    });

    test('adds finite known metrics and ignores diagnostic extras', () => {
        const metrics = createTermImportMetrics();
        addTermImportMetrics(metrics, {contentAppendMs: 12, bulkAddTermsMs: 5, unknownMs: 99, mediaWriteMs: Number.NaN});
        expect(metrics.contentAppendMs).toBe(12);
        expect(metrics.bulkAddTermsMs).toBe(5);
        expect(metrics.mediaWriteMs).toBe(0);
        expect(metrics).not.toHaveProperty('unknownMs');
    });

    test('copies metrics without sharing mutable state', () => {
        const source = createTermImportMetrics();
        source.contentStoreMs = 7;
        const copy = copyTermImportMetrics(source);
        copy.contentStoreMs = 8;
        expect(source.contentStoreMs).toBe(7);
    });
});
