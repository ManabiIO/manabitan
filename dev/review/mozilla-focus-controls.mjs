/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {Builder, By} from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'

const sources = Object.fromEntries(Object.entries({
    original: '384d1c97dae6bd17555973b77ad415e038438499',
    guard: '9280a9fbd65bba7c8db73c2aec34fcd6b4afc915',
}).map(([name, ref]) => [name, execFileSync('git', ['show', `${ref}:ext/js/dom/document-focus-controller.js`], {encoding:'utf8'})]))
const server = createServer((req,res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/controller.js') {
        res.setHeader('Content-Type','text/javascript')
        return res.end(sources[url.searchParams.get('variant')] ?? sources.guard)
    }
    res.setHeader('Content-Type','text/html')
    if (url.pathname === '/child.html') {
        return res.end(`<!doctype html><html><body><div id="content-scroll-focus" tabindex="-1">scroll target</div><input id="child-input"><script type="module">import {DocumentFocusController} from '/controller.js?variant=${url.searchParams.get('variant')}'; window.focusController = new DocumentFocusController('#child-input'); window.controllerReady = true</script></body></html>`)
    }
    res.end(`<!doctype html><html><body><input id="host-input"><iframe id="child" src="/child.html?variant=${url.searchParams.get('variant')}"></iframe></body></html>`)
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const options = new firefox.Options().addArguments('-headless').setBinary(process.env.MANABITAN_FIREFOX_BINARY)
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build()
const report = {browser:(await driver.getCapabilities()).get('browserVersion'),cases:[]}
try {
    for (const variant of ['original','guard','none']) {
        for (const hostActivation of ['programmatic','pointer']) {
            for (const action of ['visible','hidden','zero-sized','selection','click','explicit']) {
                const result = {variant,hostActivation,action,passed:false}
                try {
                    await driver.get(`${origin}/host.html?variant=${variant}`)
                    const child = await driver.findElement(By.id('child'))
                    await driver.switchTo().frame(child)
                    await driver.wait(() => driver.executeScript('return window.controllerReady === true'),5000)
                    await driver.switchTo().defaultContent()
                    const host = await driver.findElement(By.id('host-input'))
                    if (hostActivation === 'pointer') await host.click()
                    else await driver.executeScript('arguments[0].focus()',host)
                    if (action==='hidden') await driver.executeScript('arguments[0].style.visibility="hidden"',child)
                    if (action==='zero-sized') await driver.executeScript('arguments[0].style.cssText="width:0;height:0"',child)
                    if (action==='selection') await driver.executeScript('arguments[0].value="selected text";arguments[0].setSelectionRange(1,8)',host)
                    await driver.switchTo().frame(child)
                    result.before = await driver.executeScript('return {active:document.activeElement.id,focused:document.hasFocus()}')
                    if (variant!=='none') await driver.executeScript('window.focusController.prepare()')
                    if (action==='click' || action==='explicit') {
                        if (action==='click') await (await driver.findElement(By.id('child-input'))).click()
                        else await driver.executeScript(variant==='none' ? 'document.querySelector("#child-input").focus()' : 'window.focusController.focusElement()')
                        result.after = await driver.executeScript('return {active:document.activeElement.id,focused:document.hasFocus()}')
                        assert.equal(result.after.active,'child-input')
                        assert.equal(result.after.focused,true)
                        await driver.actions().sendKeys('child text').perform()
                        assert.equal(await (await driver.findElement(By.id('child-input'))).getAttribute('value'),'child text')
                        if (variant!=='none') {
                            await driver.executeScript('window.focusController.blurElement(document.querySelector("#child-input"))')
                            assert.equal(await driver.executeScript('return document.activeElement.id'),'content-scroll-focus')
                        }
                    } else {
                        await driver.switchTo().defaultContent()
                        result.after = await driver.executeScript('return {active:document.activeElement.id,focused:document.hasFocus()}')
                        assert.equal(result.after.active,'host-input')
                        if (action==='selection') assert.deepEqual(await driver.executeScript('const e=document.querySelector("#host-input");return [e.selectionStart,e.selectionEnd]'),[1,8])
                        else {
                            await driver.actions().sendKeys('host text').perform()
                            assert.equal(await host.getAttribute('value'),'host text')
                        }
                    }
                    result.passed=true
                } catch (error) { result.error=String(error) }
                report.cases.push(result)
                console.log(JSON.stringify(result))
            }
        }
    }
} finally {
    await driver.quit()
    await new Promise(resolve => server.close(resolve))
    mkdirSync('builds/mozilla-focus',{recursive:true})
    writeFileSync('builds/mozilla-focus/cases.json',JSON.stringify(report,null,2))
}
assert(report.cases.filter(x=>x.variant!=='original').every(x=>x.passed),'Guard or native control failed')
