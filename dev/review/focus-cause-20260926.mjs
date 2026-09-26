/* SPDX-License-Identifier: GPL-3.0-or-later */
import fs from 'node:fs'
import path from 'node:path'

const observations = new WeakMap()

export async function installFocusProbe(context, page, testInfo) {
    const rows = []
    observations.set(context, rows)
    await context.exposeBinding('__recordFocusCause', ({frame}, value) => {
        if (rows.length < 4000) rows.push({receivedAt: Date.now(), frameUrl: frame.url(), ...value})
    })
    await context.addInitScript(() => {
        const describe = (node) => node instanceof Element ? {
            tag: node.tagName, id: node.id, cls: String(node.className),
            src: node instanceof HTMLIFrameElement ? node.src : undefined,
            html: node.outerHTML.slice(0, 280), connected: node.isConnected,
        } : String(node)
        const record = (kind, detail = {}) => {
            void globalThis.__recordFocusCause({
                kind, at: performance.timeOrigin + performance.now(), url: location.href,
                top: window === window.top, focused: document.hasFocus(),
                active: describe(document.activeElement),
                ready: document.readyState, loaded: document.documentElement?.dataset.loaded,
                ...detail,
            }).catch(() => {})
        }
        for (const type of ['focus', 'blur', 'input', 'beforeinput', 'change', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'pagehide', 'pageshow', 'visibilitychange']) {
            window.addEventListener(type, (event) => record(`event:${type}`, {
                target: describe(event.target), related: describe(event.relatedTarget),
                trusted: event.isTrusted, value: event.target?.value,
                key: event.key, stack: new Error().stack,
            }), true)
        }
        for (const name of ['focus', 'blur']) {
            const original = HTMLElement.prototype[name]
            HTMLElement.prototype[name] = function (...args) {
                record(`element:${name}`, {target: describe(this), stack: new Error().stack})
                return Reflect.apply(original, this, args)
            }
            const originalWindow = window[name]
            window[name] = function (...args) {
                record(`window:${name}`, {stack: new Error().stack})
                return Reflect.apply(originalWindow, this, args)
            }
        }
        for (const prototype of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
            Object.defineProperty(prototype, 'value', {
                ...descriptor,
                set(value) {
                    if (this.id === 'search-textbox' || this.id === 'example-text-input') {
                        record('value:set', {target: describe(this), value, stack: new Error().stack})
                    }
                    return Reflect.apply(descriptor.set, this, [value])
                },
            })
        }
        record('init')
    })
    const observePage = (p) => {
        for (const name of ['framenavigated', 'frameattached', 'framedetached']) {
            p.on(name, (frame) => rows.push({kind: name, at: Date.now(), url: frame.url(), main: p.mainFrame() === frame}))
        }
        p.on('close', () => rows.push({kind: 'page:close', at: Date.now(), url: p.url()}))
        p.on('pageerror', (error) => rows.push({kind: 'page:error', at: Date.now(), error: String(error)}))
    }
    for (const p of context.pages()) observePage(p)
    context.on('page', (p) => { rows.push({kind: 'page:new', at: Date.now(), url: p.url()}); observePage(p) })
    rows.push({kind: 'test:start', title: testInfo.title, repeat: testInfo.repeatEachIndex})
}

export async function saveFocusProbe(context, page, testInfo) {
    const rows = observations.get(context) ?? []
    const frames = []
    for (const frame of page.frames()) {
        try {
            frames.push(await frame.evaluate(() => ({
                url: location.href, focused: document.hasFocus(),
                active: document.activeElement?.outerHTML.slice(0, 500),
                query: document.querySelector('#search-textbox')?.value,
                state: globalThis.__manabitanSearchDebug,
            })))
        } catch (error) { frames.push({error: String(error)}) }
    }
    const directory = 'builds/focus-cause'
    fs.mkdirSync(directory, {recursive: true})
    const name = `${testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 100)}-${testInfo.repeatEachIndex}`
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({
        title: testInfo.title, repeat: testInfo.repeatEachIndex, status: testInfo.status,
        error: testInfo.error, frames, pages: context.pages().map((p) => p.url()), rows,
    }, null, 2))
}
