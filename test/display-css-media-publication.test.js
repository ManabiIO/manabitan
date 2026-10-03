/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {expect, test, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {DictionaryCssMediaResolver} from '../ext/js/display/dictionary-css-media-resolver.js';
import {Display} from '../ext/js/display/display.js';

/** @typedef {{dictionary: string, path: string, mediaType: string, content: string}} MediaResult */

test('building custom CSS does not publish a stylesheet', () => {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const publish = vi.fn();
    Reflect.set(display, 'setCustomCss', publish);
    Reflect.set(display, '_dictionaryCssMediaResolver', new DictionaryCssMediaResolver({getMedia: async () => []}));
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {customPopupCss: '.custom{color:red}'},
        dictionaries: [{name: 'A', enabled: true, styles: '.sense{color:blue}'}],
    }));
    const css = Display.prototype._getCustomCss.call(display, options);
    expect(css).toContain('.custom{color:red}');
    expect(css).toContain('[data-dictionary="A"]');
    expect(publish).not.toHaveBeenCalled();
});

test.each(['discovery', 'publication', 'obsolete-fetch'])('CSS media contains failures during %s', async (stage) => {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const token = /** @type {import('core').TokenObject} */ ({});
    const error = new Error('Injected CSS media failure');
    const reportError = vi.spyOn(log, 'error').mockImplementation(() => {});
    Reflect.set(display, '_options', {dictionaries: [{name: 'A', enabled: true, styles: '.sense{background:url(mdict-media/a.png)}'}]});
    Reflect.set(display, '_setContentToken', token);
    Reflect.set(display, '_application', {webExtension: {unloaded: false}});
    Reflect.set(display, '_container', {
        querySelectorAll: () => [{style: {cssText: ''}, closest: () => ({dataset: {dictionary: 'A'}})}],
    });
    Reflect.set(display, '_dictionaryCssMediaResolver', {
        async resolve() {
            if (stage === 'obsolete-fetch') {
                Reflect.set(display, '_setContentToken', {});
                throw error;
            }
            return true;
        },
        rewriteStyles() { throw error; },
    });
    vi.stubGlobal('window', {location: {href: 'chrome-extension://example/search.html'}});
    vi.stubGlobal('getComputedStyle', () => {
        if (stage === 'discovery') { throw error; }
        return {getPropertyValue: () => 'url(mdict-media/a.png)'};
    });
    try {
        await expect(Display.prototype._resolveDictionaryCssMedia.call(display, token)).resolves.toBeUndefined();
        if (stage === 'obsolete-fetch') {
            expect(reportError).not.toHaveBeenCalled();
        } else {
            expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
        }
    } finally {
        vi.unstubAllGlobals();
        reportError.mockRestore();
    }
});

test.each([false, true])('current render applies cached CSS after an obsolete render resolves (overlap=%s)', async (overlap) => {
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const first = Promise.withResolvers();
    const getMedia = vi.fn().mockReturnValue(first.promise);
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
        getPropertyValue: (/** @type {string} */ name) => (name === 'background-image' ? 'url("chrome-extension://example/mdict-media/a.png")' : 'none'),
    }));
    const media = [{dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='}];
    try {
        const obsolete = Display.prototype._resolveDictionaryCssMedia.call(display, oldToken);
        Reflect.set(display, '_setContentToken', newToken);
        const current = overlap ? Display.prototype._resolveDictionaryCssMedia.call(display, newToken) : null;
        first.resolve(media);
        await obsolete;
        if (current === null) {
            expect(applyTheme).not.toHaveBeenCalled();
            await Display.prototype._resolveDictionaryCssMedia.call(display, newToken);
        } else {
            await current;
        }
        expect(onError).not.toHaveBeenCalled();
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(resolver.rewriteStyles('A', styles)).toContain('blob:resolved-media');
        expect(applyTheme).toHaveBeenCalledExactlyOnceWith(options);
        expect(getMedia).toHaveBeenCalledTimes(1);
    } finally {
        first.resolve(media);
        vi.unstubAllGlobals();
    }
});
