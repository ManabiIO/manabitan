/* SPDX-License-Identifier: GPL-3.0-or-later */
import {chromium} from '@playwright/test'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
const extension = path.resolve(process.argv[2])
const output = path.resolve(process.argv[3])
const profile = await mkdtemp(path.join(os.tmpdir(), 'glossary-native-'))
const results = []
const errors = []
let context
let browserVersion
let importDebug
let completion
const observations = {}
const dictionary = 'Glossary Semantics'
const verify = async (name, fn) => {
    try { await fn(); results.push({name, passed: true}) }
    catch (error) { results.push({name, passed: false, error: error.stack}) }
}
async function open() {
    context = await chromium.launchPersistentContext(profile, {headless: true, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]})
    browserVersion = context.browser()?.version() ?? ''
    await context.addInitScript(() => { globalThis.__manabitanImportCompletionSignalEnabled = true })
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 30000})
    const id = new URL(worker.url()).host
    const page = context.pages()[0] ?? await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`chrome-extension://${id}/settings.html?popup-preview=false`)
    await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', null, {timeout: 60000})
    return page
}
async function send(page, action, params) {
    return await page.evaluate(async ({action, params}) => await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({action, params}, response => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return }
            if (response?.error) { reject(new Error(JSON.stringify(response.error))); return }
            resolve(response?.result)
        })
    }), {action, params})
}
async function checkStored(page, label) {
    observations[label] = {}
    await verify(`${label}: exactly eight persisted terms`, async () => {
        const r = await send(page, 'getDictionaryCounts', {dictionaryNames: [dictionary], getTotal: false})
        observations[label].counts = r
        assert.equal(r.counts[0].terms, 8)
    })
    const expectedImage = (await readFile('builds/glossary-native/image.png')).toString('base64')
    for (const name of ['one.png', 'nested.png', 'control.png', 'two.png']) {
        await verify(`${label}: exact asset ${name}`, async () => {
            const media = await send(page, 'getMedia', {targets: [{dictionary, path: name}]})
            observations[label][name] = media
            assert.equal(media.length, 1)
            assert.equal(media[0].content, expectedImage)
        })
    }
    for (const text of ['duplicatetext', 'escapedtext', 'duplicatetype', 'escapedduplicate', 'ordinarytext']) {
        await verify(`${label}: decoded definition ${text}`, async () => {
            const r = await send(page, 'termsFind', {text, details: {primaryReading: '', matchType: 'exact', deinflect: false}, optionsContext: {index: 0}})
            observations[label][text] = r
            assert.ok(r.dictionaryEntries.length > 0)
            const definitions = r.dictionaryEntries.flatMap(entry => entry.definitions ?? []).flatMap(definition => definition.entries ?? [])
            assert.deepEqual(definitions, ['RIGHT'])
        })
    }
}
try {
    let page = await open()
    await page.setInputFiles('#dictionary-import-file-input', 'builds/glossary-native/fixture.zip')
    await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion !== undefined && globalThis.__manabitanLastImportCompletion !== null, null, {timeout: 120000})
    importDebug = await page.evaluate(() => globalThis.__manabitanLastImportDebug)
    completion = await page.evaluate(() => globalThis.__manabitanLastImportCompletion)
    await verify('import has no errors and uses native storage', () => {
        assert.equal(importDebug.hasResult, true)
        assert.equal(importDebug.errorCount, 0)
        assert.equal(importDebug.addSettingsErrorCount, 0)
        assert.equal(importDebug.usesFallbackStorage, false)
        assert.equal(completion.errorCount, 0)
    })
    const settings = await send(page, 'optionsGetFull')
    for (const profile of settings.profiles) {
        for (const row of profile.options.dictionaries) { row.enabled = row.name === dictionary }
    }
    await send(page, 'setAllSettings', {value: settings, source: 'glossary-semantics-test'})
    await checkStored(page, 'live')
    await context.close()
    context = null
    page = await open()
    await checkStored(page, 'reopened')
} catch (error) {
    results.push({name: 'browser workflow', passed: false, error: error.stack})
} finally {
    if (context) { await context.close() }
    await rm(profile, {recursive: true, force: true})
    await mkdir(path.dirname(output), {recursive: true})
    const report = {browserVersion, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results, importDebug, completion, observations, pageErrors: errors}
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({passed: report.passed, failed: report.failed}))
    for (const r of results.filter(r => !r.passed)) { console.error(r.name, r.error) }
    process.exitCode = report.failed ? 1 : 0
}
