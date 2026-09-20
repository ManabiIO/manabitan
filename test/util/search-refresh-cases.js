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

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Display} from '../../ext/js/display/display.js';
import {SearchDisplayController} from '../../ext/js/display/search-display-controller.js';

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    let resolve = () => {};
    /** @type {Promise<void>} */
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

/**
 * Actual searchLast, record-render preparation and content-update handler;
 * options/lookup and layout are controlled boundaries, not native storage.
 * @param {import('display').PageType} [type]
 */
function createFixture(type = 'terms') {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const controller = /** @type {SearchDisplayController} */ (Object.create(SearchDisplayController.prototype));
    const input = {value: '猫', selectionStart: 1, selectionEnd: 1, scrollTop: 27, focused: true};
    const optionsContext = {depth: 0, url: 'https://example.test/search'};
    const history = {state: {optionsContext}, content: /** @type {import('display').HistoryContent} */ ({})};
    const state = {updates: 0, starts: 0, blurs: 0, lookups: 0, layoutWrites: 0};
    let pending = Promise.resolve();
    const assign = (/** @type {object} */ object, /** @type {Record<string, unknown>} */ fields) => {
        for (const [key, value] of Object.entries(fields)) { Reflect.set(object, key, value); }
    };
    assign(display, {
        _pageType: 'search', _contentType: type, _query: '猫', _fullQuery: '猫',
        _queryOffset: 0, _primaryReading: 'ねこ', _wildcardsEnabled: false, _lookup: true,
        _optionsContext: optionsContext, _history: history,
        _options: {dictionaries: [{enabled: true}]}, _setContentToken: {},
        _application: {webExtension: {unloaded: false}}, _container: {textContent: ''},
        _windowScroll: {stop() {}, to() {}}, _contentManager: {executeMediaRequests: async () => {}},
        updateOptions: async () => { ++state.updates; },
        _setOptionsContextIfDifferent: async () => {},
        _findDictionaryEntries: async () => {
            ++state.lookups;
            return [];
        },
        _updateQueryParser() {}, _setTitleText() {}, _updateNavigationAuto() {},
        _setNoContentVisible() {}, _setNoDictionariesVisible() {},
        getContentOrigin: () => ({tabId: 1, frameId: 1}),
        blurElement: () => {
            ++state.blurs;
            input.focused = false;
        },
        _replaceHistoryStateNoNavigate: (/** @type {typeof history.state} */ nextState, /** @type {typeof history.content} */ nextContent) => {
            history.state = nextState;
            history.content = nextContent;
        },
        trigger: (/** @type {string} */ name, /** @type {unknown} */ details) => {
            if (name !== 'contentUpdateStart') { return; }
            ++state.starts;
            controller._onContentUpdateStart(/** @type {import('display').EventArgument<'contentUpdateStart'>} */ (details));
        },
        setContent: (/** @type {import('display').ContentDetails} */ details) => {
            history.state = /** @type {typeof history.state} */ (details.state);
            history.content = /** @type {typeof history.content} */ (details.content);
            const token = {};
            Reflect.set(display, '_setContentToken', token);
            const params = new URLSearchParams(/** @type {Record<string, string>} */ (details.params));
            pending = display._setContentTermsOrKanji(type, params, token);
            return pending;
        },
    });
    assign(controller, {
        _display: display, _queryInput: input, _searchBackButton: {hidden: true},
        _searchRequestSequence: 0, _contentUpdateSequence: 0, _contentUpdateQuery: '',
        _setIntroVisible() {}, _updateSearchHeight: () => { ++state.layoutWrites; },
    });
    return {display, controller, input, state, history, settled: () => pending};
}

for (const method of ['_refreshAfterOptionsUpdate', '_refreshAfterDictionaryDatabaseUpdate']) {
    for (const type of ['terms', 'kanji']) {
        for (const draft of ['読め', '', 'new draft  ']) {
            test(`${method}: ${type} refresh preserves preexisting draft ${JSON.stringify(draft)}`, async () => {
                const f = createFixture(/** @type {import('display').PageType} */ (type));
                f.input.value = draft;
                await Reflect.get(f.controller, method).call(f.controller);
                await f.settled();
                assert.equal(f.state.lookups, 1, 'visible results still refresh');
                assert.equal(f.state.starts, 1);
                assert.equal(f.input.value, draft);
                assert.equal(f.input.focused, true);
                assert.equal(f.state.blurs, 0);
                assert.equal(f.state.layoutWrites, 0);
                assert.equal(f.input.scrollTop, 27);
            });
        }
    }
    test(`${method}: edits made while options load survive the rerender`, async () => {
        const f = createFixture();
        const gate = deferred();
        Reflect.set(f.display, 'updateOptions', () => gate.promise);
        const refresh = Reflect.get(f.controller, method).call(f.controller);
        f.input.value = '読め';
        f.input.selectionStart = 0;
        f.input.selectionEnd = 2;
        gate.resolve();
        await refresh;
        await f.settled();
        assert.equal(f.state.starts, 1);
        assert.equal(f.input.value, '読め');
        assert.equal(f.input.selectionStart, 0);
        assert.equal(f.input.selectionEnd, 2);
        assert.equal(f.input.focused, true);
    });
    test(`${method}: edits made after refresh dispatch survive a delayed lookup`, async () => {
        const f = createFixture();
        const gate = deferred();
        const entered = deferred();
        Reflect.set(f.display, '_findDictionaryEntries', async () => {
            entered.resolve();
            await gate.promise;
            return [];
        });
        await Reflect.get(f.controller, method).call(f.controller);
        await entered.promise;
        f.input.value = 'typing while lookup is pending';
        gate.resolve();
        await f.settled();
        assert.equal(f.state.starts, 1);
        assert.equal(f.input.value, 'typing while lookup is pending');
        assert.equal(f.input.focused, true);
    });
}

test('clear-page control uses the real searchLast and does not invent a content update', async () => {
    const f = createFixture('clear');
    f.input.value = '読め';
    await f.controller._refreshAfterDictionaryDatabaseUpdate();
    await f.settled();
    assert.equal(f.state.starts, 0);
    assert.equal(f.state.lookups, 0);
    assert.equal(f.input.value, '読め');
});

test('explicit search-last action restores the query rather than preserving a draft', async () => {
    const f = createFixture();
    f.input.value = 'draft';
    f.display.searchLast(true);
    await f.settled();
    assert.equal(f.input.value, '猫');
    assert.equal(f.state.blurs, 1);
});

test('ordinary content navigation still replaces the search input', () => {
    const f = createFixture();
    f.input.value = 'draft';
    f.controller._onContentUpdateStart({type: 'kanji', query: '犬'});
    assert.equal(f.input.value, '犬');
    assert.equal(f.state.blurs, 1);
});

test('explicit clear still clears the input', () => {
    const f = createFixture();
    f.input.value = 'draft';
    f.controller._onContentUpdateStart({type: 'clear', query: ''});
    assert.equal(f.input.value, '');
});

test('refresh marker is consumed before lookup so revisiting history synchronizes the input', async () => {
    const f = createFixture();
    f.input.value = 'draft';
    f.display.searchLast(false);
    await f.settled();
    assert.equal(f.input.value, 'draft');
    assert.equal(Object.hasOwn(f.history.content, 'preserveSearchInput'), false);
    const token = {};
    Reflect.set(f.display, '_setContentToken', token);
    await f.display._setContentTermsOrKanji('terms', new URLSearchParams({query: '猫'}), token);
    assert.equal(f.input.value, '猫');
});

test('popup refresh does not request preservation of search-page input', async () => {
    const f = createFixture();
    Reflect.set(f.display, '_pageType', 'popup');
    f.input.value = 'draft';
    f.display.searchLast(false);
    await f.settled();
    assert.equal(f.input.value, '猫');
});

test('an unloaded display never starts a last-query refresh', async () => {
    const f = createFixture('unloaded');
    f.input.value = 'draft';
    f.display.searchLast(false);
    await f.settled();
    assert.equal(f.state.starts, 0);
    assert.equal(f.input.value, 'draft');
});
