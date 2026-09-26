/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {expect, test} from '@playwright/test'

const moduleSource = readFileSync(new URL('../../ext/js/dom/document-focus-controller.js', import.meta.url), 'utf8')
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`

/**
 * Load the actual controller in a child document, but defer prepare until the
 * host is accepting input. This makes the prewarm race deterministic.
 * @param {import('@playwright/test').Page} page
 * @param {string} style
 * @returns {Promise<import('@playwright/test').Frame>}
 */
async function createChild(page, style) {
    await page.setContent('<input id="host-input"><iframe name="focus-child"></iframe>')
    await page.locator('iframe').evaluate((node, frameStyle) => {
        const frame = /** @type {HTMLIFrameElement} */ (node)
        frame.style.cssText = frameStyle
        frame.srcdoc = '<div id="content-scroll-focus" tabindex="-1">scroll target</div><input id="child-input">'
    }, style)
    await expect(page.frameLocator('iframe').locator('#content-scroll-focus')).toBeAttached()
    const frame = page.frame({name: 'focus-child'})
    if (frame === null) { throw new Error('Missing child frame') }
    await frame.evaluate(async (url) => {
        // eslint-disable-next-line no-unsanitized/method -- The data URL contains only the checked-in production module.
        const {DocumentFocusController} = await import(url)
        Reflect.set(globalThis, 'focusController', new DocumentFocusController('#child-input'))
    }, moduleUrl)
    await page.locator('#host-input').focus()
    return frame
}

for (const [name, style] of [
    ['visible', ''],
    ['hidden', 'visibility:hidden'],
    ['zero-sized', 'width:0;height:0'],
]) {
    test(`passive ${name} frame initialization preserves host focus and typing`, async ({page}) => {
        const frame = await createChild(page, style)
        expect(await frame.evaluate(() => document.hasFocus())).toBe(false)
        await frame.evaluate(() => Reflect.get(globalThis, 'focusController').prepare())
        await expect(page.locator('#host-input')).toBeFocused()
        await page.keyboard.insertText('日本語')
        await expect(page.locator('#host-input')).toHaveValue('日本語')
    })
}

test('passive initialization preserves the host selection', async ({page}) => {
    const frame = await createChild(page, 'visibility:hidden')
    await page.locator('#host-input').fill('selected text')
    await page.locator('#host-input').evaluate((node) => {
        const input = /** @type {HTMLInputElement} */ (node)
        input.setSelectionRange(1, 8)
    })
    await frame.evaluate(() => Reflect.get(globalThis, 'focusController').prepare())
    await expect(page.locator('#host-input')).toBeFocused()
    expect(await page.locator('#host-input').evaluate((node) => {
        const input = /** @type {HTMLInputElement} */ (node)
        return [input.selectionStart, input.selectionEnd]
    })).toEqual([1, 8])
})

test('activating a prepared frame retains editable and scrollbar focus', async ({page}) => {
    const frame = await createChild(page, '')
    await frame.evaluate(() => Reflect.get(globalThis, 'focusController').prepare())
    await frame.locator('#child-input').click()
    await expect(frame.locator('#child-input')).toBeFocused()
    await page.keyboard.insertText('child text')
    await expect(frame.locator('#child-input')).toHaveValue('child text')
    await frame.evaluate(() => {
        Reflect.get(globalThis, 'focusController').blurElement(document.querySelector('#child-input'))
    })
    await expect(frame.locator('#content-scroll-focus')).toBeFocused()
})

test('explicit autofocus can still activate another document', async ({page}) => {
    const frame = await createChild(page, '')
    await frame.evaluate(() => Reflect.get(globalThis, 'focusController').prepare())
    await frame.evaluate(() => Reflect.get(globalThis, 'focusController').focusElement())
    await expect(frame.locator('#child-input')).toBeFocused()
})
