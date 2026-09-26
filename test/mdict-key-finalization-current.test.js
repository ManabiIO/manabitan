/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest'
import {finalizeMdictKeywordList} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdict-base.js'

/**
 * @param {Array<[string, number]>} entries
 * @returns {Array<{keyText: string, recordStartOffset: number, recordEndOffset: number}>}
 */
function createKeywords(entries) {
    return entries.map(([keyText, recordStartOffset]) => ({
        keyText,
        recordStartOffset,
        recordEndOffset: -1,
    }))
}

describe('MDict keyword finalization', () => {
    test('uses the next distinct record offset for shared records', () => {
        const keywords = createKeywords([
            ['alpha', 0],
            ['alias', 0],
            ['beta', 10],
            ['gamma', 20],
            ['gamma alias', 20],
        ])
        finalizeMdictKeywordList(keywords, 30)
        expect(Object.fromEntries(keywords.map(({keyText, recordEndOffset}) => [keyText, recordEndOffset]))).toEqual({
            alpha: 10,
            alias: 10,
            beta: 20,
            gamma: 30,
            'gamma alias': 30,
        })
    })

    test('sorts unusual lexical order without changing physical record boundaries', () => {
        const keywords = createKeywords([['zeta', 0], ['alpha', 10], ['mu', 20]])
        finalizeMdictKeywordList(keywords, 30)
        expect(keywords.map(({keyText}) => keyText)).toEqual(['alpha', 'mu', 'zeta'])
        expect(Object.fromEntries(keywords.map(({keyText, recordEndOffset}) => [keyText, recordEndOffset]))).toEqual({
            alpha: 20,
            mu: 30,
            zeta: 10,
        })
    })

    test('retains the numeric-boundary fallback for non-monotonic offsets', () => {
        const keywords = createKeywords([['zeta', 20], ['alpha', 0], ['mu', 10]])
        finalizeMdictKeywordList(keywords, 30)
        expect(keywords.map(({keyText}) => keyText)).toEqual(['alpha', 'mu', 'zeta'])
        expect(Object.fromEntries(keywords.map(({keyText, recordEndOffset}) => [keyText, recordEndOffset]))).toEqual({
            alpha: 10,
            mu: 20,
            zeta: 30,
        })
    })

    test('accepts an empty dictionary', () => {
        const keywords = createKeywords([])
        finalizeMdictKeywordList(keywords, 0)
        expect(keywords).toEqual([])
    })
})
