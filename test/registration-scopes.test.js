/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {expect, test, vi} from 'vitest';
import {createApiMap, extendApiMap, registerApiMapScope} from '../ext/js/core/api-map.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';

test.each([false, true])('handler registration rejects duplicates without publishing a prefix (within batch=%s)', (withinBatch) => {
    const handler = () => {};
    const map = createApiMap([['existing', handler]]);
    const entries = withinBatch ? [['new', handler], ['new', handler]] : [['new', handler], ['existing', handler]];
    expect(() => extendApiMap(map, /** @type {never} */ (entries))).toThrow('already been registered');
    expect([...map.keys()]).toStrictEqual(['existing']);
});

test('a retired handler scope cannot remove a replacement and cleanup is idempotent', () => {
    const first = () => {};
    const replacement = () => {};
    const map = /** @type {import('api-map').ApiMap<{owned: {params: void, return: void}}>} */ (createApiMap([]));
    const dispose = registerApiMapScope(map, [['owned', first]]);
    map.set('owned', replacement);
    dispose();
    dispose();
    expect(map.get('owned')).toBe(replacement);
});

test.each([false, true])('hotkey cleanup restores the base action without resurrecting retired scopes (out of order=%s)', (outOfOrder) => {
    const hotkeys = new HotkeyHandler();
    const base = vi.fn();
    hotkeys.registerActions([['test', base]]);
    const first = hotkeys.registerActionsScoped([['test', vi.fn()]]);
    const second = hotkeys.registerActionsScoped([['test', vi.fn()]]);
    if (outOfOrder) {
        first(); second();
    } else {
        second(); first();
    }
    second();
    first();
    expect(Reflect.get(hotkeys, '_actions').get('test')).toBe(base);
});

test('hotkey scope cleanup preserves newer permanent registrations', () => {
    const hotkeys = new HotkeyHandler();
    const dispose = hotkeys.registerActionsScoped([['test', () => {}]]);
    const replacement = () => {};
    hotkeys.registerActions([['test', replacement]]);
    dispose();
    expect(Reflect.get(hotkeys, '_actions').get('test')).toBe(replacement);
});
