/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {expect, vi} from 'vitest';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {createDomTest} from './fixtures/dom-test.js';
import {fetch} from './mocks/common.js';
import {getTemplateRenderResults} from './utilities/anki.js';

vi.stubGlobal('fetch', fetch);
const test = createDomTest();
const schema = new JsonSchema(/** @type {import('ext/json-schema').Schema} */ (JSON.parse(readFileSync(new URL('../ext/data/schemas/dictionary-term-bank-v3-schema.json', import.meta.url), 'utf8'))));
const template = readFileSync(new URL('../ext/data/templates/default-anki-field-templates.handlebars', import.meta.url), 'utf8');

/**
 * @param {import('dictionary-data').TermGlossaryContent} content
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function entry(content) {
    return {
        type: 'term',
        isPrimary: true,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: [],
        score: 0,
        frequencyOrder: 0,
        dictionaryIndex: 0,
        dictionaryAlias: 'Glossary fixture',
        sourceTermExactMatchCount: 1,
        matchPrimaryReading: true,
        maxOriginalTextLength: 1,
        headwords: [{index: 0, headwordIndex: 0, term: '語', reading: 'ご', sources: [{originalText: '語', transformedText: '語', deinflectedText: '語', matchType: 'exact', matchSource: 'term', isPrimary: true}], tags: [], wordClasses: []}],
        definitions: [{index: 0, headwordIndices: [0], dictionary: 'Glossary fixture', dictionaryIndex: 0, dictionaryAlias: 'Glossary fixture', id: 1, score: 0, frequencyOrder: 0, sequences: [-1], isPrimary: true, tags: [], entries: [content]}],
        pronunciations: [],
        frequencies: [],
    };
}

/** @type {import('settings').ResultOutputMode[]} */
const modes = ['split', 'group', 'merge'];
for (const mode of modes) {
    test('selected glossary text remains literal in shipped plain markers: ' + mode, async ({window}) => {
        const literal = '<b data-canary="dictionary-text">literal</b> &lt;word&gt; &amp;';
        /** @type {import('dictionary-data').TermGlossaryStructuredContent} */
        const content = {type: 'structured-content',
            content: [
                {tag: 'span', content: 'excluded metadata'},
                {tag: 'div', data: {content: 'glossary'}, content: [literal, {tag: 'span', content: 'second meaning'}]},
            ]};
        expect(() => schema.validate([['語', 'ご', '', '', 0, [content], 1, '']])).not.toThrow();
        const [fields] = await getTemplateRenderResults([entry(content)], mode, template, expect);
        for (const marker of ['glossary-plain', 'glossary-plain-no-dictionary']) {
            const node = window.document.createElement('div');
            // Parse the generated Anki field to assert dictionary text cannot become markup.
            // eslint-disable-next-line no-unsanitized/property
            node.innerHTML = fields[marker];
            expect(node.querySelector('b')).toBeNull();
            expect(node.textContent).toContain(literal);
            expect(node.textContent).toContain('second meaning');
            expect(node.textContent).not.toContain('excluded metadata');
            expect(fields[marker]).toContain('<br>');
        }
    });

    test('mixed selected text and ruby are escaped exactly once: ' + mode, async ({window}) => {
        /** @type {import('dictionary-data').TermGlossaryStructuredContent} */
        const content = {type: 'structured-content',
            content: {tag: 'div',
                data: {content: 'glossary'},
                content: [
                    '<raw> &lt;literal&gt;',
                    {tag: 'ruby', content: ['語<&>', {tag: 'rt', content: 'ご&<>'}]},
                ]}};
        const [fields] = await getTemplateRenderResults([entry(content)], mode, template, expect);
        const node = window.document.createElement('div');

        // eslint-disable-next-line no-unsanitized/property -- Inspect generated field markup.
        node.innerHTML = fields['glossary-plain-no-dictionary'];
        expect(node.querySelector('raw')).toBeNull();
        expect(node.textContent).toContain('<raw> &lt;literal&gt;');
        expect(node.textContent).toContain('語<&>[ご&<>]');
        expect(node.textContent).not.toContain('&amp;');
    });
}

for (const object of [false, true]) {
    test('ordinary glossary text preserves literal entities: object=' + object, async ({window}) => {
        const literal = '&lt;word&gt; &amp; &#12354; <raw>';
        const content = object ? {type: 'text', text: literal} : literal;
        const [fields] = await getTemplateRenderResults([entry(/** @type {import('dictionary-data').TermGlossaryContent} */ (content))], 'split', template, expect);
        for (const marker of ['glossary', 'glossary-plain', 'glossary-plain-no-dictionary']) {
            const node = window.document.createElement('div');
            // Parse the generated Anki field to assert dictionary text cannot become markup.
            // eslint-disable-next-line no-unsanitized/property
            node.innerHTML = fields[marker];
            expect(node.querySelector('raw')).toBeNull();
            expect(node.textContent).toContain(literal);
        }
    });
}

// The fallback uses DOM text serialization rather than the selected-glossary path.
test('unmarked structured glossary keeps its existing safe text and line breaks', async ({window}) => {
    const [fields] = await getTemplateRenderResults([entry({type: 'structured-content', content: {tag: 'div', content: ['<raw> &lt;literal&gt;', {tag: 'br'}, 'tail']}})], 'split', template, expect);
    const node = window.document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property -- Inspect generated field markup.
    node.innerHTML = fields['glossary-plain-no-dictionary'];
    expect(node.querySelector('raw')).toBeNull();
    expect(node.textContent).toContain('<raw> &lt;literal&gt;');
    expect(fields['glossary-plain-no-dictionary']).toContain('<br>');
    expect(node.textContent).toContain('tail');
});


test('shipped glossary retains nested image descriptions and alternative text', async ({window}) => {
    const content = /** @type {import('dictionary-data').TermGlossaryStructuredContent} */ ({type: 'structured-content', content: {tag: 'img', path: 'picture.png', alt: 'A <red> bridge', description: 'The bridge & river\nSecond line'}});
    expect(() => schema.validate([['語', 'ご', '', '', 0, [content], 1, '']])).not.toThrow();
    const [fields] = await getTemplateRenderResults([entry(content)], 'split', template, expect);
    const node = window.document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property -- Inspect generated field markup.
    node.innerHTML = fields.glossary;
    expect(node.querySelector('img')?.getAttribute('alt')).toBe('A <red> bridge');
    expect(node.textContent).toContain('The bridge & river');
    expect(node.textContent).toContain('Second line');
    expect(node.querySelectorAll('br').length).toBeGreaterThan(0);
    expect(node.querySelector('red')).toBeNull();
});
