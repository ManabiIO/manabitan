/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {Display} from '../ext/js/display/display.js';
import {QueryParser} from '../ext/js/display/query-parser.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {{parser: QueryParser, api: {parseText: import('vitest').Mock<() => Promise<import('api').ParseTextResultItem[]>>, modifySettings: import('vitest').Mock}, report: import('vitest').MockInstance<typeof log.error>}}
 */
function setup(window) {
    window.document.body.innerHTML = '<div id="query-parser-content"></div><div id="query-parser-mode-container"><select id="query-parser-mode-select"></select></div>';
    const api = {
        parseText: vi.fn(/** @returns {Promise<import('api').ParseTextResultItem[]>} */ async () => []),
        modifySettings: vi.fn().mockResolvedValue([{result: true}]),
    };
    const parser = new QueryParser(
        /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)),
        /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({})),
        () => ({optionsContext: {depth: 0, url: 'https://example.test'}, detail: {documentTitle: 'Test'}}),
    );
    parser.setOptions(options());
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    return {parser, api, report};
}

/**
 * @param {string} text
 * @returns {import('api').ParseTextResultItem[]}
 */
function results(text) {
    return [
        {id: 'scanner', source: 'scanning-parser', dictionary: null, index: 0, content: [[{text, reading: ''}]]},
        {id: 'mecab', source: 'mecab', dictionary: 'IPADIC', index: 1, content: [[{text: `${text}-mecab`, reading: ''}]]},
    ];
}

/**
 * @param {Partial<import('display').QueryParserOptions>} [overrides]
 * @returns {import('display').QueryParserOptions}
 */
function options(overrides = {}) {
    return {
        selectedParser: 'scanner',
        termSpacing: false,
        readingMode: 'none',
        useInternalParser: true,
        useMecabParser: false,
        useAllFrequencyDictionaries: false,
        language: 'ja',
        scanning: /** @type {import('text-scanner').Options} */ (/** @type {unknown} */ (null)),
        ...overrides,
    };
}

test('late parse responses cannot overwrite the latest cached results or later parser switching', async ({window}) => {
    const {parser, api} = setup(window);
    const old = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(old.promise).mockResolvedValueOnce(results('new'));
    const older = parser.setText('old');
    await parser.setText('new');
    old.resolve(results('old'));
    await older;
    expect(parser._parseResults).toStrictEqual(results('new'));
    parser.setOptions(options({selectedParser: 'mecab'}));
    expect(parser._queryParser.textContent).toBe('new-mecab');
});

test('a new preview cannot resurrect old results through a parser-options change', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce(results('old'));
    await parser.setText('old');
    const pending = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(pending.promise);
    const request = parser.setText('new');
    parser.setOptions(options({selectedParser: 'mecab'}));
    expect(parser._queryParser.textContent).toBe('new');
    expect(parser._queryParser.dataset.parsed).toBe('false');
    expect(parser._queryParserModeContainer.hidden).toBe(true);
    pending.resolve(results('new'));
    await request;
    expect(parser._queryParser.textContent).toBe('new-mecab');
});

test('a disabled new-text request invalidates an earlier pending parse', async ({window}) => {
    const {parser, api} = setup(window);
    const pending = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(pending.promise);
    const request = parser.setText('old');
    parser.setOptions(options({useInternalParser: false, useMecabParser: false}));
    await parser.setText('new');
    pending.resolve(results('old'));
    await request;
    expect(parser.text).toBe('new');
    expect(parser._queryParser.textContent).toBe('new');
    expect(parser._queryParser.dataset.parsed).toBe('false');
    expect(parser._parseResults).toStrictEqual([]);
    expect(api.parseText).toHaveBeenCalledTimes(1);
});

test('disabling both parsers while a parse is pending keeps the current preview unparsed', async ({window}) => {
    const {parser, api} = setup(window);
    const pending = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(pending.promise);
    const request = parser.setText('current');
    parser.setOptions(options({useInternalParser: false, useMecabParser: false}));
    pending.resolve(results('current'));
    await request;
    expect(parser._parseResults).toStrictEqual([]);
    expect(parser._queryParser.dataset.parsed).toBe('false');
    expect(parser._queryParser.textContent).toBe('current');
});

test('stale parse rejection is ignored without poisoning the newer successful result', async ({window}) => {
    const {parser, api} = setup(window);
    const pending = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(results('new'));
    const request = parser.setText('old');
    const observed = request.then(() => null, (error) => error);
    await parser.setText('new');
    pending.reject(new Error('Old parser failed'));
    expect(await observed).toBeNull();
    expect(parser._parseResults).toStrictEqual(results('new'));
});

test('default parser selection renders immediately without waiting for persisted settings', async ({window}) => {
    const {parser, api} = setup(window);
    parser._selectedParser = null;
    api.parseText.mockResolvedValueOnce(results('current'));
    await parser.setText('current');
    expect(parser._selectedParser).toBe('scanner');
    expect(parser._queryParser.textContent).toBe('current');
    expect(api.modifySettings).toHaveBeenCalledTimes(1);
});

test('a parser-select change updates content locally before settings acknowledgement', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce(results('current'));
    await parser.setText('current');
    parser._queryParserModeSelect.value = 'mecab';
    parser._onParserChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: parser._queryParserModeSelect})));
    expect(parser._selectedParser).toBe('mecab');
    expect(parser._queryParser.textContent).toBe('current-mecab');
});

test('parser settings failure is handled and does not erase locally usable content', async ({window}) => {
    const {parser, api, report} = setup(window);
    const pending = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
    void pending.promise.catch(() => {});
    api.modifySettings.mockReturnValueOnce(pending.promise);
    const request = parser._setSelectedParser('mecab');
    const error = new Error('Settings unavailable');
    pending.reject(error);
    await request;
    await Promise.resolve();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(parser._selectedParser).toBe('mecab');
});

test('resolved per-setting errors are reported rather than silently claiming persistence', async ({window}) => {
    const {parser, api, report} = setup(window);
    api.modifySettings.mockResolvedValueOnce([{error: {name: 'Error', message: 'Invalid profile'}}]);
    await parser._setSelectedParser('mecab');
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'Invalid profile'}));
});

test('failed parsing clears old result choices and permits a later explicit retry', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce(results('old'));
    await parser.setText('old');
    api.parseText.mockRejectedValueOnce(new Error('Parse unavailable'));
    await expect(parser.setText('new')).rejects.toThrow('Parse unavailable');
    expect(parser._parseResults).toStrictEqual([]);
    expect(parser._queryParserModeContainer.hidden).toBe(true);
    expect(parser.needsTextUpdate).toBe(true);
    api.parseText.mockResolvedValueOnce(results('new'));
    await parser.setText('new');
    expect(parser.needsTextUpdate).toBe(false);
    expect(parser._queryParser.textContent).toBe('new');
});

test('display contains parser failures, releases progress and retries identical text on the next update', async ({window}) => {
    const {parser, api} = setup(window);
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const report = vi.fn();
    const clear = vi.fn();
    for (const [name, value] of Object.entries({
        _queryParser: parser,
        _progressIndicatorVisible: {setOverride: () => 'progress', clearOverride: clear},
        _fullQuery: 'same',
        _queryParserContainer: window.document.createElement('div'),
        _isQueryParserVisible: () => true,
        onError: report,
    })) { Reflect.set(display, name, value); }
    const error = new Error('Temporary parser failure');
    api.parseText.mockRejectedValueOnce(error);
    await expect(display._setQueryParserText('same')).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(clear).toHaveBeenCalledExactlyOnceWith('progress');
    api.parseText.mockResolvedValueOnce(results('same'));
    const update = vi.spyOn(display, '_setQueryParserText');
    display._updateQueryParser();
    expect(update).toHaveBeenCalledExactlyOnceWith('same');
    await update.mock.results[0].value;
    expect(parser._queryParser.textContent).toBe('same');
    expect(parser.needsTextUpdate).toBe(false);
});

test('ordinary empty parse results remain stable and do not request endless retries', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce([]);
    await parser.setText('unknown');
    expect(Boolean(parser.needsTextUpdate)).toBe(false);
    expect(parser._parseResults).toStrictEqual([]);
    expect(parser._queryParser.textContent).toBe('unknown');
    expect(parser._queryParser.dataset.parsed).toBe('false');
});

test('changed parsing inputs invalidate pending results and allow a same-text refresh', async ({window}) => {
    const {parser, api} = setup(window);
    const pending = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(pending.promise);
    const request = parser.setText('same');
    parser.setOptions(options({useInternalParser: false, useMecabParser: true}));
    pending.resolve(results('outdated'));
    await request;
    expect(parser._queryParser.textContent).toBe('same');
    expect(parser.needsTextUpdate).toBe(true);
    api.parseText.mockResolvedValueOnce(results('fresh'));
    await parser.setText('same');
    expect(api.parseText.mock.calls[1].slice(3, 5)).toStrictEqual([false, true]);
    expect(parser.needsTextUpdate).toBe(false);
    expect(parser._queryParser.textContent).toBe('fresh');
});

test('unchanged options do not invalidate a healthy pending parse', async ({window}) => {
    const {parser, api} = setup(window);
    const pending = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(pending.promise);
    const request = parser.setText('same');
    parser.setOptions(options());
    pending.resolve(results('same'));
    await request;
    expect(parser._queryParser.textContent).toBe('same');
    expect(parser._queryParser.dataset.parsed).toBe('true');
    expect(parser._parseResults).toStrictEqual(results('same'));
});

test('reenabling parsing requests a same-text refresh rather than retaining disabled state', async ({window}) => {
    const {parser, api} = setup(window);
    parser.setOptions(options({useInternalParser: false, useMecabParser: false}));
    await parser.setText('same');
    expect(api.parseText).not.toHaveBeenCalled();
    parser.setOptions(options());
    expect(parser.needsTextUpdate).toBe(true);
    api.parseText.mockResolvedValueOnce(results('same'));
    await parser.setText('same');
    expect(parser.needsTextUpdate).toBe(false);
    expect(parser._queryParser.dataset.parsed).toBe('true');
});

test('an unavailable selected parser uses the current default without blanking the query', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce(results('same'));
    await parser.setText('same');
    parser.setOptions(options({selectedParser: 'no-longer-installed'}));
    expect(parser._selectedParser).toBe('scanner');
    expect(parser._queryParser.textContent).toBe('same');
    expect(api.modifySettings).not.toHaveBeenCalled();
});

test('repeated unavailable-parser settings notifications cannot create a settings-write feedback loop', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce(results('same'));
    await parser.setText('same');
    api.modifySettings.mockResolvedValue([{error: {name: 'Error', message: 'Settings unavailable'}}]);
    for (let i = 0; i < 5; ++i) {
        parser.setOptions(options({selectedParser: 'no-longer-installed'}));
        await Promise.resolve();
        expect(parser._selectedParser).toBe('scanner');
        expect(parser._queryParser.textContent).toBe('same');
        expect(parser._queryParser.dataset.parsed).toBe('true');
    }
    expect(api.modifySettings).not.toHaveBeenCalled();
});

test('display progress cleanup survives a throwing parser error reporter', async ({window}) => {
    const {parser, api} = setup(window);
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const clear = vi.fn();
    Reflect.set(display, '_queryParser', parser);
    Reflect.set(display, '_progressIndicatorVisible', {setOverride: () => 'progress', clearOverride: clear});
    Reflect.set(display, 'onError', () => { throw new Error('Reporting failed'); });
    api.parseText.mockRejectedValueOnce(new Error('Parser failed'));
    await expect(display._setQueryParserText('same')).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledExactlyOnceWith('progress');
    expect(parser.needsTextUpdate).toBe(true);
});

test('synchronous parser transport failure remains retryable', async ({window}) => {
    const {parser, api} = setup(window);
    const error = new Error('Parser transport failed synchronously');
    api.parseText.mockImplementationOnce(() => { throw error; });
    await expect(parser.setText('same')).rejects.toBe(error);
    expect(parser.needsTextUpdate).toBe(true);
    api.parseText.mockResolvedValueOnce(results('same'));
    await parser.setText('same');
    expect(parser.needsTextUpdate).toBe(false);
});

test('a rendering failure clears unusable cached results and allows a same-text retry', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValue(results('same'));
    const render = vi.spyOn(parser, '_renderParseResult');
    const error = new Error('Parser rendering failed');
    render.mockImplementationOnce(() => {
        parser._queryParser.textContent = '';
        throw error;
    });
    await expect(parser.setText('same')).rejects.toBe(error);
    expect(parser._parseResults).toStrictEqual([]);
    expect(parser.needsTextUpdate).toBe(true);
    expect(parser._queryParser.textContent).toBe('same');
    await parser.setText('same');
    expect(parser.needsTextUpdate).toBe(false);
    expect(parser._queryParser.textContent).toBe('same');
});
