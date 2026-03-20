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

import {describe, expect, test} from 'vitest';

import {normalizeDictionarySummary, setDictionarySummaryAutoUpdate} from '../ext/js/dictionary/dictionary-auto-update-util.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * @param {Partial<import('dictionary-importer').Summary>} [overrides]
 * @returns {import('dictionary-importer').Summary}
 */
function createDictionarySummary(overrides = {}) {
    return /** @type {import('dictionary-importer').Summary} */ ({
        title: 'Test Dictionary',
        revision: '1',
        sequenced: false,
        version: 3,
        importDate: 100,
        prefixWildcardsSupported: false,
        styles: '',
        counts: {
            terms: {total: 1},
            termMeta: {total: 0},
            kanji: {total: 0},
            kanjiMeta: {total: 0},
            tagMeta: {total: 0},
            media: {total: 0},
        },
        isUpdatable: true,
        indexUrl: 'https://example.invalid/index.json',
        downloadUrl: 'https://example.invalid/dictionary.zip',
        importSuccess: true,
        autoUpdate: {
            schedule: 'manual',
            lastUpdatedAt: 100,
            nextUpdateAt: null,
        },
        ...overrides,
    });
}

describe('dictionary-auto-update-util', () => {
    test('normalizeDictionarySummary preserves stored nextUpdateAt for scheduled dictionaries', () => {
        const summary = createDictionarySummary({
            autoUpdate: {
                schedule: 'daily',
                lastUpdatedAt: 250,
                nextUpdateAt: 999,
            },
        });

        const normalizedSummary = normalizeDictionarySummary(summary);

        expect(normalizedSummary.autoUpdate).toStrictEqual({
            schedule: 'daily',
            lastUpdatedAt: 250,
            nextUpdateAt: 999,
        });
    });

    test('normalizeDictionarySummary synthesizes missing nextUpdateAt from lastUpdatedAt', () => {
        const summary = createDictionarySummary();
        summary.autoUpdate = /** @type {import('dictionary-importer').DictionaryAutoUpdateInfo} */ (/** @type {unknown} */ ({
            schedule: 'daily',
            lastUpdatedAt: 250,
        }));

        const normalizedSummary = normalizeDictionarySummary(summary);

        expect(normalizedSummary.autoUpdate).toStrictEqual({
            schedule: 'daily',
            lastUpdatedAt: 250,
            nextUpdateAt: 250 + DAY_MS,
        });
    });

    test('normalizeDictionarySummary synthesizes invalid nextUpdateAt values from lastUpdatedAt', () => {
        const summary = createDictionarySummary({
            autoUpdate: /** @type {import('dictionary-importer').DictionaryAutoUpdateInfo} */ ({
                schedule: 'weekly',
                lastUpdatedAt: 300,
                nextUpdateAt: Number.NaN,
            }),
        });

        const normalizedSummary = normalizeDictionarySummary(summary);

        expect(normalizedSummary.autoUpdate).toStrictEqual({
            schedule: 'weekly',
            lastUpdatedAt: 300,
            nextUpdateAt: 300 + WEEK_MS,
        });
    });

    test('normalizeDictionarySummary forces manual schedules to keep nextUpdateAt null', () => {
        const summary = createDictionarySummary({
            autoUpdate: {
                schedule: 'manual',
                lastUpdatedAt: 400,
                nextUpdateAt: 400 + HOUR_MS,
            },
        });

        const normalizedSummary = normalizeDictionarySummary(summary);

        expect(normalizedSummary.autoUpdate).toStrictEqual({
            schedule: 'manual',
            lastUpdatedAt: 400,
            nextUpdateAt: null,
        });
    });

    test('setDictionarySummaryAutoUpdate preserves nextUpdateAt when schedule metadata is otherwise unchanged', () => {
        const summary = createDictionarySummary({
            autoUpdate: {
                schedule: 'daily',
                lastUpdatedAt: 500,
                nextUpdateAt: 750,
            },
        });

        const updatedSummary = setDictionarySummaryAutoUpdate(summary, {schedule: 'daily'});

        expect(updatedSummary.autoUpdate).toStrictEqual({
            schedule: 'daily',
            lastUpdatedAt: 500,
            nextUpdateAt: 750,
        });
    });

    test('setDictionarySummaryAutoUpdate accepts explicit nextUpdateAt overrides', () => {
        const summary = createDictionarySummary({
            autoUpdate: {
                schedule: 'daily',
                lastUpdatedAt: 600,
                nextUpdateAt: 600 + DAY_MS,
            },
        });

        const updatedSummary = setDictionarySummaryAutoUpdate(summary, {
            nextUpdateAt: 12345,
        });

        expect(updatedSummary.autoUpdate).toStrictEqual({
            schedule: 'daily',
            lastUpdatedAt: 600,
            nextUpdateAt: 12345,
        });
    });
});
