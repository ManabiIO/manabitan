/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';

/**
 * @param {string} action
 * @returns {import('settings').InputsHotkeyOptions}
 */
function makeHotkey(action) {
    return {
        action,
        argument: '',
        key: null,
        modifiers: [],
        scopes: ['popup'],
        enabled: true,
    };
}

function createBackend() {
    const optionsUtil = new OptionsUtil();
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))));
    const options = optionsUtil.getDefault();
    options.profiles[0].options.inputs.hotkeys = [makeHotkey('before'), makeHotkey('removed'), makeHotkey('after')];
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const schema = Reflect.get(optionsUtil, '_optionsSchema');
    if (schema === null) { throw new Error('Missing options schema'); }
    Reflect.set(backend, '_getOptionsFull', () => schema.createProxy(options));
    return {backend, options};
}

describe('Backend settings array splice', () => {
    test('inserts multiple valid items in the middle and returns removed items', () => {
        const {backend, options} = createBackend();
        const result = backend._modifySetting({
            action: 'splice',
            scope: 'global',
            optionsContext: null,
            path: 'profiles[0].options.inputs.hotkeys',
            start: 1,
            deleteCount: 0,
            items: [makeHotkey('one'), makeHotkey('two')],
        });
        expect(result).toStrictEqual([]);
        expect(options.profiles[0].options.inputs.hotkeys.map(({action}) => action)).toStrictEqual(['before', 'one', 'two', 'removed', 'after']);
        const deleted = backend._modifySetting({
            action: 'splice',
            scope: 'global',
            optionsContext: null,
            path: 'profiles[0].options.inputs.hotkeys',
            start: -2,
            deleteCount: 1,
            items: [makeHotkey('replacement')],
        });
        expect(deleted).toStrictEqual([makeHotkey('removed')]);
        expect(options.profiles[0].options.inputs.hotkeys.map(({action}) => action)).toStrictEqual(['before', 'one', 'two', 'replacement', 'after']);
    });

    test('rejects an invalid inserted item without changing the original array', () => {
        const {backend, options} = createBackend();
        const target = options.profiles[0].options.inputs.hotkeys;
        const before = [...target];
        expect(() => backend._modifySetting({
            action: 'splice',
            scope: 'global',
            optionsContext: null,
            path: 'profiles[0].options.inputs.hotkeys',
            start: 1,
            deleteCount: 0,
            items: [makeHotkey('one'), 42],
        })).toThrow();
        expect(target).toStrictEqual(before);
        expect(options.profiles[0].options.inputs.hotkeys).toStrictEqual(before);
    });
});
