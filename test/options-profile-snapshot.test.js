/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {API} from '../ext/js/comm/api.js';

afterEach(() => { vi.restoreAllMocks(); });

test('options and stable profile ID come from one backend profile resolution', () => {
    const a = {id: 'profile-a', conditionGroups: [], options: {clipboard: {enableSearchPageMonitor: false}}};
    const b = {id: 'profile-b', conditionGroups: [], options: {clipboard: {enableSearchPageMonitor: true}}};
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const read = vi.fn().mockReturnValueOnce({profiles: [a, b], profileCurrent: 0}).mockReturnValue({profiles: [a, b], profileCurrent: 1});
    Reflect.set(backend, '_getOptionsFull', read);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    const result = backend._onApiOptionsGetProfile({optionsContext: {depth: 0, url: 'https://example.test'}}, {});
    expect(result).toStrictEqual({profileId: 'profile-a', options: a.options});
    expect(read).toHaveBeenCalledOnce();
});

test('explicit profile identity remains authoritative after profiles reorder', () => {
    const a = {id: 'profile-a', conditionGroups: [], options: {clipboard: {enableSearchPageMonitor: false}}};
    const b = {id: 'profile-b', conditionGroups: [], options: {clipboard: {enableSearchPageMonitor: true}}};
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_getOptionsFull', () => ({profiles: [b, a], profileCurrent: 0}));
    expect(backend._onApiOptionsGetProfile({optionsContext: {index: 0, profileId: 'profile-a'}}, {})).toStrictEqual({profileId: 'profile-a', options: a.options});
});

test('missing profile identity fails instead of publishing an unowned options snapshot', () => {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_getOptionsFull', () => ({profiles: [{id: '', options: {}}], profileCurrent: 0}));
    expect(() => backend._onApiOptionsGetProfile({optionsContext: {current: true}}, {})).toThrow('Search profile identity is unavailable');
});

test('profile snapshot reads retry transient disconnects while settings writes do not', () => {
    const api = /** @type {API} */ (Object.create(API.prototype));
    const disconnected = new Error('The message port closed before a response was received');
    expect(api._shouldRetryInvokeAfterRuntimeError('optionsGetProfile', disconnected)).toBe(true);
    expect(api._shouldRetryInvokeAfterRuntimeError('optionsGetProfile', new Error('Invalid profile'))).toBe(false);
    expect(api._shouldRetryInvokeAfterRuntimeError('modifySettings', disconnected)).toBe(false);
});
