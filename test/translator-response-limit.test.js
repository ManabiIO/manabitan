/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {Translator} from '../ext/js/language/translator.js';

function createTranslator() {
    const translator = new Translator(/** @type {ConstructorParameters<typeof Translator>[0]} */ (/** @type {unknown} */ ({
        getDictionaryAvailability: () => [],
    })));
    Reflect.set(translator, '_findTermsInternal', async () => ({dictionaryEntries: [], originalTextLength: 1}));
    Reflect.set(translator, '_finalizeTermDictionaryEntries', async () => ([
        {id: 'first'},
        {id: 'second'},
        {id: 'third'},
    ]));
    return translator;
}

test('applies the transport response limit after final result ordering', async () => {
    const translator = createTranslator();
    const options = /** @type {import('translation').FindTermsOptions} */ (/** @type {unknown} */ ({
        primaryReading: '',
        enabledDictionaryMap: new Map(),
    }));

    const limited = await translator.findTerms('simple', 'フォ', options, 2);
    const unlimited = await translator.findTerms('simple', 'フォ', options);

    expect(limited.dictionaryEntries).toEqual([{id: 'first'}, {id: 'second'}]);
    expect(unlimited.dictionaryEntries).toEqual([{id: 'first'}, {id: 'second'}, {id: 'third'}]);
});
