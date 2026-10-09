/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {StructuredContentGenerator} from '../ext/js/display/structured-content-generator.js';
import {ReaderMedia, renderDictionaryResults} from '../ext/web/render.js';

/** @type {JSDOM} */
let dom;

beforeEach(() => {
    dom = new JSDOM('<div id="results"><span id="previous">previous search</span></div>', {url: 'https://reader.example.test/'});
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
});

/**
 * @returns {HTMLElement}
 */
function getContainer() {
    const element = dom.window.document.getElementById('results');
    if (element === null) {throw new Error('Missing test container');}
    return element;
}

/**
 * @param {unknown[]} dictionaryEntries
 * @returns {import('../ext/web/client.js').LookupResult}
 */
function result(dictionaryEntries) {
    return /** @type {import('../ext/web/client.js').LookupResult} */ (/** @type {unknown} */ ({dictionaryEntries}));
}

const client = /** @type {import('../ext/web/client.js').ManabiTanWebClient} */ (/** @type {unknown} */ ({media: async () => null}));

test('a structured glossary render error disposes media and preserves previous content', () => {
    const dispose = vi.spyOn(ReaderMedia.prototype, 'dispose');
    vi.spyOn(StructuredContentGenerator.prototype, 'createStructuredContent').mockImplementation(() => {
        throw new Error('Structured glossary render failed');
    });

    const entries = [{
        headwords: [{term: '猫', reading: 'ねこ'}],
        frequencies: [],
        definitions: [{
            dictionary: 'Fixture',
            entries: [{type: 'structured-content', content: ['malformed glossary']}],
        }],
    }];
    const container = getContainer();
    expect(() => renderDictionaryResults(container, result(entries), client, () => {})).toThrow('Structured glossary render failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(container.querySelector('#previous')?.textContent).toBe('previous search');
});

test('a failed final DOM publication disposes the render lifetime', () => {
    const dispose = vi.spyOn(ReaderMedia.prototype, 'dispose');
    const container = getContainer();
    vi.spyOn(container, 'replaceChildren').mockImplementation(() => {throw new Error('Detached DOM');});

    expect(() => renderDictionaryResults(container, result([]), client, () => {})).toThrow('Detached DOM');
    expect(dispose).toHaveBeenCalledOnce();
});

test('successful rendering returns the normal explicit disposal callback', () => {
    const dispose = vi.spyOn(ReaderMedia.prototype, 'dispose');
    const container = getContainer();
    const cleanup = renderDictionaryResults(container, result([]), client, () => {});
    expect(dispose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('No matching dictionary entries');
    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
});
