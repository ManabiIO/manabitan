/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {expect, test, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';

test('display preserves distinct dictionary/path pairs before resolver batching', async () => {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const token = {};
    const first = {dictionary: 'A', path: 'mdict-media/x\u001fmdict-media/a.png'};
    const second = {dictionary: 'A\u001fmdict-media/x', path: 'mdict-media/a.png'};
    const resolve = vi.fn().mockResolvedValue(false);
    const elements = [
        {
            style: {cssText: String.raw`background: url("mdict-media/x\1f mdict-media/a.png")`},
            closest: () => ({dataset: {dictionary: first.dictionary}}),
        },
        {
            style: {cssText: 'background: url("mdict-media/a.png")'},
            closest: () => ({dataset: {dictionary: second.dictionary}}),
        },
    ];
    Reflect.set(display, '_options', {dictionaries: []});
    Reflect.set(display, '_setContentToken', token);
    Reflect.set(display, '_container', {querySelectorAll: () => elements});
    Reflect.set(display, '_dictionaryCssMediaResolver', {
        resolve,
        /**
         * @param {string} _dictionary
         * @param {string} css
         * @returns {string}
         */
        rewriteStyles(_dictionary, css) { return css; },
    });
    vi.stubGlobal('window', {location: {href: 'chrome-extension://example/search.html'}});
    try {
        await Display.prototype._resolveDictionaryCssMedia.call(display, token);
        expect(resolve).toHaveBeenCalledExactlyOnceWith([first, second]);
    } finally {
        vi.unstubAllGlobals();
    }
});
