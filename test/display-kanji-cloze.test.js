/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {createAnkiNoteData} from '../ext/js/data/anki-note-data-creator.js';
import {DisplayAnki} from '../ext/js/display/display-anki.js';
import {DisplayContentManager} from '../ext/js/display/display-content-manager.js';
import {DisplayGenerator} from '../ext/js/display/display-generator.js';
import {DisplayHistory} from '../ext/js/display/display-history.js';
import {Display} from '../ext/js/display/display.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/templates-display.html');

test.for([
    {term: '大学', reading: 'だいがく', surface: '大学', linkIndex: 1, characterOffset: 1},
    {term: '取り組む', reading: 'とりくむ', surface: '取り組んだ', linkIndex: 1, characterOffset: 2},
    {term: '𠮟責', reading: 'しっせき', surface: '𠮟責', linkIndex: 1, characterOffset: 1},
    {term: '人人', reading: 'ひとひと', surface: '人人', linkIndex: 1, characterOffset: 1},
    {term: '大学', reading: 'だいがく', surface: '大学', linkIndex: 0, characterOffset: 0},
    {term: '大学', reading: 'だいがく', surface: '大学', linkIndex: 1, characterOffset: 1, fromUrl: true},
    {term: '大学', reading: 'だいがく', surface: 'だいがく', linkIndex: 1, characterOffset: 1, sourceMatches: false},
])('kanji navigation preserves the clicked source position: %j', ({term, reading, surface, linkIndex, characterOffset, fromUrl = false, sourceMatches = true}, {window}) => {
    const prefix = '𠮟る人は';
    const suffix = 'を見た';
    const sourceSentence = {text: `${prefix}${surface}${suffix}`, offset: [...prefix].length};
    const history = new DisplayHistory(true, false);
    history.replaceState(fromUrl ? {} : {sentence: sourceSentence}, null);
    const display = /** @type {Display} */ (Object.assign(Object.create(Display.prototype), {
        _history: history,
        _historyHasChanged: true,
        _fullQuery: fromUrl ? sourceSentence.text : surface,
        _query: surface,
        _queryOffset: fromUrl ? prefix.length : 0,
        _queryParserVisibleOverride: null,
        _options: null,
        _windowScroll: {x: 0, y: 0},
        _index: 0,
        _createStateChangeCompletion: () => ({promise: Promise.resolve('completed'), finish: vi.fn()}),
        getOptionsContext: () => ({current: true}),
        getContentOrigin: () => ({tabId: null, frameId: null}),
        onError: vi.fn(),
    }));
    const generator = new DisplayGenerator(new DisplayContentManager(display), null);
    generator._templates.load(window.document);
    const headword = generator._createTermHeadword({
        index: 0,
        headwordIndex: 0,
        term,
        reading,
        sources: [{originalText: surface, transformedText: surface, deinflectedText: term, isPrimary: true, matchType: 'exact', matchSource: 'term'}],
        tags: [],
        wordClasses: [],
    }, 0, []);
    window.document.body.append(headword);
    const link = /** @type {HTMLAnchorElement} */ (headword.querySelectorAll('.headword-kanji-link')[linkIndex]);
    const character = link.textContent ?? '';
    link.addEventListener('click', display._onKanjiLookup.bind(display));

    link.click();

    expect(display.onError).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('query')).toBe(character);
    const fullQueryOffset = (fromUrl ? prefix.length : 0) + [...surface].slice(0, characterOffset).join('').length;
    expect(new URLSearchParams(window.location.search).get('offset')).toBe(sourceMatches ? String(fullQueryOffset) : null);
    const anki = /** @type {DisplayAnki} */ (Object.assign(Object.create(DisplayAnki.prototype), {_display: display}));
    const context = anki._getNoteContext();
    if (context === null) { throw new Error('Expected a note context'); }
    expect(sourceSentence.offset).toBe([...prefix].length);
    if (!sourceMatches) {
        expect(context.sentence).toEqual(sourceSentence);
        expect(display.history.state?.sentence).toBe(sourceSentence);
        return;
    }
    const data = createAnkiNoteData('cloze-body', {
        dictionaryEntry: {
            type: 'kanji',
            character,
            dictionary: 'test',
            dictionaryAlias: 'test',
            dictionaryIndex: 0,
            onyomi: [],
            kunyomi: [],
            definitions: [],
            tags: [],
            stats: {},
            frequencies: [],
        },
        cardFormat: {type: 'kanji', name: 'Kanji', deck: 'Deck', model: 'Model', fields: {}, icon: 'big-circle'},
        context,
        resultOutputMode: 'split',
        glossaryLayoutMode: 'default',
        compactTags: false,
        media: {},
        dictionaryStylesMap: new Map(),
    });

    expect(data.definition.cloze).toEqual({
        sentence: sourceSentence.text,
        prefix: `${prefix}${[...surface].slice(0, characterOffset).join('')}`,
        body: character,
        bodyKana: character,
        suffix: `${[...surface].slice(characterOffset + 1).join('')}${suffix}`,
    });
});
