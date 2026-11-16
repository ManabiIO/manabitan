/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {expect} from 'vitest'
import {DisplayGenerator} from '../ext/js/display/display-generator.js'
import {distributeFurigana, distributeFuriganaInflected} from '../ext/js/language/ja/japanese.js'
import {createAnkiTemplateRendererTest} from './fixtures/anki-template-renderer-test.js'

const test = await createAnkiTemplateRendererTest()
const template = readFileSync(new URL('../ext/data/templates/default-anki-field-templates.handlebars', import.meta.url), 'utf8')

/**
 * @param {string} term
 * @param {string} reading
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function createEntry(term, reading) {
    return {
        type: 'term',
        isPrimary: true,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: [],
        score: 0,
        frequencyOrder: 0,
        dictionaryIndex: 0,
        dictionaryAlias: 'Unicode',
        sourceTermExactMatchCount: 1,
        matchPrimaryReading: true,
        maxOriginalTextLength: term.length,
        headwords: [{
            index: 0,
            headwordIndex: 0,
            term,
            reading,
            tags: [],
            wordClasses: [],
            sources: [{originalText: term, transformedText: term, deinflectedText: term, matchType: 'exact', matchSource: 'term', isPrimary: true}],
        }],
        definitions: [],
        pronunciations: [],
        frequencies: [],
    }
}

const cases = [
    {
        term: '葛\u{e0100}の葉',
        reading: 'くずのは',
        html: '<ruby>葛\u{e0100}<rt>くず</rt></ruby>の<ruby>葉<rt>は</rt></ruby>',
        plain: '葛\u{e0100}[くず]の 葉[は]',
        segments: [{text: '葛\u{e0100}', reading: 'くず'}, {text: 'の', reading: ''}, {text: '葉', reading: 'は'}],
    },
    {
        term: '辻\u{e0100}斬り',
        reading: 'つじぎり',
        html: '<ruby>辻\u{e0100}斬<rt>つじぎ</rt></ruby>り',
        plain: '辻\u{e0100}斬[つじぎ]り',
        segments: [{text: '辻\u{e0100}斬', reading: 'つじぎ'}, {text: 'り', reading: ''}],
    },
    {
        term: '煮\ufe00る',
        reading: 'にる',
        html: '<ruby>煮\ufe00<rt>に</rt></ruby>る',
        plain: '煮\ufe00[に]る',
        segments: [{text: '煮\ufe00', reading: 'に'}, {text: 'る', reading: ''}],
    },
    {
        // U+2F8CC is the supplementary compatibility form of 書.
        term: '\u{2f8cc}く',
        reading: 'かく',
        html: '<ruby>\u{2f8cc}<rt>か</rt></ruby>く',
        plain: '\u{2f8cc}[か]く',
        segments: [{text: '\u{2f8cc}', reading: 'か'}, {text: 'く', reading: ''}],
    },
]

for (const {term, reading, html, plain, segments} of cases) {
    test(`dictionary headword furigana preserves the spelling and separates kana: ${term}`, async ({window}) => {
        const generator = new DisplayGenerator(/** @type {any} */ ({}), null)
        await generator.prepare()
        const node = generator.createTermEntry(createEntry(term, reading), [])
        window.document.body.append(node)
        const headword = /** @type {HTMLElement} */ (node.querySelector('.headword-term'))
        expect(headword).not.toBeNull()
        // Remove the lookup-link wrappers to compare the actual ruby boundaries.
        for (const link of headword.querySelectorAll('a')) { link.replaceWith(...link.childNodes) }
        expect(headword.innerHTML).toBe(html)
        expect(distributeFurigana(term, reading)).toEqual(segments)
    })

    test(`shipped Anki furigana templates preserve Unicode spellings: ${term}`, ({ankiTemplateRenderer}) => {
        /** @type {import('anki-templates-internal').CreateDetails} */
        const commonData = {
            dictionaryEntry: createEntry(term, reading),
            cardFormat: {type: 'term', name: 'Unicode', deck: 'Japanese', model: 'Basic', fields: {}, icon: 'big-circle'},
            resultOutputMode: 'split',
            glossaryLayoutMode: 'default',
            compactTags: false,
            context: {url: '', sentence: {text: term, offset: 0}, documentTitle: '', query: term, fullQuery: term},
            media: {},
            dictionaryStylesMap: new Map(),
        }
        expect(ankiTemplateRenderer.templateRenderer.render(template, {marker: 'furigana', commonData}, 'ankiNote').result).toBe(html)
        expect(ankiTemplateRenderer.templateRenderer.render(template, {marker: 'furigana-plain', commonData}, 'ankiNote').result).toBe(plain)
    })
}

test('inflected variant spellings retain furigana on the unchanged stem', () => {
    expect(distributeFuriganaInflected('煮\ufe00る', 'にる', '煮\ufe00た')).toEqual([
        {text: '煮\ufe00', reading: 'に'}, {text: 'た', reading: ''},
    ])
})

test('variation selectors do not resolve otherwise ambiguous furigana', () => {
    expect(distributeFurigana('飼\u{e0100}い犬', 'かいいぬ')).toEqual([
        {text: '飼\u{e0100}い犬', reading: 'かいいぬ'},
    ])
})
