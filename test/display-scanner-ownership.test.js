/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {Display} from '../ext/js/display/display.js';
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');
afterEach(() => { vi.restoreAllMocks(); });

/** @type {import('api').ApiReturn<'termsFind'>} */
const hit = {
    dictionaryEntries: [
        /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({type: 'term', definitions: []})),
    ],
    originalTextLength: 1,
};

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {'definitions'|'parser'} source
 * @returns {Promise<{display: Display, parser: import('../ext/js/display/query-parser.js').QueryParser, scanner: import('../ext/js/language/text-scanner.js').TextScanner, api: {termsFind: import('vitest').Mock, parseText: import('vitest').Mock}, publication: import('vitest').MockInstance<Display['setContent']>, report: import('vitest').MockInstance<typeof log.error>, scan: () => Promise<void>, close: () => void}>}
 */
async function setup(window, source) {
    const api = {
        termsFind: vi.fn().mockResolvedValue(hit),
        parseText: vi.fn().mockResolvedValue([]),
    };
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api, tabId: 1, frameId: 0, triggerClosePopups: vi.fn(), webExtension: {unloaded: false},
    }));
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler());
    const parser = display._queryParser;
    parser.prepare();
    parser.on('searched', display._onQueryParserSearch.bind(display));
    await parser.setText('old');
    Reflect.set(display, '_fullQuery', 'old');
    display.queryParserVisible = true;
    display._container.innerHTML = '<span class="click-scannable">old</span>';
    display._updateContentTextScanner(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        scanning: {enablePopupSearch: true, enableOnSearchPage: true, length: 20, delay: 0},
    })));
    const scanner = source === 'definitions' ? display._contentTextScanner : parser._textScanner;
    if (scanner === null) { throw new Error('Missing scanner'); }
    scanner.setOptions({scanLength: 20});
    scanner.setEnabled(true);
    Reflect.set(scanner, '_textSourceGenerator', {
        getRangeFromPoint: () => {
            const container = source === 'definitions' ? display._container : parser._queryParser;
            const node = container.querySelector(source === 'definitions' ? '.click-scannable' : '.query-parser-term')?.firstChild;
            if (!node) { throw new Error('Missing scan text'); }
            const range = window.document.createRange();
            range.selectNodeContents(node);
            return TextSourceRange.create(range);
        },
        extractSentence: () => ({text: 'old', offset: 0}),
    });
    const publication = vi.spyOn(display, 'setContent').mockResolvedValue(true);
    vi.spyOn(display, '_setContentTermsOrKanji').mockResolvedValue(void 0);
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    const scan = () => scanner._searchAt(1, 1, {
        input: null, pointerType: 'mouse', eventType: 'click', passive: false, modifiers: [], modifierKeys: [], detail: null,
    });
    const close = () => {
        display._contentTextScanner?.setEnabled(false);
        parser._textScanner.setEnabled(false);
    };
    return {display, parser, scanner, api, publication, report, scan, close};
}

/**
 * @param {Display} display
 * @param {string} boundary
 */
async function invalidate(display, boundary) {
    switch (boundary) {
        case 'draft': display.invalidateSearchDraft(); break;
        case 'navigation':
            history.replaceState(null, '', '?type=terms&query=new');
            await display._onStateChanged();
            break;
        case 'hidden': display.queryParserVisible = false; break;
        case 'frame-hidden': display._onMessageVisibilityChanged({value: false}); break;
    }
}

for (const source of /** @type {const} */ (['definitions', 'parser'])) {
    test.for([0, 1, 2])(`${source} primary pointer press discards pending clicks without disabling later scans (button=%s)`, async (button, {window}) => {
        const {scanner, api, publication, report, scan, close} = await setup(window, source);
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        api.termsFind.mockReturnValueOnce(pending.promise);
        const older = scan();
        try {
            window.document.documentElement.dispatchEvent(new window.MouseEvent('pointerdown', {button, bubbles: true}));
            if (button === 0) {
                expect(Reflect.get(scanner, '_pendingLookup')).toBe(false);
                await scan();
                expect(api.termsFind).toHaveBeenCalledTimes(2);
                expect(publication).toHaveBeenCalledOnce();
            }
            pending.resolve(hit);
            await older;
            expect(publication).toHaveBeenCalledOnce();
            expect(report).not.toHaveBeenCalled();
        } finally {
            close();
            pending.resolve(hit);
            await older;
        }
    });

    for (const boundary of source === 'definitions' ? ['draft', 'navigation', 'frame-hidden'] : ['draft', 'navigation', 'hidden', 'frame-hidden']) {
        test.for([false, true])(`${source} lookup cannot publish after ${boundary} (rejection=%s)`, async (reject, {window}) => {
            const {display, api, publication, report, scan, close} = await setup(window, source);
            const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
            api.termsFind.mockReturnValueOnce(pending.promise);
            const older = scan();
            try {
                expect(api.termsFind).toHaveBeenCalledOnce();
                await invalidate(display, boundary);
                if (reject) {
                    pending.reject(new Error('Obsolete lookup failed'));
                } else {
                    pending.resolve(hit);
                }
                await older;
                expect(publication).not.toHaveBeenCalled();
                expect(report).not.toHaveBeenCalled();
            } finally {
                close();
                pending.resolve(hit);
                await older;
            }
        });
    }

    test.for(['draft', 'frame-hidden'])(`${source} fresh lookup need not wait for an obsolete reader after %s`, async (boundary, {window}) => {
        const {display, scanner, api, publication, report, scan, close} = await setup(window, source);
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        api.termsFind.mockReturnValueOnce(pending.promise);
        const older = scan();
        try {
            await invalidate(display, boundary);
            if (boundary === 'frame-hidden') { display._onMessageVisibilityChanged({value: true}); }
            display._container.innerHTML = '<span class="click-scannable">new</span>';
            await scan();
            expect(api.termsFind).toHaveBeenCalledTimes(2);
            expect(publication).toHaveBeenCalledOnce();
            const currentSource = scanner.getCurrentTextSource();
            pending.resolve(hit);
            await older;
            expect(publication).toHaveBeenCalledOnce();
            expect(scanner.getCurrentTextSource()).toBe(currentSource);
            expect(report).not.toHaveBeenCalled();
        } finally {
            close();
            pending.resolve(hit);
            await older;
        }
    });
}

test('parser navigation retains its selected source and suppresses repeated same-word lookups', async ({window}) => {
    const {display, scanner, api, publication, scan, close} = await setup(window, 'parser');
    try {
        await scan();
        expect(publication).toHaveBeenCalledOnce();
        const selected = scanner.getCurrentTextSource();
        expect(selected?.text()).toBe('o');
        await invalidate(display, 'navigation');
        expect(scanner.getCurrentTextSource()).toBe(selected);
        await scan();
        expect(api.termsFind).toHaveBeenCalledOnce();
        expect(publication).toHaveBeenCalledOnce();
    } finally {
        close();
    }
});

test('history metadata updates do not cancel an otherwise current lookup', async ({window}) => {
    const {display, api, publication, scan, close} = await setup(window, 'definitions');
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    api.termsFind.mockReturnValueOnce(pending.promise);
    const older = scan();
    try {
        display._historyChangeIgnore = true;
        await display._onStateChanged();
        display._historyChangeIgnore = false;
        pending.resolve(hit);
        await older;
        expect(publication).toHaveBeenCalledOnce();
    } finally {
        close();
        pending.resolve(hit);
        await older;
    }
});
