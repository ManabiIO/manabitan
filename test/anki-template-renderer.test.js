/*
 * Copyright (C) 2023-2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe} from 'vitest';
import {AnkiTemplateRenderer} from '../ext/js/templates/anki-template-renderer.js';
import {createAnkiTemplateRendererTest} from './fixtures/anki-template-renderer-test.js';

const test = await createAnkiTemplateRendererTest();

describe('AnkiTemplateRenderer', () => {
    /**
     * @param {'html'|'text'} mode
     * @param {{expect: typeof import('vitest').expect, window: import('jsdom').DOMWindow}} context
     * @returns {Promise<void>}
     */
    const verifyNormalizationFailureRecovery = async (mode, {expect, window}) => {
        const renderer = new AnkiTemplateRenderer(window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
        await renderer.prepare();
        const normalizeHtml = renderer._normalizeHtml.bind(renderer);
        let shouldFail = true;
        renderer._normalizeHtml = (...args) => {
            if (shouldFail) {
                shouldFail = false;
                throw new Error('injected normalization failure');
            }
            normalizeHtml(...args);
        };
        /**
         * @param {Element} node
         * @returns {string}
         */
        const getResult = (node) => (mode === 'html' ? renderer._getHtml(node, renderer._structuredContentStyleApplier, renderer._structuredContentDatasetKeyIgnorePattern) : renderer._getText(node, renderer._structuredContentStyleApplier, renderer._structuredContentDatasetKeyIgnorePattern));
        const failedNode = window.document.createElement('div');
        failedNode.appendChild(window.document.createTextNode('stale content'));
        expect(() => getResult(failedNode)).toThrow('injected normalization failure');

        const healthyNode = window.document.createElement('div');
        const healthyBold = window.document.createElement('b');
        healthyBold.appendChild(window.document.createTextNode('healthy content'));
        healthyNode.appendChild(healthyBold);
        const result = String(getResult(healthyNode));
        expect(result).toBe(mode === 'html' ? '<div><b>healthy content</b></div>' : 'healthy content');
    };

    test('plain structured text preserves NBSP, ruby readings, and controlled line breaks', async ({expect, window}) => {
        const renderer = new AnkiTemplateRenderer(window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
        await renderer.prepare();

        const node = window.document.createElement('div');
        node.appendChild(window.document.createTextNode('\u00a0'));
        const ruby = window.document.createElement('ruby');
        ruby.appendChild(window.document.createTextNode('漢'));
        const reading = window.document.createElement('rt');
        reading.appendChild(window.document.createTextNode('かん'));
        ruby.appendChild(reading);
        node.appendChild(ruby);
        node.appendChild(window.document.createElement('br'));
        node.appendChild(window.document.createTextNode('x<&>'));

        const result = String(renderer._getText(node, renderer._structuredContentStyleApplier, renderer._structuredContentDatasetKeyIgnorePattern));
        expect(result).toBe('&nbsp; 漢[かん]<br>\nx&lt;&amp;&gt;');
    });

    test('plain structured text serializes deeply nested DOM iteratively', async ({expect, window}) => {
        const renderer = new AnkiTemplateRenderer(window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
        await renderer.prepare();

        const node = window.document.createElement('div');
        /** @type {Element} */
        let parent = node;
        for (let i = 0; i < 1200; ++i) {
            const child = window.document.createElement('i');
            parent.appendChild(child);
            parent = child;
        }
        parent.appendChild(window.document.createTextNode('deep text'));

        const result = String(renderer._getText(node, renderer._structuredContentStyleApplier, renderer._structuredContentDatasetKeyIgnorePattern));
        expect(result).toBe('deep text');
    });

    test('clears the shared container when HTML normalization fails', async ({expect, window}) => {
        await verifyNormalizationFailureRecovery('html', {expect, window});
    });

    test('clears the shared container when text normalization fails', async ({expect, window}) => {
        await verifyNormalizationFailureRecovery('text', {expect, window});
    });

    test('plain structured text escapes markup and emits only controlled line breaks', async ({expect, window}) => {
        const renderer = new AnkiTemplateRenderer(window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
        await renderer.prepare();

        const node = window.document.createElement('div');
        const span = window.document.createElement('span');
        span.appendChild(window.document.createTextNode('safe & '));
        const bold = window.document.createElement('b');
        bold.appendChild(window.document.createTextNode('nested'));
        span.appendChild(bold);
        node.appendChild(span);
        const script = window.document.createElement('script');
        script.appendChild(window.document.createTextNode('alert(1)'));
        node.appendChild(script);
        const block = window.document.createElement('div');
        block.setAttribute('title', '>');
        block.appendChild(window.document.createTextNode('tail'));
        node.appendChild(block);
        node.appendChild(window.document.createTextNode('<script><img src=x onerror=alert(1)>'));
        const result = String(renderer._getText(node, renderer._structuredContentStyleApplier, renderer._structuredContentDatasetKeyIgnorePattern));

        expect(result).toBe('safe &amp; nestedalert(1)<br>\ntail&lt;script&gt;&lt;img src=x onerror=alert(1)&gt;');
        expect(result.match(/<[^>]*>/g)).toEqual(['<br>']);
    });

    /** @type {import('template-renderer').CompositeRenderData} */
    const data = {
        marker: 'test',
        commonData: {
            dictionaryEntry: {
                type: 'kanji',
                character: 'c',
                dictionary: 'dictionary',
                dictionaryIndex: 0,
                dictionaryAlias: 'dictionaryAlias',
                onyomi: [],
                kunyomi: [],
                tags: [],
                stats: {},
                definitions: [],
                frequencies: [],
            },
            resultOutputMode: 'split',
            cardFormat: {
                type: 'term',
                name: 'test',
                deck: 'deck',
                model: 'model',
                fields: {},
                icon: 'big-circle',
            },
            glossaryLayoutMode: 'default',
            compactTags: false,
            context: {
                url: 'http://localhost/',
                documentTitle: 'documentTitle',
                query: 'query',
                fullQuery: 'query.full',
                sentence: {
                    text: 'sentence.query.full',
                    offset: 9,
                },
            },
            media: void 0,
            dictionaryStylesMap: new Map(),
        },
    };
    const testCases = [
        {
            name: 'regexMatch 1',
            template: '{{#regexMatch "test" "gu"}}this is a test of regexMatch{{/regexMatch}}',
            result: 'test',
        },
        {
            name: 'regexMatch 2',
            template: '{{regexMatch "test" "gu" "this is a test of regexMatch"}}',
            result: 'test',
        },
        {
            name: 'regexMatch 3',
            template: '{{#if (regexMatch "test" "gu" "this is a test of regexMatch")}}true{{else}}false{{/if}}',
            result: 'true',
        },
        {
            name: 'regexReplace 1',
            template: '{{#regexReplace "test" "TEST" "gu"}}this is a test of regexReplace{{/regexReplace}}',
            result: 'this is a TEST of regexReplace',
        },
        {
            name: 'regexReplace 2',
            template: '{{regexReplace "test" "TEST" "gu" "this is a test of regexReplace"}}',
            result: 'this is a TEST of regexReplace',
        },
        {
            name: 'regexReplace 3',
            template: '{{#if (regexReplace "test" "" "gu" "test")}}true{{else}}false{{/if}}',
            result: 'false',
        },
    ];
    describe.each(testCases)('$name', ({template, result: expectedResult}) => {
        test('Test', ({expect, ankiTemplateRenderer}) => {
            const {result} = ankiTemplateRenderer.templateRenderer.render(template, data, 'ankiNote');
            expect(result).toEqual(expectedResult);
        });
    });
});
