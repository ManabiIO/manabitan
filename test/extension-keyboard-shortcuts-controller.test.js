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

import {afterEach, describe, expect, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {ExtensionKeyboardShortcutController} from '../ext/js/pages/settings/extension-keyboard-shortcuts-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ExtensionKeyboardShortcutController', () => {
    test('reset click swallows rejected reset-all command updates', async ({window}) => {
        window.document.body.innerHTML = `
            <button id="extension-hotkey-list-reset-all"></button>
            <button id="extension-hotkey-list-clear-all"></button>
            <div id="extension-hotkey-list"></div>
        `;

        vi.stubGlobal('browser', {
            commands: {
                reset: vi.fn().mockRejectedValue(new Error('reset failed')),
                update: vi.fn(),
            },
        });
        const getAll = /** @type {(callback: (commands: Array<{name: string, shortcut: string}>) => void) => void} */ ((callback) => callback([{name: 'openSearchPage', shortcut: 'Ctrl+Shift+F'}]));
        vi.stubGlobal('chrome', {
            commands: {
                getAll,
            },
            runtime: {
                lastError: null,
            },
        });

        const controller = new ExtensionKeyboardShortcutController(/** @type {any} */ ({
            application: {api: {getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'linux'}})}},
            instantiateTemplate: vi.fn(() => {
                const node = window.document.createElement('div');
                node.innerHTML = `
                    <div class="extension-hotkey-list-item">
                        <div class="settings-item-label"></div>
                        <button class="extension-hotkey-list-item-button"></button>
                        <input>
                    </div>
                `;
                return /** @type {Element} */ (node.firstElementChild);
            }),
        }));

        await controller.prepare();

        const logError = vi.spyOn(log, 'error');
        expect(controller._onResetClick(new window.MouseEvent('click'))).toBeUndefined();
        await controller._mutationTail;
        await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
    });
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Promise<{controller: ExtensionKeyboardShortcutController, update: import('vitest').Mock, reset: import('vitest').Mock, commands: Map<string, string>}>}
 */
async function shortcutHarness(window) {
    window.document.body.innerHTML = '<button id="extension-hotkey-list-reset-all"></button><button id="extension-hotkey-list-clear-all"></button><div id="extension-hotkey-list"></div>';
    const commands = new Map([['openSearchPage', 'Alt+A'], ['openSettingsPage', 'Alt+S']]);
    const update = vi.fn(async ({name, shortcut}) => { commands.set(name, shortcut); });
    const reset = vi.fn(async (name) => { commands.set(name, 'Alt+A'); });
    const getAll = /** @type {(callback: (commands: Array<{name: string, shortcut: string}>) => void) => void} */ ((callback) => {
        callback([...commands].map(([name, shortcut]) => ({name, shortcut})));
    });
    vi.stubGlobal('browser', {commands: {update, reset}});
    vi.stubGlobal('chrome', {
        commands: {getAll},
        runtime: {lastError: undefined},
    });
    const controller = new ExtensionKeyboardShortcutController(/** @type {any} */ ({
        application: {api: {getEnvironmentInfo: async () => ({platform: {os: 'linux'}})}},
        instantiateTemplate: () => {
            const node = window.document.createElement('div');
            node.innerHTML = '<div class="settings-item-label"></div><button class="extension-hotkey-list-item-button"></button><input>';
            return node;
        },
    }));
    await controller.prepare();
    return {controller, commands, update, reset};
}

/** @returns {PromiseWithResolvers<void>} */
function shortcutGate() { return /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers()); }

test('shortcut edits persist in user order and blur reflects the final browser value', async ({window}) => {
    const h = await shortcutHarness(window);
    const gate = shortcutGate();
    h.update.mockImplementationOnce(async ({name, shortcut}) => {
        await gate.promise;
        h.commands.set(name, shortcut);
    });
    const entry = h.controller._entries[0];
    const first = entry._tryUpdateInput('KeyB', ['alt'], false);
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    const second = entry._tryUpdateInput('KeyC', ['alt'], false);
    gate.resolve();
    await Promise.all([first, second]);
    entry._onInputFieldBlur();
    expect(h.commands.get('openSearchPage')).toBe('Alt+C');
    expect(entry._input?.value).toBe(h.controller.hotkeyUtil.getInputDisplayValue('KeyC', ['alt']));
});

test('a pending row reset settles before clear-all rebuilds the rows', async ({window}) => {
    const h = await shortcutHarness(window);
    const gate = shortcutGate();
    h.reset.mockImplementationOnce(async (name) => {
        await gate.promise;
        h.commands.set(name, 'Alt+A');
    });
    const oldEntry = h.controller._entries[0];
    const reset = oldEntry._resetInput();
    const resetResult = reset.then(() => null, (error) => error);
    await vi.waitFor(() => expect(h.reset).toHaveBeenCalledOnce());
    const clear = h.controller._clearAllCommands();
    await Promise.resolve();
    gate.resolve();
    await clear;
    expect(await resetResult).toBeNull();
    expect(h.commands.get('openSearchPage')).toBe('');
    expect(h.controller._entries[0]._input?.value).toBe('');
});

test('a keyboard edit made during a row reset remains visible and persists last', async ({window}) => {
    const h = await shortcutHarness(window);
    const resetGate = shortcutGate();
    const updateGate = shortcutGate();
    h.reset.mockImplementationOnce(async (name) => {
        await resetGate.promise;
        h.commands.set(name, 'Alt+A');
    });
    h.update.mockImplementationOnce(async ({name, shortcut}) => {
        await updateGate.promise;
        h.commands.set(name, shortcut);
    });
    const entry = h.controller._entries[0];
    const resetting = entry._resetInput();
    await vi.waitFor(() => expect(h.reset).toHaveBeenCalledOnce());

    const input = /** @type {HTMLInputElement} */ (entry._input);
    const change = vi.spyOn(entry, '_tryUpdateInput');
    input.focus();
    input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'c', code: 'KeyC', altKey: true, bubbles: true}));
    const expected = h.controller.hotkeyUtil.getInputDisplayValue('KeyC', ['alt']);
    resetGate.resolve();
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    await resetting;
    expect(input.value).toBe(expected);

    updateGate.resolve();
    await change.mock.results[0].value;
    expect(input.value).toBe(expected);
    expect(h.commands.get('openSearchPage')).toBe('Alt+C');
});

test('a removed row drops its queued writes and late reset publication', async ({window}) => {
    const h = await shortcutHarness(window);
    const gate = shortcutGate();
    h.reset.mockImplementationOnce(async () => { await gate.promise; });
    const entry = h.controller._entries[0];
    const resetting = entry._resetInput();
    const result = resetting.then(() => null, (error) => error);
    await vi.waitFor(() => expect(h.reset).toHaveBeenCalledOnce());
    const queued = entry._tryUpdateInput('KeyC', ['alt'], true);
    entry.cleanup();
    gate.resolve();
    await queued;
    expect(await result).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
});

test('bulk failures drain every browser mutation before a later edit starts', async ({window}) => {
    const h = await shortcutHarness(window);
    const gate = shortcutGate();
    h.update.mockImplementation(async ({name, shortcut}) => {
        if (shortcut === '' && name === 'openSearchPage') { throw new Error('clear denied'); }
        if (shortcut === '') { await gate.promise; }
        h.commands.set(name, shortcut);
    });
    const clear = h.controller._clearAllCommands().then(() => null, (error) => error);
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(2));
    const later = h.controller.updateCommand('openSearchPage', 'KeyC', ['alt']);
    await Promise.resolve();
    const callsBeforeDrain = h.update.mock.calls.length;
    gate.resolve();
    expect(await clear).toMatchObject({message: 'clear denied'});
    await later;
    expect(callsBeforeDrain).toBe(2);
    expect(h.commands.get('openSearchPage')).toBe('Alt+C');
    expect(h.commands.get('openSettingsPage')).toBe('');
    expect(h.controller._entries[0]._input?.value).toBe(h.controller.hotkeyUtil.getInputDisplayValue('KeyA', ['alt']));
    expect(h.controller._entries[1]._input?.value).toBe('');
});

test('blurring during a save preserves the edited shortcut until it is acknowledged', async ({window}) => {
    const h = await shortcutHarness(window);
    const gate = shortcutGate();
    h.update.mockImplementationOnce(async ({name, shortcut}) => {
        await gate.promise;
        h.commands.set(name, shortcut);
    });
    const entry = h.controller._entries[0];
    const input = /** @type {HTMLInputElement} */ (entry._input);
    const change = vi.spyOn(entry, '_tryUpdateInput');
    input.focus();
    input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'c', code: 'KeyC', altKey: true, bubbles: true}));
    const expected = h.controller.hotkeyUtil.getInputDisplayValue('KeyC', ['alt']);
    input.blur();
    const pendingValue = input.value;
    gate.resolve();
    await change.mock.results[0].value;
    expect(pendingValue).toBe(expected);
    expect(input.value).toBe(expected);
    expect(h.commands.get('openSearchPage')).toBe('Alt+C');
});

test('a failed latest edit restores the last successful browser value on blur', async ({window}) => {
    const h = await shortcutHarness(window);
    const gate = shortcutGate();
    h.update.mockImplementationOnce(async ({name, shortcut}) => {
        await gate.promise;
        h.commands.set(name, shortcut);
    })
        .mockRejectedValueOnce(new Error('invalid shortcut'));
    const entry = h.controller._entries[0];
    const first = entry._tryUpdateInput('KeyB', ['alt'], false);
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    const second = entry._tryUpdateInput('KeyC', ['alt'], false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(entry._input?.dataset.invalid).toBe('true');
    entry._onInputFieldBlur();
    expect(entry._input?.value).toBe(h.controller.hotkeyUtil.getInputDisplayValue('KeyB', ['alt']));
    expect(h.commands.get('openSearchPage')).toBe('Alt+B');
});
