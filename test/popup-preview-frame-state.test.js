/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {afterEach, expect, vi} from 'vitest';
import {PopupPreviewFrame} from '../ext/js/pages/settings/popup-preview-frame.js';
import {createDomTest} from './fixtures/dom-test.js';

vi.mock('../ext/js/app/frontend.js', () => ({Frontend: class {
    popup = null;
    canClearSelection = true;
    prepare = vi.fn(async () => {});
    setOptionsContextOverride = vi.fn();
    setDisabledOverride = vi.fn();
}}));
vi.mock('../ext/js/app/theme-controller.js', () => ({ThemeController: class {
    prepare = vi.fn();
    updateTheme = vi.fn();
}}));

const test = createDomTest();
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {string} language
 * @returns {import('settings').ProfileOptions}
 */
function options(language) {
    return /** @type {any} */ ({general: {language}, scanning: {selectText: true}});
}

// eslint-disable-next-line jsdoc/require-returns -- Keep the precise inferred Vitest mock signatures.
/**
 * @param {import('jsdom').DOMWindow} window
 */
function setup(window) {
    window.document.body.innerHTML = '<span id="example-text">日本語</span><input id="example-text-input"><span class="placeholder-info"></span>';
    window.document.documentElement.dataset.platform = 'mac';
    vi.stubGlobal('chrome', {runtime: {getURL: (/** @type {string} */ path) => 'chrome-extension://test' + path}});
    const summaries = /** @type {import('language').LanguageSummary[]} */ (/** @type {unknown} */ ([{iso: 'ja', exampleText: '猫'}, {iso: 'en', exampleText: 'cat'}]));
    const api = {
        getLanguageSummaries: vi.fn(async () => summaries),
        optionsGet: vi.fn(async (/** @type {import('settings').OptionsContext} */ _context) => options('ja')),
    };
    const frame = new PopupPreviewFrame(/** @type {any} */ ({api}), /** @type {any} */ ({}), /** @type {any} */ ({}));
    const lookedUp = /** @type {string[]} */ ([]);
    vi.spyOn(frame, '_updateSearch').mockImplementation(async () => { lookedUp.push(frame._exampleText.textContent ?? ''); });
    return {frame, api, optionsGet: api.optionsGet, summaries, lookedUp, input: frame._exampleTextInput, example: frame._exampleText};
}

test('Japanese preview searches the converted text from the same input event', async ({window}) => {
    const {frame, input, example, lookedUp} = setup(window);
    await frame.prepare();
    input.value = 'neko';
    input.dispatchEvent(new window.InputEvent('input', {data: 'o', inputType: 'insertText'}));
    expect(input.value).toBe('ねこ');
    expect(example.textContent).toBe('ねこ');
    expect(lookedUp.at(-1)).toBe('ねこ');
});

test('non-Japanese preview input retains Latin text', async ({window}) => {
    const {frame, input, example, lookedUp} = setup(window);
    await frame.prepare();
    await frame._setLanguageExampleText({language: 'en'});
    input.value = 'neko';
    input.dispatchEvent(new window.InputEvent('input', {data: 'o'}));
    expect(input.value).toBe('neko');
    expect(example.textContent).toBe('neko');
    expect(lookedUp.at(-1)).toBe('neko');
});

test('desktop composing input is retained, then converted consistently when composition ends', async ({window}) => {
    const {frame, input, example} = setup(window);
    await frame.prepare();
    input.value = 'neko';
    input.dispatchEvent(new window.InputEvent('input', {isComposing: true, data: 'o'}));
    expect(input.value).toBe('neko');
    expect(example.textContent).toBe('neko');
    input.dispatchEvent(new window.InputEvent('input', {isComposing: false, data: 'o'}));
    expect(input.value).toBe('ねこ');
    expect(example.textContent).toBe('ねこ');
});

test('preview startup loads language from the selected Settings profile', async ({window}) => {
    const {frame, optionsGet, input, example} = setup(window);
    const context = {index: 1, profileId: 'profile-b'};
    await frame._updateOptionsContext({optionsContext: context});
    optionsGet.mockImplementation(async (/** @type {import('settings').OptionsContext} */ context) => options('profileId' in context && context.profileId === 'profile-b' ? 'en' : 'ja'));
    await frame.prepare();
    expect(optionsGet).toHaveBeenCalledWith(context);
    expect(input.lang).toBe('en');
    expect(example.textContent).toBe('cat');
});

test('a language request received before summaries load survives startup', async ({window}) => {
    const {frame, api, summaries, input, example} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('language').LanguageSummary[]>} */ (Promise.withResolvers());
    api.getLanguageSummaries.mockReturnValueOnce(gate.promise);
    const preparing = frame.prepare();
    const observed = expect(frame._setLanguageExampleText({language: 'en'})).resolves.toBeUndefined();
    gate.resolve(summaries);
    await preparing;
    await observed;
    expect(input.lang).toBe('en');
    expect(example.textContent).toBe('cat');
});

test('late initial options cannot replace a newer language message', async ({window}) => {
    const {frame, optionsGet, input, example} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
    optionsGet.mockReturnValueOnce(gate.promise);
    const preparing = frame.prepare();
    await vi.waitFor(() => expect(optionsGet).toHaveBeenCalledOnce());
    await frame._setLanguageExampleText({language: 'en'});
    gate.resolve(options('ja'));
    await preparing;
    expect(input.lang).toBe('en');
    expect(example.textContent).toBe('cat');
});

test('late initial options cannot replace a custom example typed while loading', async ({window}) => {
    const {frame, optionsGet, input, example} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
    optionsGet.mockReturnValueOnce(gate.promise);
    const preparing = frame.prepare();
    await vi.waitFor(() => expect(optionsGet).toHaveBeenCalledOnce());
    input.value = 'custom';
    input.dispatchEvent(new window.InputEvent('input', {data: 'm'}));
    gate.resolve(options('ja'));
    await preparing;
    expect(input.value).toBe('custom');
    expect(example.textContent).toBe('custom');
});

test('startup retries the selected context when it changes during the initial options read', async ({window}) => {
    const {frame, optionsGet, input, example} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
    optionsGet.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(options('en'));
    const preparing = frame.prepare();
    await vi.waitFor(() => expect(optionsGet).toHaveBeenCalledOnce());
    await frame._updateOptionsContext({optionsContext: {index: 1, profileId: 'profile-b'}});
    gate.resolve(options('ja'));
    await preparing;
    expect(optionsGet).toHaveBeenLastCalledWith({index: 1, profileId: 'profile-b'});
    expect(input.lang).toBe('en');
    expect(example.textContent).toBe('cat');
});

test('unsupported persisted language leaves an editable empty example without throwing', async ({window}) => {
    const {frame, input, example} = setup(window);
    await frame.prepare();
    await expect(frame._setLanguageExampleText({language: 'zz'})).resolves.toBeUndefined();
    expect(input.lang).toBe('zz');
    expect(input.value).toBe('');
    expect(example.textContent).toBe('');
});


test('only the newest language request waiting for summaries updates the preview', async ({window}) => {
    const {frame, api, summaries, input, example} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('language').LanguageSummary[]>} */ (Promise.withResolvers());
    api.getLanguageSummaries.mockReturnValueOnce(gate.promise);
    const preparing = frame.prepare();
    const older = frame._setLanguageExampleText({language: 'ja'});
    const newer = frame._setLanguageExampleText({language: 'en'});
    gate.resolve(summaries);
    await Promise.all([preparing, older, newer]);
    expect(input.lang).toBe('en');
    expect(example.textContent).toBe('cat');
});

test('a custom text message supersedes a language request waiting for summaries', async ({window}) => {
    const {frame, api, summaries, input, example} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('language').LanguageSummary[]>} */ (Promise.withResolvers());
    api.getLanguageSummaries.mockReturnValueOnce(gate.promise);
    const preparing = frame.prepare();
    const language = frame._setLanguageExampleText({language: 'ja'});
    frame._onSetText({text: 'custom text'});
    gate.resolve(summaries);
    await Promise.all([preparing, language]);
    expect(input.value).toBe('custom text');
    expect(example.textContent).toBe('custom text');
});


test('same-language settings refresh preserves the custom preview example', async ({window}) => {
    const {frame, input, example, lookedUp} = setup(window);
    await frame.prepare();
    input.value = 'inu';
    input.dispatchEvent(new window.InputEvent('input', {data: 'u'}));
    const searches = lookedUp.length;
    await frame._setLanguageExampleText({language: 'ja'});
    expect(input.value).toBe('いぬ');
    expect(example.textContent).toBe('いぬ');
    expect(lookedUp).toHaveLength(searches);
});

test('a changed language replaces the prior custom example and conversion mode', async ({window}) => {
    const {frame, input, example} = setup(window);
    await frame.prepare();
    frame._onSetText({text: 'custom'});
    await frame._setLanguageExampleText({language: 'en'});
    expect(input.value).toBe('cat');
    expect(example.textContent).toBe('cat');
    input.value = 'neko';
    input.dispatchEvent(new window.InputEvent('input', {data: 'o'}));
    expect(example.textContent).toBe('neko');
});


test('rejected language-summary startup rejects both prepare and a queued language request', async ({window}) => {
    const {frame, api} = setup(window);
    const gate = /** @type {PromiseWithResolvers<import('language').LanguageSummary[]>} */ (Promise.withResolvers());
    api.getLanguageSummaries.mockReturnValueOnce(gate.promise);
    const preparing = frame.prepare();
    const queuedLanguage = frame._setLanguageExampleText({language: 'en'});
    const assertions = Promise.all([
        expect(preparing).rejects.toThrow('summary unavailable'),
        expect(queuedLanguage).rejects.toThrow('summary unavailable'),
    ]);
    gate.reject(new Error('summary unavailable'));
    await assertions;
    expect(frame._frontend).toBeNull();
});

test('rejected initial options reject prepare without creating a frontend', async ({window}) => {
    const {frame, optionsGet} = setup(window);
    optionsGet.mockRejectedValueOnce(new Error('options unavailable'));
    await expect(frame.prepare()).rejects.toThrow('options unavailable');
    expect(frame._frontend).toBeNull();
});
