/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {afterEach, expect, vi} from 'vitest';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {Display} from '../ext/js/display/display.js';
import {SearchDisplayController} from '../ext/js/display/search-display-controller.js';
import {SearchPersistentStateController} from '../ext/js/display/search-persistent-state-controller.js';
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** @returns {Promise<{controller: SearchDisplayController, display: Display, hotkeys: HotkeyHandler, input: HTMLTextAreaElement, publish: import('vitest').MockInstance<Display['setContent']>}>} */
async function createSearch() {
    vi.stubGlobal('chrome', {runtime: {onMessage: {addListener: vi.fn()}}});
    const optionsUtil = new OptionsUtil();
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))));
    const options = optionsUtil.getDefault();
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api: {clipboardGet: vi.fn().mockResolvedValue(''), optionsGetFull: vi.fn().mockResolvedValue(options)},
        tabId: 1,
        frameId: 0,
        on: vi.fn(),
        triggerClosePopups: vi.fn(),
    }));
    const hotkeys = new HotkeyHandler();
    hotkeys.prepare(/** @type {import('../ext/js/comm/cross-frame-api.js').CrossFrameAPI} */ (/** @type {unknown} */ ({registerHandlers: vi.fn()})));
    hotkeys.setHotkeys('search', options.profiles[0].options.inputs.hotkeys);
    const display = new Display(application, 'search', new DocumentFocusController(), hotkeys);
    display._options = options.profiles[0].options;
    vi.spyOn(display, 'updateOptions').mockResolvedValue();
    const publish = vi.spyOn(display, 'setContent').mockResolvedValue('completed');
    const controller = new SearchDisplayController(display, new DisplayAudio(display), new SearchPersistentStateController());
    await controller.prepare();
    const input = controller._queryInput;
    input.value = '検索中です';
    input.focus();
    input.setSelectionRange(2, 2);
    return {controller, display, hotkeys, input, publish};
}

test.for([
    {isComposing: true, keyCode: 27},
    {isComposing: false, keyCode: 229},
])('IME Escape preserves the composing search selection: %j', async (composition, {window}) => {
    const {controller, input, publish} = await createSearch();
    try {
        input.dispatchEvent(new window.CompositionEvent('compositionstart', {bubbles: true}));
        if (!composition.isComposing) { input.dispatchEvent(new window.CompositionEvent('compositionend', {bubbles: true})); }
        const event = new window.KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, ...composition});
        input.dispatchEvent(event);

        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(2);
        expect(input.value).toBe('検索中です');
        expect(event.defaultPrevented).toBe(false);
        expect(publish).not.toHaveBeenCalled();
    } finally { controller._cancelLiveSearch(); }
});

test.for([
    {isComposing: true, keyCode: 85},
    {isComposing: false, keyCode: 229},
])('IME Ctrl+U does not clear the search draft through fallback key handling: %j', async (composition, {window}) => {
    const {controller, input, publish} = await createSearch();
    try {
        input.dispatchEvent(new window.CompositionEvent('compositionstart', {bubbles: true}));
        if (!composition.isComposing) { input.dispatchEvent(new window.CompositionEvent('compositionend', {bubbles: true})); }
        const event = new window.KeyboardEvent('keydown', {key: 'u', code: 'KeyU', ctrlKey: true, bubbles: true, cancelable: true, ...composition});
        input.dispatchEvent(event);

        expect(input.value).toBe('検索中です');
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(2);
        expect(event.defaultPrevented).toBe(false);
        expect(publish).not.toHaveBeenCalled();
    } finally { controller._cancelLiveSearch(); }
});

test('ordinary Escape still selects the search text after composition ends', async ({window}) => {
    const {controller, input, publish} = await createSearch();
    try {
        input.dispatchEvent(new window.CompositionEvent('compositionstart', {bubbles: true}));
        input.dispatchEvent(new window.CompositionEvent('compositionend', {bubbles: true}));
        const event = new window.KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true});
        input.dispatchEvent(event);

        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(input.value.length);
        expect(event.defaultPrevented).toBe(true);
        expect(publish).not.toHaveBeenCalled();
    } finally { controller._cancelLiveSearch(); }
});

test('ordinary Ctrl+U still clears the search text after composition ends', async ({window}) => {
    const {controller, input, publish} = await createSearch();
    try {
        input.dispatchEvent(new window.CompositionEvent('compositionstart', {bubbles: true}));
        input.dispatchEvent(new window.CompositionEvent('compositionend', {bubbles: true}));
        const event = new window.KeyboardEvent('keydown', {key: 'u', code: 'KeyU', ctrlKey: true, bubbles: true, cancelable: true});
        input.dispatchEvent(event);

        expect(input.value).toBe('');
        expect(event.defaultPrevented).toBe(true);
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            historyMode: 'overwrite',
            params: {query: '', lookup: 'false'},
        }));
    } finally { controller._cancelLiveSearch(); }
});

test.for(/** @type {const} */ (['popup', 'search', 'web']))('IME filtering preserves ordinary hotkey scope selection: %s', (scope, {window}) => {
    const hotkeys = new HotkeyHandler();
    const action = vi.fn();
    const inactiveAction = vi.fn();
    const fallback = vi.fn();
    hotkeys.registerActions([['active', action], ['inactive', inactiveAction]]);
    hotkeys.setHotkeys(scope, [
        {action: 'active', argument: 'selected', key: 'Escape', modifiers: [], scopes: [scope], enabled: true},
        {action: 'inactive', argument: '', key: 'Escape', modifiers: [], scopes: [], enabled: true},
    ]);
    hotkeys.on('keydownNonHotkey', fallback);
    hotkeys.prepare(/** @type {import('../ext/js/comm/cross-frame-api.js').CrossFrameAPI} */ (/** @type {unknown} */ ({registerHandlers: vi.fn()})));
    for (const composition of [{isComposing: true}, {keyCode: 229}]) {
        const event = new window.KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, ...composition});
        window.document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    }
    expect(action).not.toHaveBeenCalled();
    expect(inactiveAction).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();

    const event = new window.KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true});
    window.document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledExactlyOnceWith('selected');
    expect(inactiveAction).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
});
