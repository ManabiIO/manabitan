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

import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {installReaderLookupIntegration} from '../ext/js/app/reader-lookup-integration.js';
import {createAnkiNoteData} from '../ext/js/data/anki-note-data-creator.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();

afterAll(async () => { await testEnv.teardown(global); });
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {string} term
 * @param {string} reading
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function createEntry(term, reading) {
    return /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({
        type: 'term',
        headwords: [{term, reading, sources: [{originalText: term, transformedText: term, deinflectedText: term, isPrimary: true}]}],
        definitions: [],
    }));
}

/**
 * @param {import('dictionary').TermDictionaryEntry} dictionaryEntry
 * @param {import('display').HistoryStateSentence} sentence
 * @returns {import('anki-templates').Cloze}
 */
function createCloze(dictionaryEntry, sentence) {
    return createAnkiNoteData('cloze-body', {
        dictionaryEntry,
        cardFormat: {type: 'term', name: 'Reader test', deck: 'Default', model: 'Basic', fields: {}, icon: 'big-circle'},
        resultOutputMode: 'split',
        glossaryLayoutMode: 'default',
        compactTags: false,
        context: {sentence, url: '', documentTitle: '', query: '', fullQuery: ''},
        media: void 0,
        dictionaryStylesMap: new Map(),
    }).definition.cloze;
}

test('reader UTF-16 offsets become code-point mining offsets and preserve the inflected span', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false}));
    /** @type {import('../ext/js/app/reader-lookup-bridge.js').ReaderLookup} */
    const request = {protocol: 1, term: '見る', reading: 'みる', surface: '見られなかった', sentence: '😀見られなかった。', offset: 2};
    const showContent = vi.fn();
    const frontend = /** @type {import('../ext/js/app/frontend.js').Frontend} */ (/** @type {unknown} */ ({
        _options: {general: {enable: true}},
        _disabledOverride: false,
        _getOptionsContext: async () => ({}),
        _application: {api: {termsFind: vi.fn(async () => ({dictionaryEntries: [createEntry(request.term, request.reading)]}))}},
        _textScanner: {beginExternalLookup: vi.fn(), setCurrentTextSource: vi.fn()},
        _showContent: showContent,
        showContentCompleted: async () => {},
    }));
    const bridge = installReaderLookupIntegration(frontend);
    try {
        const anchor = document.createElement('span');
        anchor.textContent = request.surface;
        await Reflect.get(bridge, '_show')(request, anchor, () => true, () => () => {});
        const call = showContent.mock.calls[0];
        const entries = call[2];
        const sentence = call[4];
        expect(sentence).toEqual({text: request.sentence, offset: 1});
        expect(createCloze(entries[0], sentence)).toMatchObject({prefix: '😀', body: request.surface, suffix: '。'});
    } finally {
        bridge.dispose();
    }
});

test('cloze body length counts supplementary characters once', () => {
    const entry = createEntry('𠮷野', 'よしの');
    expect(createCloze(entry, {text: '😀𠮷野です。', offset: 1})).toMatchObject({prefix: '😀', body: '𠮷野', suffix: 'です。'});
});

test.each([false, true])('reader popup preserves dictionary repair warnings (has exact results: %s)', async (hasResults) => {
    vi.stubGlobal('matchMedia', () => ({matches: false}));
    /** @type {import('../ext/js/app/reader-lookup-bridge.js').ReaderLookup} */
    const request = {protocol: 1, term: 'cat', reading: 'cat', surface: 'cat', sentence: 'cat', offset: 0};
    /** @type {import('translator').DictionaryAvailability[]} */
    const dictionaryAvailability = [{dictionary: 'Repairing', generationId: 'generation-1', status: 'repairing', reason: 'index missing'}];
    /** @type {import('translator').DictionaryAvailability[]|undefined} */
    let availability = dictionaryAvailability;
    const showPopup = vi.fn().mockResolvedValue(void 0);
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    Object.assign(frontend, {
        _options: {general: {enable: true}},
        _disabledOverride: false,
        _getOptionsContext: async () => ({url: 'https://example.test/'}),
        _application: {api: {termsFind: async () => ({
            dictionaryEntries: hasResults ? [createEntry(request.term, request.reading)] : [],
            dictionaryAvailability: availability,
        })}},
        _textScanner: {setCurrentTextSource: vi.fn()},
        _showPopupContent: showPopup,
        showContentCompleted: async () => {},
    });
    const bridge = installReaderLookupIntegration(frontend);
    try {
        const anchor = document.createElement('span');
        anchor.textContent = request.surface;
        await Reflect.get(bridge, '_show')(request, anchor, () => true, () => () => {});
        expect(showPopup).toHaveBeenCalledOnce();
        const details = showPopup.mock.calls[0][2];
        expect(details.content.dictionaryAvailability).toEqual(dictionaryAvailability);
        expect(details.content.dictionaryEntries).toHaveLength(hasResults ? 1 : 0);
        expect(document.documentElement.dataset.readerLookupStatus).toBe('incomplete');

        availability = void 0;
        await Reflect.get(bridge, '_show')(request, anchor, () => true, () => () => {});
        expect(showPopup.mock.calls[1][2].content.dictionaryAvailability).toBeUndefined();
        expect(document.documentElement.dataset.readerLookupStatus).toBe(hasResults ? 'shown' : 'no-exact-match');
    } finally {
        bridge.dispose();
        delete document.documentElement.dataset.readerLookupStatus;
    }
});
