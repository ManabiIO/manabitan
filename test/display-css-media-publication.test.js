/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {expect, test, vi} from 'vitest';
import {DictionaryCssMediaResolver} from '../ext/js/display/dictionary-css-media-resolver.js';
import {Display} from '../ext/js/display/display.js';

/** @typedef {{dictionary: string, path: string, mediaType: string, content: string}} MediaResult */

test.each([false, true])('current render applies cached CSS after an obsolete render resolves (overlap=%s)', async (overlap) => {
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const first = Promise.withResolvers();
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const second = Promise.withResolvers();
    const getMedia = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const createObjectURL = vi.fn(() => 'blob:resolved-media');
    const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL, revokeObjectURL: vi.fn()});
    const styles = '.sense { background-image: url("mdict-media/a.png"); }';
    const options = {dictionaries: [{name: 'A', enabled: true, styles}]};
    resolver.prune(options.dictionaries);
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const oldToken = /** @type {import('core').TokenObject} */ ({});
    const newToken = /** @type {import('core').TokenObject} */ ({});
    const applyTheme = vi.fn();
    const onError = vi.fn();
    Reflect.set(display, '_options', options);
    Reflect.set(display, '_setContentToken', oldToken);
    Reflect.set(display, '_dictionaryCssMediaResolver', resolver);
    Reflect.set(display, '_setTheme', applyTheme);
    Reflect.set(display, 'onError', onError);
    Reflect.set(display, '_container', {
        querySelectorAll: () => [{style: {cssText: ''}, closest: () => ({dataset: {dictionary: 'A'}})}],
    });
    vi.stubGlobal('window', {location: {href: 'chrome-extension://example/search.html'}});
    vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (/** @type {string} */ name) => name === 'background-image' ? 'url("chrome-extension://example/mdict-media/a.png")' : 'none',
    }));
    const media = [{dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='}];
    try {
        const obsolete = Display.prototype._resolveDictionaryCssMedia.call(display, oldToken);
        Reflect.set(display, '_setContentToken', newToken);
        const current = overlap ? Display.prototype._resolveDictionaryCssMedia.call(display, newToken) : null;
        first.resolve(media);
        await obsolete;
        expect(applyTheme).not.toHaveBeenCalled();
        if (current === null) {
            await Display.prototype._resolveDictionaryCssMedia.call(display, newToken);
        } else {
            second.resolve(media);
            await current;
        }
        expect(onError).not.toHaveBeenCalled();
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(resolver.rewriteStyles('A', styles)).toContain('blob:resolved-media');
        expect(applyTheme).toHaveBeenCalledExactlyOnceWith(options);
        expect(getMedia).toHaveBeenCalledTimes(overlap ? 2 : 1);
    } finally {
        first.resolve(media);
        second.resolve(media);
        vi.unstubAllGlobals();
    }
});
