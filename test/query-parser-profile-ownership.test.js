/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {afterEach, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {log} from '../ext/js/core/log.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {Display} from '../ext/js/display/display.js';
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {string} [id]
 * @param {string} [text]
 * @returns {import('api').ParseTextResultItem}
 */
function parseResult(id = 'scan', text = '猫') {
    return {id, source: 'scanning-parser', dictionary: null, index: 0, content: [[{text, reading: ''}]]};
}

/**
 * @param {import('settings').OptionsContext} [context]
 * @returns {Promise<{
 *   backend: Backend,
 *   display: Display,
 *   parser: import('../ext/js/display/query-parser.js').QueryParser,
 *   api: {parseText: import('vitest').Mock<() => Promise<import('api').ParseTextResultItem[]>>, modifySettings: import('vitest').Mock},
 *   save: import('vitest').MockInstance<OptionsUtil['save']>,
 *   report: import('vitest').MockInstance<typeof log.error>,
 *   selection: import('vitest').MockInstance<import('../ext/js/display/query-parser.js').QueryParser['_setSelectedParser']>,
 *   state: {delayResponse: boolean},
 *   responseReady: PromiseWithResolvers<void>,
 *   responseGate: PromiseWithResolvers<void>,
 *   values: () => Record<string, string|null>,
 *   close: () => void,
 * }>}
 */
async function setup(context) {
    if (typeof context === 'undefined') { context = {current: true}; }
    const optionsUtil = new OptionsUtil();
    optionsUtil._optionsSchema = new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8')));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].options.parsing.selectedParser = 'scan';
    options.profiles[0].options.parsing.enableMecabParser = true;
    options.profiles.push({...structuredClone(options.profiles[0]), id: 'profile-b', name: 'B'});
    const save = vi.spyOn(optionsUtil, 'save').mockResolvedValue();
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {
        _options: options,
        _optionsUtil: optionsUtil,
        _applyOptions: vi.fn(),
        _profileConditionsSchemaCache: [],
    }));
    const responseGate = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const responseReady = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const state = {delayResponse: false};
    const api = {
        optionsGetProfile: async (/** @type {import('settings').OptionsContext} */ optionsContext) => structuredClone(backend._onApiOptionsGetProfile({optionsContext}, {})),
        parseText: vi.fn(/** @returns {Promise<import('api').ParseTextResultItem[]>} */ async () => [parseResult(), {...parseResult('mecab', 'ネコ'), source: 'mecab', dictionary: 'IPADIC'}]),
        modifySettings: vi.fn(async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => {
            const result = await backend._modifySettings(targets, source);
            responseReady.resolve();
            if (state.delayResponse) { await responseGate.promise; }
            return result;
        }),
    };
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api, tabId: 1, frameId: 0}));
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler());
    vi.spyOn(display, '_setTheme').mockImplementation(() => {});
    vi.spyOn(display, '_updateNestedFrontend').mockResolvedValue();
    vi.spyOn(display, '_updateContentTextScanner').mockImplementation(() => {});
    display._optionsContext = context;
    const parser = display._queryParser;
    parser.prepare();
    await display.updateOptions();
    await parser.setText('猫');
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    const selection = vi.spyOn(parser, '_setSelectedParser');
    const values = () => Object.fromEntries(backend._getOptionsFull(false).profiles.map(({id, options: profile}) => [id, profile.parsing.selectedParser]));
    return {backend, display, parser, api, save, report, selection, state, responseReady, responseGate, values, close: () => parser._textScanner.setEnabled(false)};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {Awaited<ReturnType<typeof setup>>} fixture
 * @returns {Promise<void>}
 */
function chooseMecab(window, fixture) {
    const select = fixture.parser._queryParserModeSelect;
    expect(select.closest('#query-parser-mode-container')?.hasAttribute('hidden')).toBe(false);
    select.value = 'mecab';
    select.dispatchEvent(new window.Event('change', {bubbles: true}));
    expect(fixture.parser._queryParser.textContent).toBe('ネコ');
    const result = fixture.selection.mock.results.at(-1);
    if (typeof result === 'undefined') { throw new Error('Parser change was not handled'); }
    return result.value;
}

test.for(['default switch', 'profile reorder', 'profile deletion'])('parser selection stays with its displayed profile across a queued %s', async (change, {window}) => {
    const fixture = await setup(change === 'profile reorder' ? {index: 0} : {current: true});
    const saveStarted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const releaseSave = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    fixture.save.mockImplementationOnce(async () => {
        saveStarted.resolve();
        await releaseSave.promise;
    });
    /** @type {import('settings-modifications').ScopedModification} */
    const mutation = change === 'profile reorder' ?
        {action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b', scope: 'global', optionsContext: null} :
        (change === 'profile deletion' ?
            {action: 'deleteProfile', profileId: 'profile-a', scope: 'global', optionsContext: null} :
            {action: 'setDefaultProfile', profileId: 'profile-b', scope: 'global', optionsContext: null});
    const changing = fixture.backend._modifySettings([mutation], 'other settings page');
    await saveStarted.promise;
    const selecting = chooseMecab(window, fixture);
    releaseSave.resolve();
    try {
        await changing;
        await selecting;
        if (change === 'profile deletion') {
            expect(fixture.values()).toEqual({'profile-b': 'scan'});
            expect(fixture.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'Profile identity changed; reload settings and try again'}));
        } else {
            expect(fixture.values()).toEqual({'profile-a': 'mecab', 'profile-b': 'scan'});
            expect(fixture.report).not.toHaveBeenCalled();
        }
    } finally { releaseSave.resolve(); fixture.close(); }
});

test('ordinary parser selection persists and renders the selected parser', async ({window}) => {
    const fixture = await setup();
    try {
        await chooseMecab(window, fixture);
        expect(fixture.values()).toEqual({'profile-a': 'mecab', 'profile-b': 'scan'});
        expect(fixture.save).toHaveBeenCalledOnce();
        expect(fixture.report).not.toHaveBeenCalled();
    } finally { fixture.close(); }
});

test.for([false, true])('a delayed parser selection response cannot affect a newly applied profile (error=%s)', async (error, {window}) => {
    const fixture = await setup();
    fixture.state.delayResponse = true;
    if (error) {
        await fixture.backend._modifySettings([{action: 'deleteProfile', profileId: 'profile-a', scope: 'global', optionsContext: null}], 'other settings page');
    }
    const selecting = chooseMecab(window, fixture);
    try {
        await fixture.responseReady.promise;
        if (!error) {
            await fixture.backend._modifySettings([{action: 'setDefaultProfile', profileId: 'profile-b', scope: 'global', optionsContext: null}], 'other settings page');
        }
        await fixture.display.updateOptions();
        await fixture.parser.setText('猫');
        fixture.responseGate.resolve();
        await selecting;
        expect(fixture.display.getOptionsProfileId()).toBe('profile-b');
        expect(fixture.parser._selectedParser).toBe('scan');
        expect(fixture.parser._queryParser.textContent).toBe('猫');
        expect(fixture.report).not.toHaveBeenCalled();
        expect(fixture.values()['profile-b']).toBe('scan');
    } finally { fixture.responseGate.resolve(); fixture.close(); }
});

test('a parse from the previous profile cannot persist its fallback choice in the new profile', async ({window: _window}) => {
    const fixture = await setup();
    const oldParse = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    fixture.api.parseText.mockReturnValueOnce(oldParse.promise);
    const parsing = fixture.parser.setText('古い');
    try {
        await fixture.backend._modifySettings([{action: 'setDefaultProfile', profileId: 'profile-b', scope: 'global', optionsContext: null}], 'other settings page');
        await fixture.display.updateOptions();
        oldParse.resolve([parseResult('profile-a-parser', '古い解析')]);
        await parsing;
        await fixture.backend._optionsMutationTail;

        expect(fixture.parser._parseResults).toEqual([]);
        expect(fixture.parser._queryParser.textContent).toBe('古い');
        expect(fixture.parser.needsTextUpdate).toBe(true);
        expect(fixture.api.modifySettings).not.toHaveBeenCalled();
        expect(fixture.values()).toEqual({'profile-a': 'scan', 'profile-b': 'scan'});
    } finally {
        oldParse.resolve([]);
        await parsing;
        fixture.close();
    }
});
