/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'

/**
 * Check production rules with Chromium's matcher without contacting providers.
 * Only the final fetch is replaced; registration, matching, and cleanup use
 * the extension's real declarativeNetRequest APIs.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{cases: number, exactMatches: number, siblingMatches: number}>}
 */
export async function verifyAnonymousRequestRuleMatching(page) {
    const observations = await page.evaluate(async () => {
        const {RequestBuilder} = /** @type {typeof import('../../ext/js/background/request-builder.js')} */ (
            // @ts-expect-error - Chromium resolves this extension-root module path.
            await import('/js/background/request-builder.js')
        )
        const builder = new RequestBuilder()
        const ruleId = 900_001
        builder._getNewRuleId = () => ruleId
        const cases = [
            {url: 'https://example.com/a*b.mp3', sibling: 'https://example.com/axb.mp3'},
            {url: 'https://example.com/a|b.mp3', sibling: 'https://example.com/a%7Cb.mp3'},
            {url: 'https://example.com/audio?term=a^b', sibling: 'https://example.com/audio?term=a/b'},
            {url: 'https://example.com/a*(b)+[c].mp3?q=$5', sibling: 'https://example.com/a%2A(b)+[c].mp3?q=$5'},
            {url: 'https://commons.wikimedia.org/w/api.php?action=query&iiprop=user|url&origin=*', sibling: 'https://commons.wikimedia.org/w/api.php?action=query&iiprop=user%7Curl&origin=%2A'},
            {url: 'https://example.com/a%2Ab.mp3?token=CaseSensitive', sibling: 'https://example.com/a%2Ab.mp3?token=casesensitive'},
        ]
        /** @type {{url: string, exact: boolean, sibling: boolean, extra: boolean, removed: boolean}[]} */
        const results = []
        const originalFetch = globalThis.fetch
        try {
            for (const {url, sibling} of cases) {
                /** @type {{url: string, exact: boolean, sibling: boolean, extra: boolean, removed: boolean}|null} */
                let result = null
                globalThis.fetch = async (input) => {
                    if (typeof input !== 'string') { throw new Error('Expected a serialized request URL') }
                    /**
                     * @param {string} candidate
                     * @returns {Promise<boolean>}
                     */
                    const matches = async (candidate) => {
                        const outcome = await chrome.declarativeNetRequest.testMatchOutcome({url: candidate, type: 'xmlhttprequest'})
                        return outcome.matchedRules.some((rule) => rule.ruleId === ruleId)
                    }
                    result = {
                        url: input,
                        exact: await matches(input),
                        sibling: await matches(sibling),
                        extra: await matches(`${input}&extra=1`),
                        removed: false,
                    }
                    return new Response('fixture audio')
                }
                await builder.fetchAnonymous(url, {credentials: 'omit'})
                if (result === null) { throw new Error('Fetch was not reached') }
                const observation = /** @type {{url: string, exact: boolean, sibling: boolean, extra: boolean, removed: boolean}} */ (result)
                const rules = await chrome.declarativeNetRequest.getSessionRules()
                observation.removed = !rules.some((rule) => rule.id === ruleId)
                results.push(observation)
            }
            return results
        } finally {
            globalThis.fetch = originalFetch
            await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [ruleId]})
        }
    })
    for (const observation of observations) {
        assert.equal(observation.exact, true, `The header rule must match ${observation.url}`)
        assert.equal(observation.sibling, false, `The header rule must not match a sibling of ${observation.url}`)
        assert.equal(observation.extra, false, `The header rule must not match extra URL characters after ${observation.url}`)
        assert.equal(observation.removed, true, `The header rule must be removed after ${observation.url}`)
    }
    return {cases: observations.length, exactMatches: observations.filter(({exact}) => exact).length, siblingMatches: observations.filter(({sibling}) => sibling).length}
}
