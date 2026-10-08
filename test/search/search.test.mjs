/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {japaneseSearchQueries, findJapaneseSearch, isJapanesePrefixCandidate} from '../../ext/js/search/japanese-search.js';
import {dictionaryPreview, glossaryPreview} from '../../ext/js/search/dictionary-preview.js';
import {SearchDisplayController} from '../../ext/js/display/search-display-controller.js';
import {Display} from '../../ext/js/display/display.js';
for (const [left, right, kana] of [['shi', 'si', 'し'], ['chi', 'ti', 'ち'], ['tsu', 'tu', 'つ'], ['fu', 'hu', 'ふ'], ['ji', 'zi', 'じ'], ['sha', 'sya', 'しゃ'], ['cha', 'tya', 'ちゃ']]) {
    test(`existing converter: ${left}/${right}`, () => {
        assert(japaneseSearchQueries(left).includes(kana));
        assert(japaneseSearchQueries(right).includes(kana));
    });
}
test('romaji apostrophes, sokuon, terminal n, mixed case and width', () => {
    for (const [raw, kana] of [["shin'you", 'しんよう'], ['gakkou', 'がっこう'], ['kan', 'かん'], ['ShINyA', 'しにゃ'], ['ｶﾞｯｺｳ', 'ガッコウ'], ['ＴＯＵＫＹＯＵ', 'とうきょう']]) { assert(japaneseSearchQueries(raw).includes(kana), raw); }
});
test('ambiguous macrons are bounded alternatives, literal spelling stays first', () => {
    assert.deepEqual(japaneseSearchQueries('tōkyō'), ['tōkyō', 'とうきょう', 'とうきょお', 'とおきょう', 'とおきょお']);
    assert(japaneseSearchQueries('ōkami').includes('おおかみ'));
    assert(japaneseSearchQueries('ō'.repeat(100)).length <= 8);
});
test('kana/kanji and compatibility ideographs are not destructively normalized', () => {
    for (const query of ['食べました', 'たべました', '食べTai', '神', '漢字']) { assert.equal(japaneseSearchQueries(query)[0], query); }
    assert(!japaneseSearchQueries('神').includes('神'));
});
test('unfinished syllables and English are not stripped into misleading partial Japanese', () => {
    assert.deepEqual(japaneseSearchQueries('ny'), ['ny']);
    assert.deepEqual(japaneseSearchQueries('hello world'), ['hello world']);
    assert.deepEqual(japaneseSearchQueries('cat'), ['cat']);
    assert.deepEqual(japaneseSearchQueries('  '), []);
    assert.throws(() => japaneseSearchQueries('a'.repeat(257)), RangeError);
    assert.doesNotThrow(() => japaneseSearchQueries('𠮷'.repeat(256)));
    assert.throws(() => japaneseSearchQueries('𠮷'.repeat(257)), RangeError);
    assert.throws(() => japaneseSearchQueries('a\0'), RangeError);
});
test('implicit prefix candidates require completed Japanese and at least two code points', () => {
    for (const query of ['たべ', '食べ', 'ガッ', 'カー', 'あー', 'あ・い', 'こー']) { assert.equal(isJapanesePrefixCandidate(query), true, query); }
    for (const query of ['食', 'た', 'ny', 'hello', 'たbe', '猫!', '猫🐈', '猫3', 'ー?', 'ーー', '食べé', 'たべÑ', 'たべＡ']) {
        assert.equal(isJapanesePrefixCandidate(query), false, query);
    }
});
test('prefix completion runs only after all exact and spelling alternatives miss', async () => {
    const exact = [],
        prefixes = [];
    const found = await findJapaneseSearch('tabe', async (query) => {
        exact.push(query);
        return {dictionaryEntries: []};
    }, () => {}, async (query) => {
        prefixes.push(query);
        return {dictionaryEntries: query === 'たべ' ? [{id: 1}] : []};
    });
    assert.deepEqual(exact, ['tabe', 'たべ']);
    assert.deepEqual(prefixes, ['たべ']);
    assert.equal(found.matchedQuery, 'たべ');
    assert.equal(found.matchType, 'prefix');
});
test('exact dictionary result always outranks implicit prefix completion', async () => {
    let prefixes = 0;
    const exact = {dictionaryEntries: [{id: 9}], originalTextLength: 2};
    const found = await findJapaneseSearch('たべ', async () => exact, () => {}, async () => {
        prefixes++;
        return {dictionaryEntries: [{id: 10}]};
    });
    assert.equal(found.result, exact);
    assert.equal(found.matchType, 'exact');
    assert.equal(prefixes, 0);
});
test('shorter leading words do not suppress completion of an unfinished query', async () => {
    const leading = {dictionaryEntries: [{id: 1}], originalTextLength: 2};
    const completion = {dictionaryEntries: [{id: 2}], originalTextLength: 5};
    const found = await findJapaneseSearch('東京大学演', async () => leading, () => {}, async (query) => {
        assert.equal(query, '東京大学演');
        return completion;
    });
    assert.equal(found.result, completion);
    assert.equal(found.matchType, 'prefix');
});
test('a complete spelling alternative outranks a shorter literal match', async () => {
    let prefixes = 0;
    const found = await findJapaneseSearch('toukyo', async (query) => ({
        dictionaryEntries: [{id: query === 'とうきょ' ? 2 : 1}],
        originalTextLength: query === 'とうきょ' ? query.length : 3,
    }), () => {}, async () => {
        prefixes++;
        return {dictionaryEntries: [{id: 3}]};
    });
    assert.equal(found.matchedQuery, 'とうきょ');
    assert.equal(found.matchType, 'exact');
    assert.equal(prefixes, 0);
});
test('shorter leading words remain available when completion misses', async () => {
    const leading = {dictionaryEntries: [{id: 1}], originalTextLength: 2};
    const found = await findJapaneseSearch('東京大学演', async () => leading, () => {}, async () => ({dictionaryEntries: []}));
    assert.equal(found.result, leading);
    assert.equal(found.matchType, 'exact');
});
test('English and unfinished romaji never trigger implicit prefix enumeration', async () => {
    for (const query of ['cat', 'hello world', 'ny']) {
        let prefixes = 0;
        const found = await findJapaneseSearch(query, async () => ({dictionaryEntries: []}), () => {}, async () => {
            prefixes++;
            return {dictionaryEntries: [{}]};
        });
        assert.equal(found.result, null, query);
        assert.equal(prefixes, 0, query);
    }
});
test('one Japanese character plus punctuation or emoji does not trigger prefix enumeration', async () => {
    for (const text of ['猫1', '猫🍵', 'あ!']) {
        let calls = 0;
        const match = await findJapaneseSearch(text, async () => ({dictionaryEntries: []}), () => {}, async () => {
            ++calls;
            return {dictionaryEntries: [{id: 1}]};
        });
        assert.equal(match.result, null, text);
        assert.equal(calls, 0, text);
    }
});
test('foreign Latin script in a mixed Japanese query never triggers implicit prefix enumeration', async () => {
    for (const query of ['食べé', 'たべñ', 'たべＸ']) {
        let prefixCalls = 0;
        const found = await findJapaneseSearch(query, async () => ({dictionaryEntries: []}), () => {}, async () => {
            prefixCalls++;
            return {dictionaryEntries: [{id: 1}]};
        });
        assert.equal(found.result, null, query);
        assert.equal(prefixCalls, 0, query);
    }
});
test('literal results preserve original dictionary entry identity and order', async () => {
    const result = {dictionaryEntries: [{id: 9}, {id: 3}]};
    const calls = [];
    const found = await findJapaneseSearch('shi', async (q) => {
        calls.push(q);
        return result;
    });
    assert.equal(found.result, result);
    assert.deepEqual(calls, ['shi']);
});
test('spelling alternatives do not replace the submitted query', async () => {
    const calls = [];
    const found = await findJapaneseSearch('ōkami', async (q) => {
        calls.push(q);
        return {dictionaryEntries: q === 'おおかみ' ? [{}] : []};
    });
    assert.equal(found.matchedQuery, 'おおかみ');
    assert.deepEqual(calls, ['ōkami', 'おうかみ', 'おおかみ']);
});
test('cancellation after lookup cannot publish an old result', async () => {
    const abort = new AbortController();
    const gate = Promise.withResolvers();
    const pending = findJapaneseSearch('shi', () => gate.promise, () => abort.signal.throwIfAborted());
    abort.abort();
    gate.resolve({dictionaryEntries: [{}]});
    await assert.rejects(pending, {name: 'AbortError'});
});
const definition = (dictionary, id, text, headwordIndices = [0]) => ({dictionary, id, entries: [text], tags: [{name: 'noun'}], headwordIndices});
const entry = (dictionary = 'A', id = 7) => ({headwords: [{index: 9, headwordIndex: 0, term: '猫', reading: 'ねこ'}], definitions: [definition(dictionary, id, 'cat')]});
test('preview counts and payload are bounded before structured cloning', () => {
    const original = entry();
    original.definitions[0].entries = ['x'.repeat(10000000)];
    const result = dictionaryPreview(new Array(100).fill(original));
    assert.equal(result.items.length, 2);
    assert.equal(result.hasMore, true);
    assert(JSON.stringify(result).length < 2500);
    assert.equal(original.definitions[0].entries[0].length, 10000000);
    assert.equal(result.items[0].senses[0].text.at(-1), '…');
});
test('dictionary-qualified identity and headword restriction survive preview', () => {
    const first = entry('A'),
        second = entry('B');
    first.definitions.unshift(definition('A', 8, 'wrong reading sense', [1]));
    const result = dictionaryPreview([first, second]);
    assert.notEqual(result.items[0].id, result.items[1].id);
    assert.equal(result.items[0].senses[0].text, 'cat');
});
test('structured previews omit URLs, styling, image bytes and ruby pronunciation duplication', () => {
    assert.equal(glossaryPreview({type: 'structured-content', content: [{tag: 'span', style: {color: 'private'}, content: 'cat'}, {tag: 'a', href: 'https://invalid.test/private', content: 'animal'}, {tag: 'rt', content: 'reading'}, {type: 'image', data: 'PRIVATE'}]}), 'cat animal');
    const cyclic = {content: null};
    cyclic.content = cyclic;
    assert.equal(glossaryPreview(cyclic), '');
});
test('preview clipping never emits a dangling high surrogate', () => {
    const text = glossaryPreview('a'.repeat(219) + '🐈more');
    assert(!/[\uD800-\uDBFF]…$/.test(text));
});
function controllerFixture() {
    const calls = [],
        input = {value: 'shi', selectionStart: 2, selectionEnd: 2};
    const controller = Object.create(SearchDisplayController.prototype);
    Object.assign(controller, {_queryInput: input,
        _liveSearchTimer: null,
        _composing: false,
        _wanakanaEnabled: false,
        _searchRequestSequence: 0,
        _updateSearchHeight() {},
        _updateSearchText() {
            throw new Error('live search must not rewrite the input');
        },
        _display: {depth: 0,
            application: {tabId: 1, frameId: 0},
            invalidateSearchDraft() {
                calls.push('invalidate');
            },
            setContent(details) {
                calls.push(details);
                return Promise.resolve();
            }}});
    return {controller, input, calls};
}
test('live input debounces, replaces history and preserves the caret', (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const oldWindow = globalThis.window,
        oldDocument = globalThis.document;
    globalThis.window = {location: {href: 'https://example.test'}};
    globalThis.document = {title: 'Search'};
    t.after(() => {
        globalThis.window = oldWindow;
        globalThis.document = oldDocument;
    });
    const {controller, input, calls} = controllerFixture();
    controller._onSearchInput({currentTarget: input, isComposing: false});
    input.value = 'shia';
    controller._onSearchInput({currentTarget: input, isComposing: false});
    t.mock.timers.tick(99);
    assert.equal(calls.filter((c) => typeof c === 'object').length, 0);
    t.mock.timers.tick(1);
    const detail = calls.at(-1);
    assert.equal(detail.params.query, 'shia');
    assert.equal(detail.historyMode, 'overwrite');
    assert.equal(detail.content.preserveSearchInput, true);
    assert.equal(detail.focus, false);
    assert.equal(input.selectionStart, 2);
});
test('IME input does not start an intermediate lookup', (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const {controller, input, calls} = controllerFixture();
    controller._composing = true;
    controller._onSearchInput({currentTarget: input, isComposing: true});
    t.mock.timers.tick(1000);
    assert.deepEqual(calls, []);
});
test('invalidation fences in-flight renders and disposes old entry actions', () => {
    const display = Object.create(Display.prototype);
    const old = {};
    let unloaded = 0,
        cleared = 0;
    Object.assign(display, {_setContentToken: old,
        _closePopups() {},
        _closeAllPopupMenus() {},
        _eventListeners: {removeAllEventListeners() {
            cleared++;
        }},
        _contentManager: {unloadAll() {
            unloaded++;
        }},
        _triggerContentClear() {},
        _dictionaryEntries: [1],
        _dictionaryEntryNodes: [1],
        _elementOverflowController: {clearElements() {}},
        _container: {textContent: 'old'},
        _setNoContentVisible() {},
        _setNoDictionariesVisible() {}});
    display.invalidateSearchDraft();
    assert.notEqual(display._setContentToken, old);
    assert.equal(unloaded, 1);
    assert.equal(cleared, 1);
    assert.deepEqual(display._dictionaryEntries, []);
    assert.equal(display._container.textContent, '');
});
