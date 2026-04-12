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

import {describe, expect, test, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';

describe('Display dictionary update handling', () => {
    test('dictionary database updates refresh cached dictionary info', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'clear');
        Reflect.set(display, 'searchLast', vi.fn());
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(Reflect.get(display, '_dictionaryInfo')).toStrictEqual([{title: 'JMdict'}]);
        expect(Reflect.get(display, 'searchLast')).not.toHaveBeenCalled();
    });

    test('dictionary database updates rerun visible popup/search results outside the search page', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'delete'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledWith(false);
    });

    test('dictionary database updates do not double-rerun the dedicated search page', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(searchLast).not.toHaveBeenCalled();
    });

    test('dictionary database updates do not rerun non-search displays in unloaded state', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'unloaded');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(updateOptions).not.toHaveBeenCalled();
        expect(searchLast).not.toHaveBeenCalled();
    });

    test('dictionary database updates refresh empty search-page dictionary state', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const updateOptions = vi.fn().mockImplementation(async () => {
            Reflect.set(display, '_options', {dictionaries: [{enabled: true}]});
        });
        const setNoContentVisible = vi.fn();
        const setNoDictionariesVisible = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'clear');
        Reflect.set(display, '_options', {dictionaries: [{enabled: false}]});
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, '_setNoContentVisible', setNoContentVisible);
        Reflect.set(display, '_setNoDictionariesVisible', setNoDictionariesVisible);
        Reflect.set(display, 'searchLast', vi.fn());
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(setNoContentVisible).toHaveBeenCalledWith(false);
        expect(setNoDictionariesVisible).toHaveBeenCalledWith(false);
    });

    test('stale dictionary-info refresh does not overwrite newer display state', async () => {
        let resolveFirst;
        let resolveSecond;
        const getDictionaryInfo = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirst = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveSecond = resolve;
            }));
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
        });

        const firstRefresh = Display.prototype._refreshDictionaryInfo.call(display);
        const secondRefresh = Display.prototype._refreshDictionaryInfo.call(display);
        resolveSecond([{title: 'Jitendex'}]);
        await secondRefresh;
        resolveFirst([{title: 'JMdict'}]);
        await firstRefresh;

        expect(Reflect.get(display, '_dictionaryInfo')).toStrictEqual([{title: 'Jitendex'}]);
    });

    test('options updates rerun visible popup results outside the search page', async () => {
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledWith(false);
    });

    test('options updates do not rerun the dedicated search page display directly', async () => {
        const updateOptions = vi.fn().mockImplementation(async () => {
            Reflect.set(display, '_options', {dictionaries: [{enabled: true}]});
        });
        const searchLast = vi.fn();
        const setNoContentVisible = vi.fn();
        const setNoDictionariesVisible = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'clear');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_options', {dictionaries: [{enabled: false}]});
        Reflect.set(display, '_setNoContentVisible', setNoContentVisible);
        Reflect.set(display, '_setNoDictionariesVisible', setNoDictionariesVisible);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(searchLast).not.toHaveBeenCalled();
        expect(setNoContentVisible).toHaveBeenCalledWith(false);
        expect(setNoDictionariesVisible).toHaveBeenCalledWith(false);
    });

    test('options updates do not rerun search results directly when the dedicated search page is already showing content', async () => {
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).not.toHaveBeenCalled();
        expect(searchLast).not.toHaveBeenCalled();
    });

    test('options updates do not rerun non-search displays in unloaded state', async () => {
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'unloaded');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).not.toHaveBeenCalled();
        expect(searchLast).not.toHaveBeenCalled();
    });
});
