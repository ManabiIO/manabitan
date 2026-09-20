/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Display} from '../../ext/js/display/display.js';
import {SearchDisplayController} from '../../ext/js/display/search-display-controller.js';

// Exercise the actual searchLast, record-content loader, and content-start
// methods. Only browser history routing, options/lookup I/O and visual services
// are supplied by the harness. A fake searchLast must not manufacture clear events.
/**
 * @param {'terms'|'kanji'|'clear'|'unloaded'} [type]
 * @returns {{
 *   controller: SearchDisplayController,
 *   display: Display,
 *   input: {value: string, selectionStart: number, selectionEnd: number},
 *   optionsGate: PromiseWithResolvers<void>,
 *   lookupGate: PromiseWithResolvers<[]>,
 *   readonly renders: number,
 *   readonly blurs: number,
 *   readonly refreshes: number,
 *   rendered: () => Promise<void>,
 * }}
 */
function fixture(type = 'terms') {
    const display = Object.create(Display.prototype);
    const controller = Object.create(SearchDisplayController.prototype);
    /** @type {PromiseWithResolvers<void>} */
    const optionsGate = Promise.withResolvers();
    /** @type {PromiseWithResolvers<[]>} */
    const lookupGate = Promise.withResolvers();
    const input = {
        value: type === 'clear' ? '' : '猫',
        selectionStart: 1,
        selectionEnd: 1,
    };
    let renders = 0;
    let blurs = 0;
    let refreshes = 0;
    let contentPromise = Promise.resolve();

    Object.assign(controller, {
        _display: display,
        _queryInput: input,
        _searchBackButton: {hidden: true},
        _searchRequestSequence: 0,
        _contentUpdateQuery: input.value,
        _updateSearchHeight() {},
        _setIntroVisible() {},
    });
    Object.assign(display, {
        _eventMap: new Map(),
        _contentType: type,
        _query: input.value,
        _fullQuery: input.value,
        _queryOffset: 0,
        _primaryReading: '',
        _wildcardsEnabled: true,
        _lookup: true,
        _optionsContext: {},
        _setContentToken: {},
        _history: /** @type {any} */ ({
            state: {optionsContext: {}},
            content: {},
        }),
        _options: {dictionaries: [{enabled: true}]},
        _application: {webExtension: {unloaded: false}},
        _container: {textContent: ''},
        _windowScroll: {x: 0, y: 0},
        _contentManager: {
            async executeMediaRequests() {},
        },
        updateOptions: () => {
            ++refreshes;
            return optionsGate.promise;
        },
        _setOptionsContextIfDifferent: async () => {},
        _findDictionaryEntries: () => lookupGate.promise,
        /** @param {string} query */
        _setQuery(query) {
            this._query = query;
        },
        /**
         * @param {any} state
         * @param {any} content
         */
        _replaceHistoryStateNoNavigate(state, content) {
            this._history = {state, content};
        },
        _updateNavigationAuto() {},
        _setNoContentVisible() {},
        _setNoDictionariesVisible() {},
        blurElement() {
            ++blurs;
        },
        /**
         * @param {import('display').ContentDetails} details
         * @returns {Promise<void>}
         */
        setContent(details) {
            ++renders;
            this._history = {
                state: details.state,
                content: details.content,
            };
            const token = this._setContentToken = {};
            contentPromise = Display.prototype._setContentTermsOrKanji.call(
                display,
                /** @type {'terms'|'kanji'} */ (this._contentType),
                new URLSearchParams(/** @type {Record<string,string>} */ (details.params)),
                token,
            );
            return contentPromise;
        },
    });
    display.on(
        'contentUpdateStart',
        /** @param {import('display').EventArgument<'contentUpdateStart'>} details */
        (details) => controller._onContentUpdateStart(details),
    );

    return {
        controller,
        display,
        input,
        optionsGate,
        lookupGate,
        get renders() {
            return renders;
        },
        get blurs() {
            return blurs;
        },
        get refreshes() {
            return refreshes;
        },
        async rendered() {
            await contentPromise;
        },
    };
}

const refreshMethods = /** @type {const} */ (['_refreshAfterOptionsUpdate', '_refreshAfterDictionaryDatabaseUpdate']);
for (const method of refreshMethods) {
    test(`${method}: real searchLast leaves a clear page draft alone (baseline control)`, async () => {
        const f = fixture('clear');
        const refresh = f.controller[method]();
        f.input.value = '読め';
        f.optionsGate.resolve();
        await refresh;
        assert.equal(f.renders, 0);
        assert.equal(f.input.value, '読め');
    });

    for (const draft of ['読め', '', '  two words  ']) {
        test(`${method}: refresh visible results without replacing draft ${JSON.stringify(draft)}`, async () => {
            const f = fixture();
            const refresh = f.controller[method]();
            f.input.value = draft;
            f.input.selectionStart = f.input.selectionEnd = Math.min(1, draft.length);
            f.optionsGate.resolve();
            await refresh;
            assert.equal(f.renders, 1, 'visible results must still be refreshed');
            f.lookupGate.resolve([]);
            await f.rendered();
            assert.equal(f.input.value, draft);
            assert.equal(f.input.selectionStart, Math.min(1, draft.length));
            assert.equal(f.blurs, 0, 'automatic refresh must not interrupt typing/IME');
        });
    }

    test(`${method}: edits during the actual dictionary lookup also survive`, async () => {
        const f = fixture();
        f.optionsGate.resolve();
        await f.controller[method]();
        await Promise.resolve();
        f.input.value = 'typed after refresh started';
        f.lookupGate.resolve([]);
        await f.rendered();
        assert.equal(f.input.value, 'typed after refresh started');
        assert.equal(f.renders, 1);
    });

    test(`${method}: unloaded pages do not request options or rerun`, async () => {
        const f = fixture('unloaded');
        f.optionsGate.resolve();
        f.lookupGate.resolve([]);
        await f.controller[method]();
        await f.rendered();
        assert.equal(f.refreshes, 0);
        assert.equal(f.renders, 0);
    });

    test(`${method}: unload during the options wait does not launch another search`, async () => {
        const f = fixture();
        const refresh = f.controller[method]();
        f.display._contentType = 'unloaded';
        f.optionsGate.resolve();
        f.lookupGate.resolve([]);
        await refresh;
        await f.rendered();
        assert.equal(f.renders, 0);
    });
}

test('the preservation marker is consumed before lookup and does not suppress later navigation', async () => {
    const f = fixture();
    f.optionsGate.resolve();
    await f.controller._refreshAfterDictionaryDatabaseUpdate();
    const historyContent = f.display._history.content;
    assert.ok(historyContent);
    assert.equal(Object.hasOwn(historyContent, 'preserveSearchInput'), false);
    f.input.value = 'draft';
    f.lookupGate.resolve([]);
    await f.rendered();
    assert.equal(f.input.value, 'draft');

    // A later ordinary refresh/navigation uses the original input-sync behavior.
    f.display.searchLast(false);
    await f.rendered();
    assert.equal(f.input.value, '猫');
    assert.equal(f.blurs, 1);
});

test('explicit navigation to another query still synchronizes the input', async () => {
    const f = fixture();
    f.input.value = 'draft';
    f.controller._onContentUpdateStart({type: 'terms', query: '犬'});
    assert.equal(f.input.value, '犬');
});

test('explicit clear content still clears the input', () => {
    const f = fixture();
    f.input.value = 'draft';
    f.controller._onContentUpdateStart({type: 'clear', query: ''});
    assert.equal(f.input.value, '');
});
