/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {createSchema, normalizeContext} from '../ext/js/background/profile-conditions-util.js';

const context = normalizeContext({depth: 0, url: 'https://example.com/'});

describe('Unsupported profile conditions', () => {
    test('unknown condition type does not match every site', () => {
        const unknown = /** @type {import('settings').ProfileCondition} */ (/** @type {unknown} */ ({
            type: 'future-condition-type', operator: 'equal', value: 'anything',
        }));
        const schema = createSchema([{conditions: [unknown]}]);
        expect(schema.schema).toEqual({not: {}});
        expect(schema.isValid(context)).toBe(false);
    });

    test('unknown operator does not match every site', () => {
        const schema = createSchema([{conditions: [
            {type: 'url', operator: 'future-operator', value: 'example.com'},
        ]}]);
        expect(schema.schema).toEqual({not: {}});
        expect(schema.isValid(context)).toBe(false);
    });

    test('an unknown constraint invalidates its conjunction', () => {
        const schema = createSchema([{conditions: [
            {type: 'url', operator: 'matchDomain', value: 'example.com'},
            {type: 'url', operator: 'future-operator', value: 'other.com'},
        ]}]);
        expect(schema.schema).toEqual({not: {}});
        expect(schema.isValid(context)).toBe(false);
    });

    test('a valid alternative group still matches when another group is unsupported', () => {
        const schema = createSchema([
            {conditions: [{type: 'url', operator: 'future-operator', value: 'other.com'}]},
            {conditions: [{type: 'url', operator: 'matchDomain', value: 'example.com'}]},
        ]);
        expect(schema.isValid(context)).toBe(true);
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://other.com/'}))).toBe(false);
    });

    test('no conditions retains the original unrestricted fallback', () => {
        expect(createSchema([]).schema).toEqual({});
        expect(createSchema([{conditions: []}]).schema).toEqual({});
        expect(createSchema([]).isValid(context)).toBe(true);
    });
});
