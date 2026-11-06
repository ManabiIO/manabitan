/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

afterEach(() => { vi.unstubAllGlobals(); });

function fixture() {
    const target = new EventTarget();
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const mode = vi.fn(async (/** @type {boolean} */ _active, /** @type {string} */ _owner) => {});
    const disconnect = vi.fn();
    const modal = {on: vi.fn(), off: vi.fn()};
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
    Reflect.set(controller, '_modalController', {getModal: () => modal});
    Reflect.set(controller, '_settingsController', {on: vi.fn(), application: {api: {setDictionaryImportMode: mode}}});
    Reflect.set(controller, '_activeImportOwnerId', 'page-A');
    Reflect.set(controller, '_activeMdx', {disconnect});
    Reflect.set(controller, '_onDocumentClickCaptureBind', vi.fn());
    Reflect.set(controller, '_onModalVisibilityChangedEventBind', vi.fn());
    Reflect.set(controller, '_onRecommendedDictionariesModalVisibilityChangedBind', vi.fn());
    for (const key of ['_purgeButton', '_purgeConfirmButton', '_importButton', '_importConfirmButton', '_importURLButton', '_importFileInput', '_importFileDrop']) {
        Reflect.set(controller, key, new EventTarget());
    }
    controller.prepare();
    const settings = Object.create(SettingsController.prototype);
    Reflect.set(settings, '_pageExitPreventions', new Set([{}]));
    target.addEventListener('beforeunload', (event) => {
        Object.defineProperty(event, 'returnValue', {value: '', writable: true});
        Reflect.get(SettingsController.prototype, '_onBeforeUnload').call(settings, event);
    });
    return {target, controller, mode, disconnect, modal};
}

test('choosing Stay preserves import ownership until an actual pagehide', () => {
    const {target, controller, mode, disconnect} = fixture();
    for (let attempt = 0; attempt < 2; ++attempt) {
        const event = new Event('beforeunload', {cancelable: true});
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(mode).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
        expect(Reflect.get(controller, '_activeImportOwnerId')).toBe('page-A');
    }
    target.dispatchEvent(new Event('pagehide'));
    expect(mode).toHaveBeenCalledExactlyOnceWith(false, 'page-A');
    expect(disconnect).toHaveBeenCalledOnce();
    target.dispatchEvent(new Event('pagehide'));
    expect(mode).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
});

test('a cached page retains listeners and releases a later import after restoration', () => {
    const {target, controller, mode, modal} = fixture();
    const event = new Event('pagehide');
    Object.defineProperty(event, 'persisted', {value: true});
    target.dispatchEvent(event);
    expect(modal.off).not.toHaveBeenCalled();
    Reflect.set(controller, '_activeImportOwnerId', 'page-B');
    target.dispatchEvent(new Event('pagehide'));
    expect(mode.mock.calls).toEqual([[false, 'page-A'], [false, 'page-B']]);
});
