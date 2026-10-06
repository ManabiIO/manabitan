/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {expect, vi} from 'vitest';
import {collectDictionaryCssMediaTargets} from '../ext/js/display/dictionary-css-media-targets.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

domTest('discovery combines inline and active pseudo-element resources without mutating CSS', ({window}) => {
    const container = window.document.createElement('div');
    container.dataset.dictionary = 'A';
    const element = window.document.createElement('span');
    element.dataset.scTag = 'span';
    element.style.backgroundImage = 'url("mdict-media/a.png")';
    container.appendChild(element);
    const before = element.style.cssText;
    const getStyle = vi.fn((_element, pseudo) => ({
        /**
         * @param {string} property
         * @returns {string}
         */
        getPropertyValue(property) {
            return pseudo === '::before' && property === 'content' ? 'url("mdict-media/b.png")' : 'none';
        },
    }));
    vi.stubGlobal('getComputedStyle', getStyle);
    try {
        const result = collectDictionaryCssMediaTargets(container, [{
            name: 'A',
            enabled: true,
            styles: '.active{content:url(mdict-media/b.png)} .unused{background:url(mdict-media/unused.png)}',
        }], 'chrome-extension://example/search.html');
        expect(result.targets).toStrictEqual([
            {dictionary: 'A', path: 'mdict-media/a.png'},
            {dictionary: 'A', path: 'mdict-media/b.png'},
        ]);
        expect(result.inlineStyleElements).toStrictEqual([{element, dictionary: 'A'}]);
        expect(element.style.cssText).toBe(before);
        expect(getStyle.mock.calls.map(([, pseudo]) => pseudo)).toStrictEqual([null, '::before', '::after']);
    } finally {
        vi.unstubAllGlobals();
    }
});

domTest('discovery skips computed-style reads without enabled dictionary media CSS', ({window}) => {
    const container = window.document.createElement('div');
    container.dataset.dictionary = 'A';
    const element = window.document.createElement('span');
    element.dataset.scTag = 'span';
    container.appendChild(element);
    const getStyle = vi.fn();
    vi.stubGlobal('getComputedStyle', getStyle);
    try {
        for (const styles of ['', '.sense{color:red}']) {
            const result = collectDictionaryCssMediaTargets(container, [{name: 'A', enabled: true, styles}], 'chrome-extension://example/search.html');
            expect(result).toStrictEqual({targets: [], inlineStyleElements: []});
        }
        expect(getStyle).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});
