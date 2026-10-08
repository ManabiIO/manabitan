/* SPDX-License-Identifier: GPL-3.0-or-later */
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';
import {renderDictionaryResults} from '../ext/web/render.js';

afterEach(() => {vi.unstubAllGlobals();});

/** @param {object[]} entries */
function render(entries) {
    const dom = new JSDOM('<div id="results"></div>', {url: 'https://reader.example.test/'});
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    const container = dom.window.document.getElementById('results');
    if (!container) {throw new Error('Missing render container');}
    const result = /** @type {import('../ext/web/client.js').LookupResult} */ (/** @type {unknown} */ ({dictionaryEntries: entries}));
    const client = /** @type {import('../ext/web/client.js').ManabiTanWebClient} */ (/** @type {unknown} */ ({media: async () => null}));
    const dispose = renderDictionaryResults(container, result, client, () => {});
    return {dom, container, dispose};
}

test('web renderer bounds headword count and strings and reports omitted senses', () => {
    const headwords = Array.from({length: 33}, () => ({term: '猫'.repeat(300), reading: 'ねこ'.repeat(300)}));
    const definitions = Array.from({length: 31}, () => ({dictionary: 'Fixture', entries: []}));
    const {dom, container, dispose} = render([{headwords, definitions, frequencies: []}]);
    try {
        expect(container.querySelectorAll('ruby')).toHaveLength(32);
        expect(container.querySelector('ruby')?.textContent?.length).toBeLessThanOrEqual(512);
        expect(container.querySelectorAll('.dictionary-name')).toHaveLength(30);
        expect(container.textContent).toContain('Some dictionary content was omitted');
    } finally {
        dispose();
        dom.window.close();
    }
});

test('web renderer reports truncated definition entry lists', () => {
    const entry = {headwords: [{term: '猫', reading: 'ねこ'}], frequencies: [], definitions: [{
        dictionary: 'Fixture',
        entries: Array.from({length: 101}, () => 'short definition'),
    }]};
    const {dom, container, dispose} = render([entry]);
    try {
        expect(container.querySelectorAll('ol li')).toHaveLength(100);
        expect(container.textContent).toContain('Some dictionary content was omitted');
    } finally {
        dispose();
        dom.window.close();
    }
});
