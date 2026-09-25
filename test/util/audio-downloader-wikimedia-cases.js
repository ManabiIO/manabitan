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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {RequestBuilder} from '../../ext/js/background/request-builder.js'
import {AudioDownloader} from '../../ext/js/media/audio-downloader.js'

const language = {name: 'English', iso: 'en', iso639_3: 'eng', exampleText: 'example'}
/** @type {('wiktionary'|'lingua-libre')[]} */
const sourceTypes = ['wiktionary', 'lingua-libre']

/**
 * @param {unknown} data
 * @returns {Response}
 */
function jsonResponse(data) {
    return new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}})
}

/**
 * @param {import('node:test').TestContext} context
 * @param {{title: string, user: string, url: string}[]} entries
 * @param {boolean} [throughRequestBuilder]
 * @returns {{downloader: AudioDownloader, requests: URL[], builder: RequestBuilder}}
 */
function fixture(context, entries, throughRequestBuilder = false) {
    const builder = new RequestBuilder()
    /** @type {URL[]} */
    const requests = []
    /**
     * @param {RequestInfo|URL} input
     * @returns {Promise<Response>}
     */
    const fetchResponse = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(url)
        if (url.searchParams.get('list') === 'search') {
            return jsonResponse({query: {search: entries.map(({title}) => ({title}))}})
        }
        const entry = entries.find(({title}) => title === url.searchParams.get('titles'))
        if (typeof entry === 'undefined') {
            return jsonResponse({query: {pages: {'-1': {missing: ''}}}})
        }
        return jsonResponse({query: {pages: {'1': {imageinfo: [{url: entry.url, user: entry.user}]}}}})
    }
    if (throughRequestBuilder) {
        context.mock.method(builder, '_updateSessionRules', async () => {})
        context.mock.method(globalThis, 'fetch', fetchResponse)
    } else {
        context.mock.method(builder, 'fetchAnonymous', fetchResponse)
    }
    return {downloader: new AudioDownloader(builder), requests, builder}
}

/**
 * @param {'wiktionary'|'lingua-libre'} type
 * @param {string} term
 * @param {string} [user]
 * @returns {string}
 */
function titleFor(type, term, user = 'Speaker') {
    return type === 'wiktionary' ? `File:en-us-${term}.ogg` : `File:LL-Q1860 (eng)-${user}-${term}.wav`
}

for (const type of sourceTypes) {
    for (const term of ['word', 'C++', '(word)', 'a.b', 'a?', '[word]']) {
        test(`${type}: literal term ${JSON.stringify(term)} survives search and validation`, async (context) => {
            const entry = {title: titleFor(type, term), user: 'Speaker', url: 'https://upload.wikimedia.org/right-audio'}
            const {downloader} = fixture(context, [entry])
            const result = await downloader.getTermAudioInfoList({type, url: '', voice: ''}, term, '', language)
            assert.equal(result.length, 1)
            assert.equal(result[0].type, 'url')
            assert.equal(Reflect.get(result[0], 'url'), entry.url)
        })
    }

    for (const [term, wrongTerm] of [['a.b', 'axb'], ['a?', ''], ['(word)', 'word']]) {
        test(`${type}: ${JSON.stringify(term)} must not select ${JSON.stringify(wrongTerm)}`, async (context) => {
            const {downloader} = fixture(context, [{title: titleFor(type, wrongTerm), user: 'Speaker', url: 'https://upload.wikimedia.org/wrong-audio'}])
            const result = await downloader.getTermAudioInfoList({type, url: '', voice: ''}, term, '', language)
            assert.deepEqual(result, [])
        })
    }

    for (const term of ['A&B', '50%20', 'word+word']) {
        test(`${type}: file title ${JSON.stringify(term)} remains one exact query parameter`, async (context) => {
            const entry = {title: titleFor(type, term), user: 'Speaker', url: 'https://upload.wikimedia.org/right-audio'}
            const {downloader, requests} = fixture(context, [entry])
            await downloader.getTermAudioInfoList({type, url: '', voice: ''}, term, '', language)
            assert.equal(requests.length, 2)
            assert.equal(requests[1].searchParams.get('titles'), entry.title)
            assert.equal(requests[1].searchParams.get('prop'), 'imageinfo')
            assert.equal(requests[1].searchParams.get('iiprop'), 'user|url')
        })
    }

    test(`${type}: the CirrusSearch term is escaped before URL encoding`, async (context) => {
        const term = 'a.b+C?/@&~<>#"[]{}()|^$\\'
        // Explicit expected literal form, including Lucene operators absent from JavaScript regex.
        const escaped = 'a\\.b\\+C\\?\\/\\@\\&\\~\\<\\>\\#\\"\\[\\]\\{\\}\\(\\)\\|\\^\\$\\\\'
        const expected = type === 'wiktionary' ?
            `intitle:/en(-[a-zA-Z]{2})?-${escaped}[0123456789]*\\.ogg/i` :
            `intitle:/-${escaped}\\.wav/i incategory:"Lingua_Libre_pronunciation-eng"`
        const {downloader, requests} = fixture(context, [])
        await downloader.getTermAudioInfoList({type, url: '', voice: ''}, term, '', language)
        assert.equal(requests.length, 1)
        assert.equal(requests[0].searchParams.get('srsearch'), expected)
        assert.equal(requests[0].hash, '')
        assert.deepEqual([...requests[0].searchParams.keys()], ['action', 'format', 'list', 'srsearch', 'srnamespace', 'origin'])
    })

    test(`${type}: encoded parameters survive the actual RequestBuilder`, async (context) => {
        const term = 'A&B+50%'
        const entry = {title: titleFor(type, term), user: 'Speaker', url: 'https://upload.wikimedia.org/right-audio'}
        const {downloader, requests, builder} = fixture(context, [entry], true)
        const result = await downloader.getTermAudioInfoList({type, url: '', voice: ''}, term, '', language)
        assert.equal(result.length, 1)
        assert.equal(Reflect.get(result[0], 'url'), entry.url)
        assert.equal(requests[1].searchParams.get('titles'), entry.title)
        assert.equal(builder._ruleIds.size, 0)
    })
}

for (const user of ['A.B', 'Speaker (UK)', 'Speaker+', '[Speaker]']) {
    test(`Lingua Libre preserves literal uploader ${JSON.stringify(user)}`, async (context) => {
        const entry = {title: titleFor('lingua-libre', 'word', user), user, url: 'https://upload.wikimedia.org/right-audio'}
        const {downloader} = fixture(context, [entry])
        const result = await downloader.getTermAudioInfoList({type: 'lingua-libre', url: '', voice: ''}, 'word', '', language)
        assert.deepEqual(result, [{type: 'url', url: entry.url, name: user}])
    })
}

test('Lingua Libre uploader punctuation cannot match a different contributor', async (context) => {
    const {downloader} = fixture(context, [{title: titleFor('lingua-libre', 'word', 'AxB'), user: 'A.B', url: 'https://upload.wikimedia.org/wrong-audio'}])
    assert.deepEqual(await downloader.getTermAudioInfoList({type: 'lingua-libre', url: '', voice: ''}, 'word', '', language), [])
})

test('Wiktionary preserves case-insensitive matching, numeric suffixes and region labels', async (context) => {
    const entries = [
        {title: 'File:EN-us-WORD2.ogg', user: 'US speaker', url: 'https://upload.wikimedia.org/us'},
        {title: 'File:en-word.ogg', user: 'Speaker', url: 'https://upload.wikimedia.org/default'},
        {title: 'File:en-gb-word12.ogg', user: 'UK speaker', url: 'https://upload.wikimedia.org/uk'},
        {title: 'File:fr-word.ogg', user: 'Other language', url: 'https://upload.wikimedia.org/wrong'},
    ]
    const {downloader} = fixture(context, entries)
    assert.deepEqual(await downloader.getTermAudioInfoList({type: 'wiktionary', url: '', voice: ''}, 'word', '', language), [
        {type: 'url', url: entries[0].url, name: '(United States) US speaker'},
        {type: 'url', url: entries[1].url, name: 'Speaker'},
        {type: 'url', url: entries[2].url, name: '(United Kingdom) UK speaker'},
    ])
})

test('empty source results and lookup errors retain existing behavior', async (context) => {
    const {downloader, builder} = fixture(context, [])
    assert.deepEqual(await downloader.getTermAudioInfoList({type: 'wiktionary', url: '', voice: ''}, 'word', '', language), [])
    context.mock.method(builder, 'fetchAnonymous', async () => { throw new Error('Unavailable') })
    assert.deepEqual(await downloader.getTermAudioInfoList({type: 'wiktionary', url: '', voice: ''}, 'word', '', language), [])
})
