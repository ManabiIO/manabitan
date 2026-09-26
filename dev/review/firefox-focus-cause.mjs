/* SPDX-License-Identifier: GPL-3.0-or-later */
import {execFileSync} from 'node:child_process'
import {writeFileSync, mkdirSync} from 'node:fs'
import {firefox, chromium} from '@playwright/test'

const variants = {
    original: '384d1c97dae6bd17555973b77ad415e038438499',
    guard: '508e2e9c0e24102cbcb4d41fa448bfd80fb189e2',
    deferred: 'c1eecc36455c368c636df7d3d8c1a88fe1bc6eb8',
    noListener: 'c1eecc36455c368c636df7d3d8c1a88fe1bc6eb8',
    none: null,
}
const report = {cases: []}
for (const [engine, browserType] of Object.entries({firefox, chromium})) {
    const browser = await browserType.launch({headless: true})
    try {
        for (const [variant, ref] of Object.entries(variants)) {
            for (const action of ['click', 'explicit']) {
                const context = await browser.newContext()
                const page = await context.newPage()
                const events = []
                await context.exposeBinding('captureFocus', ({frame}, value) => { events.push({frameUrl: frame.url(), ...value}) })
                const install = () => {
                    const capture = (kind, detail = {}) => {
                        void globalThis.captureFocus({kind, active: document.activeElement?.outerHTML, focused: document.hasFocus(), stack: new Error().stack, ...detail})
                    }
                    for (const type of ['focus', 'blur', 'input', 'click', 'mousedown', 'mouseup']) {
                        window.addEventListener(type, event => capture(type, {target:event.target?.outerHTML, trusted:event.isTrusted}), true)
                    }
                    const original = HTMLElement.prototype.focus
                    HTMLElement.prototype.focus = function (...args) {
                        capture('focus-call', {target:this.outerHTML})
                        const result = Reflect.apply(original, this, args)
                        capture('focus-return', {target:this.outerHTML})
                        return result
                    }
                    globalThis.captureState = capture
                }
                await context.addInitScript(install)
                await page.evaluate(install)
                await page.setContent('<input id="host-input"><iframe name="focus-child"></iframe>')
                await page.locator('iframe').evaluate(frame => {
                    frame.srcdoc = '<div id="content-scroll-focus" tabindex="-1">scroll target</div><input id="child-input">'
                })
                const frame = page.frame({name:'focus-child'})
                await frame.locator('#child-input').waitFor({state:'visible'})
                if (ref) {
                    const source = execFileSync('git',['show',`${ref}:ext/js/dom/document-focus-controller.js`])
                    const url = `data:text/javascript;base64,${source.toString('base64')}`
                    await frame.evaluate(async ({url,variant}) => {
                        const {DocumentFocusController} = await import(url)
                        const controller = new DocumentFocusController('#child-input')
                        const update = controller._updateFocusedElement
                        controller._updateFocusedElement = function (...args) {
                            globalThis.captureState('controller-update-before')
                            const result = Reflect.apply(update,this,args)
                            globalThis.captureState('controller-update-after')
                            return result
                        }
                        if (variant === 'noListener') controller._onWindowFocus = () => globalThis.captureState('disabled-listener')
                        globalThis.focusController = controller
                    }, {url,variant})
                }
                await page.locator('#host-input').focus()
                if (ref) await frame.evaluate(() => globalThis.focusController.prepare())
                if (action === 'click') await frame.locator('#child-input').click()
                else await frame.evaluate(() => globalThis.focusController ? globalThis.focusController.focusElement() : document.querySelector('#child-input').focus())
                const snapshot = async () => ({
                    host: await page.evaluate(() => ({active:document.activeElement?.outerHTML,focused:document.hasFocus(), value:document.querySelector('#host-input')?.value})),
                    child: await frame.evaluate(() => ({active:document.activeElement?.outerHTML,focused:document.hasFocus(), value:document.querySelector('#child-input')?.value, intended:globalThis.focusController?._autofocusElement?.outerHTML})),
                })
                const immediate = await snapshot()
                await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
                await page.keyboard.insertText('typed')
                const settled = await snapshot()
                report.cases.push({engine,version:browser.version(),variant,action,immediate,settled,events})
                await context.close()
            }
        }
    } finally { await browser.close() }
}
mkdirSync('builds/firefox-cause',{recursive:true})
writeFileSync('builds/firefox-cause/cases.json',JSON.stringify(report,null,2))
for (const c of report.cases) console.log(JSON.stringify({engine:c.engine,variant:c.variant,action:c.action,immediate:c.immediate,settled:c.settled}))
