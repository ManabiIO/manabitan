/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'

/**
 * Exercise source-tab ownership with real browser activation and capture APIs.
 * Only popup visibility acknowledgements are controlled by the fixture.
 * @param {import('@playwright/test').Page} page
 * @param {string} fixtureUrl
 * @returns {Promise<{inactiveRejected: boolean, switchedRejected: boolean, stableCaptured: boolean, visibilityRestorations: number}>}
 */
export async function verifyAnkiScreenshotOwnership(page, fixtureUrl) {
    const sourcePage = await page.context().newPage()
    let otherPage = null
    try {
        otherPage = await page.context().newPage()
        const sourceUrl = fixtureUrl + '#screenshot-source'
        const otherUrl = fixtureUrl + '#screenshot-other'
        await sourcePage.goto(sourceUrl)
        await otherPage.goto(otherUrl)
        const result = await page.evaluate(async ({sourceUrl: source, otherUrl: other}) => {
            const {Backend} = /** @type {typeof import('../../ext/js/background/backend.js')} */ (
                // @ts-expect-error - Chromium resolves this extension-root module path.
                await import('/js/background/backend.js')
            )
            const tabs = await chrome.tabs.query({})
            const sourceTab = tabs.find((tab) => tab.url === source)
            const otherTab = tabs.find((tab) => tab.url === other)
            if (typeof sourceTab?.id !== 'number' || typeof otherTab?.id !== 'number') {
                throw new Error('Screenshot fixture tabs were not found')
            }
            const sourceId = sourceTab.id
            const otherId = otherTab.id
            const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype))
            let switchDuringHide = false
            let visibilityRestorations = 0
            Reflect.set(backend, '_sendMessageTabPromise', async (_tabId, message) => {
                if (message.action === 'frontendSetAllVisibleOverride') {
                    if (switchDuringHide) { await chrome.tabs.update(otherId, {active: true}) }
                    return 'screenshot-visibility-token'
                }
                if (message.action === 'frontendClearAllVisibleOverride') { visibilityRestorations++ }
                return void 0
            })
            const capture = () => backend._getScreenshot(sourceId, 0, 'png', 90)
            await chrome.tabs.update(otherId, {active: true})
            let inactiveRejected = false
            try { await capture() } catch (error) {
                inactiveRejected = error instanceof Error && /source tab/.test(error.message)
            }
            await chrome.tabs.update(sourceId, {active: true})
            const screenshot = await capture()
            const stableCaptured = screenshot.startsWith('data:image/png;base64,') && screenshot.length > 100
            switchDuringHide = true
            let switchedRejected = false
            try { await capture() } catch (error) {
                switchedRejected = error instanceof Error && /source tab/.test(error.message)
            }
            return {inactiveRejected, switchedRejected, stableCaptured, visibilityRestorations}
        }, {sourceUrl, otherUrl})
        assert.equal(result.inactiveRejected, true, 'An inactive source must not capture the active tab')
        assert.equal(result.stableCaptured, true, 'The active source must still produce a real screenshot')
        assert.equal(result.switchedRejected, true, 'A tab switch during popup hiding must abort the screenshot')
        assert.equal(result.visibilityRestorations, 2, 'Both accepted visibility overrides must be released')
        return result
    } finally {
        await sourcePage.close()
        if (otherPage !== null) { await otherPage.close() }
        await page.bringToFront()
    }
}
