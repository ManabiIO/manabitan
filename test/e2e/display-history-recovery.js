/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'

/**
 * Exercise native history serialization and reload with an actual search-page
 * Display and entries returned by the installed dictionaries. The temporary
 * wrapper only captures the existing Display; it does not replace rendering,
 * history, lookup, or browser navigation.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} extensionBaseUrl
 * @param {string} query
 * @returns {Promise<{scannerEntries: number, restoredEntries: number, previewEntries: number}>}
 */
export async function verifyScannerHistoryRecovery(context, extensionBaseUrl, query) {
    const page = await context.newPage()
    try {
        await page.goto(`${extensionBaseUrl}/search.html`, {waitUntil: 'domcontentloaded'})
        await waitForDisplayReady(page)
        const original = await page.evaluate(async (query) => {
            // @ts-expect-error - This module URL resolves inside the installed extension.
            const {Display} = await import('/js/display/display.js')
            /** @type {{display: import('../../ext/js/display/display.js').Display|null, completion: Promise<import('display').ContentCompletion>|null}} */
            const captured = {display: null, completion: null}
            const setContent = Display.prototype.setContent
            Display.prototype.setContent = function captureDisplay(/** @type {import('display').ContentDetails} */ details) {
                captured.display = this
                captured.completion = setContent.call(this, details)
                return captured.completion
            }
            try {
                const debugApi = Reflect.get(globalThis, '__manabitanSearchDebugApi')
                const result = debugApi.triggerSearch(query, {animate: false, lookup: true})
                if (!result.ok) { throw new Error(`Initial history lookup failed: ${result.error}`) }
            } finally {
                Display.prototype.setContent = setContent
            }
            const {display, completion} = captured
            if (display === null || completion === null || await completion !== 'completed') {
                throw new Error('The initial search did not publish its dictionary content')
            }
            const dictionaryEntries = display.dictionaryEntries
            if (dictionaryEntries.length === 0) { throw new Error('The history witness requires an imported dictionary match') }
            // This is the scanner publication contract: the lookup has already
            // completed, and its entries are supplied with lookup=false.
            const result = await display.setContent({
                focus: false,
                historyMode: 'new',
                params: {type: 'terms', query: display.query, lookup: 'false', wildcards: 'off'},
                state: structuredClone(display.history.state),
                content: {dictionaryEntries, contentOrigin: display.getContentOrigin()},
            })
            if (result !== 'completed') { throw new Error('Scanner history publication did not complete') }
            return {
                entryCount: document.querySelectorAll('#dictionary-entries .entry').length,
                headwords: [...document.querySelectorAll('#dictionary-entries .headword-term')].map((node) => node.textContent),
                lookup: new URL(location.href).searchParams.get('lookup'),
                serializedState: JSON.stringify(history.state),
            }
        }, query)
        assert.ok(original.entryCount > 0, 'The scanner publication must render actual dictionary entries')
        assert.ok(original.headwords.length > 0, 'The scanner publication must render headwords')
        assert.equal(original.lookup, 'false')
        assert.ok(!original.serializedState.includes('definitions'), 'History must not serialize the dictionary payload')

        await page.reload({waitUntil: 'domcontentloaded'})
        await waitForDisplayReady(page)
        const restored = await page.evaluate(() => ({
            entryCount: document.querySelectorAll('#dictionary-entries .entry').length,
            headwords: [...document.querySelectorAll('#dictionary-entries .headword-term')].map((node) => node.textContent),
        }))
        assert.equal(restored.entryCount, original.entryCount, 'Reload must reconstruct scanner dictionary entries')
        assert.deepEqual(restored.headwords, original.headwords, 'Reload must restore the same lookup headwords')

        // A deliberate no-lookup preview uses the same query without supplied
        // results. Reload must preserve that distinct intent.
        await page.evaluate((query) => {
            const result = Reflect.get(globalThis, '__manabitanSearchDebugApi').triggerSearch(query, {animate: false, historyMode: 'overwrite', lookup: false})
            if (!result.ok) { throw new Error(`Preview setup failed: ${result.error}`) }
        }, query)
        await page.waitForFunction(() => (
            new URL(location.href).searchParams.get('lookup') === 'false' &&
            history.state?.dictionaryEntriesRestorable === false &&
            document.querySelectorAll('#dictionary-entries .entry').length === 0
        ), null, {timeout: 10000})
        await page.reload({waitUntil: 'domcontentloaded'})
        await waitForDisplayReady(page)
        const previewEntries = await page.locator('#dictionary-entries .entry').count()
        assert.equal(previewEntries, 0, 'Reload must keep an explicit no-lookup preview empty')
        return {scannerEntries: original.entryCount, restoredEntries: restored.entryCount, previewEntries}
    } finally {
        await page.close()
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function waitForDisplayReady(page) {
    await page.waitForFunction(() => (
        document.documentElement.dataset.loaded === 'true' ||
        document.documentElement.dataset.loadError === 'true'
    ), null, {timeout: 30000})
    assert.equal(await page.evaluate(() => document.documentElement.dataset.loadError), void 0, 'The search page must initialize successfully')
}
