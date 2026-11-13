/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, expect, test, vi} from 'vitest'
import {RequestBuilder} from '../ext/js/background/request-builder.js'

afterEach(() => { vi.restoreAllMocks() })

test.each([
    ['https://example.com/a*b.mp3', 'https://example.com/axb.mp3'],
    ['https://example.com/a|b.mp3', 'https://example.com/a%7Cb.mp3'],
    ['https://example.com/audio?term=a^b', 'https://example.com/audio?term=a/b'],
    ['https://example.com/a*(b)+[c].mp3?q=$5&other=1', 'https://example.com/axxbbcZmp3?q=$5&other=1'],
    ['https://例え.jp/音*声.mp3', 'https://例え.jp/音声.mp3'],
    ['https://commons.wikimedia.org/w/api.php?action=query&iiprop=user|url&origin=*', 'https://commons.wikimedia.org/w/api.php?action=query&iiprop=user%7Curl&origin=%2A'],
])('anonymous request rules match the literal URL %s', async (input, sibling) => {
    const builder = new RequestBuilder()
    const updates = vi.spyOn(builder, '_updateSessionRules').mockResolvedValue()
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('audio'))
    const url = new URL(input).href

    await builder.fetchAnonymous(input, {credentials: 'omit'})

    expect(request).toHaveBeenCalledWith(url, {credentials: 'omit'})
    const rule = updates.mock.calls[0][0].addRules?.[0]
    expect(rule).toBeDefined()
    const condition = /** @type {chrome.declarativeNetRequest.RuleCondition} */ (rule?.condition)
    expect(condition.urlFilter).toBeUndefined()
    expect(typeof condition.regexFilter).toBe('string')
    expect(condition.isUrlFilterCaseSensitive).toBe(true)
    const expression = new RegExp(/** @type {string} */ (condition.regexFilter))
    expect(expression.test(url)).toBe(true)
    expect(expression.test(new URL(sibling).href)).toBe(false)
    expect(expression.test(`${url}&extra=1`)).toBe(false)
    expect(expression.test(url.replace(/[|*^]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`))).toBe(false)
    expect(updates.mock.calls[1][0]).toEqual({removeRuleIds: [rule?.id]})
})

test('already encoded URLs keep their exact pattern and case', async () => {
    const builder = new RequestBuilder()
    const updates = vi.spyOn(builder, '_updateSessionRules').mockResolvedValue()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('audio'))
    const url = 'https://example.com/a%2Ab.mp3?token=CaseSensitive'

    await builder.fetchAnonymous(url, {})

    expect(updates.mock.calls[0][0].addRules?.[0].condition).toEqual({
        urlFilter: `|${url}|`,
        isUrlFilterCaseSensitive: true,
        resourceTypes: ['xmlhttprequest'],
    })
})
