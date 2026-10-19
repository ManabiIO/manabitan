/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';

test.each([
    ['𠮷野', '𠮷'],
    ['𩸽定食', '𩸽'],
    ['読む', '読'],
    ['', ''],
])('kanji deck lookup preserves the first code point in %s', async (input, expected) => {
    const entry = {type: 'kanji', character: expected};
    const kanjiFind = vi.fn(async () => (expected === '' ? [] : [entry]));
    const termsFind = vi.fn();
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.create(AnkiDeckGeneratorController.prototype));
    Reflect.set(controller, '_settingsController', {application: {api: {kanjiFind, termsFind}}});
    const context = {index: 0, profileId: 'profile-a'};
    const result = await controller._getDictionaryEntry(input, context, 'kanji');
    if (expected === '') {
        expect(kanjiFind).not.toHaveBeenCalled();
    } else {
        expect(kanjiFind).toHaveBeenCalledWith(expected, context);
    }
    expect(termsFind).not.toHaveBeenCalled();
    expect(result).toEqual(expected === '' ? null : {dictionaryEntry: entry, text: input});
});
