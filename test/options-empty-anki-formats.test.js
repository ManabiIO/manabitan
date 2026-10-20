/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from 'node:fs';
import {expect, test} from 'vitest';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';

/** @returns {OptionsUtil} */
function optionsUtil() {
    const schema = JSON.parse(fs.readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
    const util = new OptionsUtil();
    Reflect.set(util, '_optionsSchema', new JsonSchema(schema));
    return util;
}

test('backup normalization repairs legacy empty Anki format lists to valid nonempty settings', async () => {
    const util = optionsUtil();
    const defaults = util.getDefault();
    defaults.profiles[0].options.anki.cardFormats = [];
    expect(() => util.validate(defaults)).toThrow();
    const normalized = await util.update(defaults);
    expect(normalized.profiles[0].options.anki.cardFormats.length).toBeGreaterThanOrEqual(1);
    expect(() => util.validate(normalized)).not.toThrow();
    expect(normalized.profiles[0].options.anki.cardFormats[0]).toMatchObject({type: 'term', model: '', deck: '', fields: {}});
});

test('valid custom Anki formats and ordinary defaults survive normalization', async () => {
    const util = optionsUtil();
    const defaults = util.getDefault();
    expect(defaults.profiles[0].options.anki.cardFormats).toHaveLength(3);
    const original = structuredClone(defaults.profiles[0].options.anki.cardFormats[0]);
    original.name = 'Custom';
    original.model = 'My Model';
    original.deck = 'My Deck';
    original.fields = {Front: {value: '{expression}', overwriteMode: 'coalesce'}};
    defaults.profiles[0].options.anki.cardFormats = [original];
    const normalized = await util.update(defaults);
    expect(normalized.profiles[0].options.anki.cardFormats).toStrictEqual([original]);
});
