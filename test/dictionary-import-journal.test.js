/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryImportJournal} from '../ext/js/dictionary/dictionary-import-journal.js';

describe('DictionaryImportJournal', () => {
    const createRecord = () => ({
        version: 1,
        sessionId: 'session-id',
        contentCheckpoint: {
            segments: [{fileName: 'manabitan-term-content.bin', fileLength: 1024}],
        },
        recordCheckpoint: {
            shards: [
                {fileName: 'dict-JMdict.mbtr', fileLength: 2048},
                {fileName: 'dict-JMdict.mbtr.mbti', fileLength: 512},
            ],
        },
        createdAt: 1234,
    });

    test('accepts complete checkpoints including lookup sidecars', () => {
        const journal = new DictionaryImportJournal();
        expect(Reflect.get(journal, '_isRecord').call(journal, createRecord())).toBe(true);
    });

    /** @type {Array<[string, (record: ReturnType<typeof createRecord>) => void]>} */
    const invalidRecords = [
        ['unsafe length', (record) => { record.recordCheckpoint.shards[0].fileLength = Number.MAX_SAFE_INTEGER + 1; }],
        ['negative length', (record) => { record.contentCheckpoint.segments[0].fileLength = -1; }],
        ['duplicate file', (record) => { record.recordCheckpoint.shards.push({...record.recordCheckpoint.shards[0]}); }],
        ['path separator', (record) => { record.recordCheckpoint.shards[0].fileName = '../dict.mbtr'; }],
        ['missing creation time', (record) => { delete /** @type {{createdAt?: number}} */ (record).createdAt; }],
    ];
    test.each(invalidRecords)('rejects %s', (_name, mutate) => {
        const journal = new DictionaryImportJournal();
        const record = createRecord();
        mutate(record);
        expect(Reflect.get(journal, '_isRecord').call(journal, record)).toBe(false);
    });

    test('clears an empty pre-import journal as an abandoned safe state', async () => {
        const removeEntry = vi.fn(async () => {});
        vi.stubGlobal('navigator', {
            storage: {
                getDirectory: vi.fn(async () => ({
                    getFileHandle: vi.fn(async () => ({
                        getFile: vi.fn(async () => ({size: 0, text: vi.fn(async () => '')})),
                    })),
                    removeEntry,
                })),
            },
        });
        try {
            await expect(new DictionaryImportJournal().read()).resolves.toBeNull();
            expect(removeEntry).toHaveBeenCalledWith('manabitan-dictionary-import-journal.json');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('refuses to start an unjournaled import without OPFS', async () => {
        vi.stubGlobal('navigator', {});
        try {
            await expect(new DictionaryImportJournal().write(createRecord()))
                .rejects.toThrow('Dictionary import journal requires OPFS');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('aborts rather than commits a failed journal write', async () => {
        const writeError = new Error('quota exhausted');
        const writable = {
            write: vi.fn().mockRejectedValue(writeError),
            abort: vi.fn().mockResolvedValue(),
            close: vi.fn().mockResolvedValue(),
        };
        vi.stubGlobal('navigator', {
            storage: {
                getDirectory: vi.fn(async () => ({
                    getFileHandle: vi.fn(async () => ({
                        createWritable: vi.fn(async () => writable),
                    })),
                })),
            },
        });
        try {
            await expect(new DictionaryImportJournal().write(createRecord()))
                .rejects.toThrow('quota exhausted');
            expect(writable.abort).toHaveBeenCalledWith(writeError);
            expect(writable.close).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('aborts when committing a journal writable fails', async () => {
        const closeError = new Error('commit failed');
        const writable = {
            write: vi.fn().mockResolvedValue(),
            abort: vi.fn().mockResolvedValue(),
            close: vi.fn().mockRejectedValue(closeError),
        };
        vi.stubGlobal('navigator', {
            storage: {
                getDirectory: vi.fn(async () => ({
                    getFileHandle: vi.fn(async () => ({
                        createWritable: vi.fn(async () => writable),
                    })),
                })),
            },
        });
        try {
            await expect(new DictionaryImportJournal().write(createRecord()))
                .rejects.toThrow('commit failed');
            expect(writable.abort).toHaveBeenCalledWith(closeError);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
