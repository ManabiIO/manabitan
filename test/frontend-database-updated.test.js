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
import {Frontend} from '../ext/js/app/frontend.js';

describe('Frontend dictionary update handling', () => {
    test('hover lookup prewarm stops scheduling probes after the first dictionary hit', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        const calls = [];
        /** @type {Array<() => void>} */
        const resolvers = [];
        Reflect.set(frontend, '_application', {
            api: {
                termsFind: vi.fn((term) => new Promise((resolve) => {
                    calls.push(term);
                    resolvers.push(() => {
                        resolve({
                            dictionaryEntries: term === '日本' ? [{dictionary: 'JMdict'}] : [],
                        });
                    });
                })),
            },
        });

        const runLookupPrewarmTerms = Reflect.get(Frontend.prototype, '_runLookupPrewarmTerms');
        const {firstMatchedResultPromise, resultsPromise} = runLookupPrewarmTerms.call(frontend, ['日本', 'する', 'ある', '見る', '食べる'], {});

        expect(calls).toEqual(['日本', 'する']);
        resolvers[0]();
        const firstMatchedResult = await firstMatchedResultPromise;
        expect(firstMatchedResult).toEqual({term: '日本', dictionaryEntries: [{dictionary: 'JMdict'}]});
        for (let i = 1; i < resolvers.length; ++i) {
            resolvers[i]();
        }
        const results = await resultsPromise;

        expect(calls).toEqual(['日本', 'する']);
        expect(results).toHaveLength(2);
        expect(Reflect.get(frontend, '_application').api.termsFind).toHaveBeenCalledTimes(2);
    });

    test('options updates rerun the active hover lookup and do not clear state on success', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_application', {webExtension: {unloaded: false}});
        Reflect.set(frontend, 'updateOptions', vi.fn().mockResolvedValue(void 0));
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());

        const onOptionsUpdated = Reflect.get(Frontend.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(frontend);

        expect(Reflect.get(frontend, '_updatePageDebugState')).toHaveBeenCalledWith({lastSearchState: 'options-updated'});
        expect(Reflect.get(frontend, 'updateOptions')).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_clearSelection')).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_clearMousePosition')).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_optionsUpdateSearchActive')).toBe(false);
    });

    test('options updates clear hover state when options refresh fails', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_application', {webExtension: {unloaded: false}});
        Reflect.set(frontend, 'updateOptions', vi.fn().mockRejectedValue(new Error('options refresh failed')));
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());

        const onOptionsUpdated = Reflect.get(Frontend.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(frontend);

        expect(Reflect.get(frontend, '_clearSelection')).toHaveBeenCalledWith(true);
        expect(Reflect.get(frontend, '_clearMousePosition')).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_optionsUpdateSearchActive')).toBe(false);
    });

    test('dictionary database updates rerun the active hover lookup when available', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_application', {webExtension: {unloaded: false}});
        Reflect.set(frontend, 'updateOptions', vi.fn().mockResolvedValue(void 0));
        Reflect.set(frontend, '_textScanner', {searchLast: vi.fn().mockResolvedValue(true)});
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());
        Reflect.set(frontend, '_startPopupPrewarmForHover', vi.fn());

        const onDatabaseUpdated = Reflect.get(Frontend.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(frontend, {type: 'dictionary', cause: 'import'});

        expect(Reflect.get(frontend, '_updatePageDebugState')).toHaveBeenCalledWith({lastSearchState: 'dictionary-updated'});
        expect(Reflect.get(frontend, 'updateOptions')).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, 'updateOptions')).toHaveBeenCalledWith(true);
        expect(Reflect.get(frontend, '_startPopupPrewarmForHover')).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_textScanner').searchLast).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_clearSelection')).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_clearMousePosition')).not.toHaveBeenCalled();
    });

    test('dictionary database updates clear hover state when no active lookup can be rerun', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_application', {webExtension: {unloaded: false}});
        Reflect.set(frontend, 'updateOptions', vi.fn().mockResolvedValue(void 0));
        Reflect.set(frontend, '_textScanner', {searchLast: vi.fn().mockResolvedValue(false)});
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());
        Reflect.set(frontend, '_startPopupPrewarmForHover', vi.fn());

        const onDatabaseUpdated = Reflect.get(Frontend.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(frontend, {type: 'dictionary', cause: 'import'});

        expect(Reflect.get(frontend, 'updateOptions')).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_startPopupPrewarmForHover')).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_textScanner').searchLast).toHaveBeenCalledOnce();
        expect(Reflect.get(frontend, '_clearSelection')).toHaveBeenCalledWith(true);
        expect(Reflect.get(frontend, '_clearMousePosition')).toHaveBeenCalledOnce();
    });

    test('dictionary database updates clear hover state when options refresh fails', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_application', {webExtension: {unloaded: false}});
        Reflect.set(frontend, 'updateOptions', vi.fn().mockRejectedValue(new Error('options refresh failed')));
        Reflect.set(frontend, '_textScanner', {searchLast: vi.fn()});
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());

        const onDatabaseUpdated = Reflect.get(Frontend.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(frontend, {type: 'dictionary', cause: 'import'});

        expect(Reflect.get(frontend, '_textScanner').searchLast).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_clearSelection')).toHaveBeenCalledWith(true);
        expect(Reflect.get(frontend, '_clearMousePosition')).toHaveBeenCalledOnce();
    });

    test('non-dictionary database updates do not clear hover lookup state', async () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_application', {webExtension: {unloaded: false}});
        Reflect.set(frontend, '_textScanner', {searchLast: vi.fn()});
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());

        const onDatabaseUpdated = Reflect.get(Frontend.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(frontend, {type: 'anki-note', cause: 'import'});

        expect(Reflect.get(frontend, '_updatePageDebugState')).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_textScanner').searchLast).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_clearSelection')).not.toHaveBeenCalled();
        expect(Reflect.get(frontend, '_clearMousePosition')).not.toHaveBeenCalled();
    });

    test('dictionary-update empty results clear stale hover state even when auto-hide is disabled', () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_dictionaryUpdateSearchActive', true);
        Reflect.set(frontend, '_options', {scanning: {autoHideResults: false, hideDelay: 0}});
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());

        const onSearchEmpty = Reflect.get(Frontend.prototype, '_onSearchEmpty');
        onSearchEmpty.call(frontend);

        expect(Reflect.get(frontend, '_clearSelection')).toHaveBeenCalledWith(true);
        expect(Reflect.get(frontend, '_clearMousePosition')).toHaveBeenCalledOnce();
    });

    test('options-update empty results clear stale hover state even when auto-hide is disabled', () => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        Reflect.set(frontend, '_optionsUpdateSearchActive', true);
        Reflect.set(frontend, '_options', {scanning: {autoHideResults: false, hideDelay: 0}});
        Reflect.set(frontend, '_clearSelection', vi.fn());
        Reflect.set(frontend, '_clearMousePosition', vi.fn());
        Reflect.set(frontend, '_updatePageDebugState', vi.fn());

        const onSearchEmpty = Reflect.get(Frontend.prototype, '_onSearchEmpty');
        onSearchEmpty.call(frontend);

        expect(Reflect.get(frontend, '_clearSelection')).toHaveBeenCalledWith(true);
        expect(Reflect.get(frontend, '_clearMousePosition')).toHaveBeenCalledOnce();
    });
});
