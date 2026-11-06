/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, expect, test, vi} from 'vitest';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
    const getAll = vi.fn();
    vi.stubGlobal('chrome', {permissions: {getAll}, runtime: {lastError: null}});
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({})));
    const changed = vi.fn();
    settings.on('permissionsChanged', changed);
    return {settings, changed, getAll};
}

test('a later permission snapshot supersedes an older pending event read', async () => {
    const {settings, changed, getAll} = setup();
    const first = settings._triggerPermissionsChanged();
    const second = settings._triggerPermissionsChanged();
    const granted = {origins: ['<all_urls>'], permissions: ['clipboardRead']};
    getAll.mock.calls[1][0](granted);
    await second;
    getAll.mock.calls[0][0]({origins: [], permissions: []});
    await first;
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith({permissions: granted});
});

test('a failed newest permission read cannot publish an older stale snapshot', async () => {
    const {settings, changed, getAll} = setup();
    const first = settings._triggerPermissionsChanged();
    const second = settings._triggerPermissionsChanged();
    const rejected = expect(second).rejects.toThrow('permission read failed');
    Reflect.set(chrome.runtime, 'lastError', {message: 'permission read failed'});
    getAll.mock.calls[1][0]({origins: [], permissions: []});
    await rejected;
    Reflect.set(chrome.runtime, 'lastError', undefined);
    getAll.mock.calls[0][0]({origins: ['<all_urls>'], permissions: []});
    await first;
    expect(changed).not.toHaveBeenCalled();
    const retry = settings._triggerPermissionsChanged();
    getAll.mock.calls[2][0]({origins: [], permissions: []});
    await retry;
    expect(changed).toHaveBeenCalledOnce();
});

test('permission events attach rejection ownership to asynchronous refreshes', () => {
    const {settings} = setup();
    const catchSpy = vi.fn();
    settings._triggerPermissionsChanged = vi.fn(() => /** @type {Promise<void>} */ (/** @type {unknown} */ ({catch: catchSpy})));
    settings._onPermissionsChanged();
    expect(catchSpy).toHaveBeenCalledOnce();
});
