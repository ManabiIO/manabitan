/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/**
 * @param {string} dictionary
 * @param {string} expression
 * @returns {{dictionary: string, expression: string, reading: string, score: number, sequence: number}}
 */
function createRow(dictionary, expression) {
    return {
        dictionary,
        expression,
        reading: expression,
        score: 0,
        sequence: -1,
    };
}

describe('resolved import loaded dictionary state', () => {
    test('publishes loaded state for one materialized dictionary without OPFS', async () => {
        const store = new TermRecordOpfsStore();
        const rows = [createRow('Dictionary A', 'alpha')];

        await store.appendBatchFromImportTermEntriesResolvedContent(
            rows,
            0,
            1,
            [10],
            [5],
            'raw',
        );

        expect(store.getDiagnostics(['Dictionary A']).dictionaries[0]).toMatchObject({
            dictionaryName: 'Dictionary A',
            loaded: true,
            materializedRecordCount: 1,
        });
    });

    test('publishes loaded state for every materialized dictionary in a mixed batch', async () => {
        const store = new TermRecordOpfsStore();
        const rows = [
            createRow('Dictionary A', 'alpha'),
            createRow('Dictionary B', 'beta'),
            createRow('Dictionary A', 'gamma'),
        ];

        await store.appendBatchFromImportTermEntriesResolvedContent(
            rows,
            0,
            rows.length,
            [10, 20, 30],
            [5, 5, 5],
            'raw',
        );

        const diagnostics = store.getDiagnostics(['Dictionary A', 'Dictionary B']).dictionaries;
        expect(diagnostics).toEqual([
            expect.objectContaining({
                dictionaryName: 'Dictionary A',
                loaded: true,
                materializedRecordCount: 2,
            }),
            expect.objectContaining({
                dictionaryName: 'Dictionary B',
                loaded: true,
                materializedRecordCount: 1,
            }),
        ]);
    });
});
