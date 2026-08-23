/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('DictionaryImporter progress delivery', () => {
    test('coalesces rapid updates while preserving regular forward progress and step boundaries', () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        /** @type {import('dictionary-importer').ProgressData[]} */
        const events = [];
        const importer = new DictionaryImporter(
            new DictionaryImporterMediaLoader(),
            (event) => { events.push(event); },
        );
        const progressReset = /** @type {() => void} */ (Reflect.get(importer, '_progressReset')).bind(importer);
        const setProgressInterval = /** @type {(intervalMs: number) => void} */ (Reflect.get(importer, '_setProgressInterval')).bind(importer);
        const progress = /** @type {(nextStep?: boolean) => void} */ (Reflect.get(importer, '_progress')).bind(importer);

        progressReset();
        setProgressInterval(100);
        const progressData = /** @type {import('dictionary-importer').ProgressData} */ (Reflect.get(importer, '_progressData'));
        progressData.count = 1_000;

        progressData.index = 100;
        now += 50;
        progress();
        expect(events).toHaveLength(1);

        now += 50;
        progress();
        expect(events.at(-1)).toEqual({index: 100, count: 1_000, nextStep: false});

        now += 50;
        progress();
        expect(events).toHaveLength(2);

        progressData.index = 200;
        progress();
        expect(events).toHaveLength(2);

        now += 50;
        progress();
        expect(events.at(-1)).toEqual({index: 200, count: 1_000, nextStep: false});

        progressData.index = 0;
        progressData.count = 20;
        now += 1;
        progress(true);
        expect(events.at(-1)).toEqual({index: 0, count: 20, nextStep: true});
        expect(events.map(({index}) => index)).toEqual([0, 100, 200, 0]);
    });
});
