/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import {deflateSync} from 'node:zlib'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {makeMdictFixture} from '../../test/util/mdict-binary-fixture.js'

const base = '384d1c97dae6bd17555973b77ad415e038438499'
const candidate = '31431c90eab14421f9ecc70616cce984406bceec'
const modulePath = 'ext/js/dictionary/mdx/mdx-converter.js'
const root = process.cwd()
const workload = process.argv[2] ?? 'repeated'
assert.ok(['repeated', 'unique', 'none'].includes(workload))
const preflight = process.env.REVIEW_PREFLIGHT === '1'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries([['A',base],['B',candidate]].map(([arm,ref]) => [arm,execFileSync('git',['show',`${ref}:${modulePath}`])]))
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json',ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION','0.0.0.0'))
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c => String.fromCharCode(97 + parseInt(c,16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
function crc32(bytes) {
    let crc = 0xffffffff
    for (const b of bytes) {
        crc ^= b
        for (let i = 0; i < 8; i++) { crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    }
    return (crc ^ 0xffffffff) >>> 0
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
function pngChunk(type,data) {
    const body = Buffer.concat([Buffer.from(type),data])
    return Buffer.concat([u32(data.length),body,u32(crc32(body))])
}
function png(seed) {
    let state = seed + 1
    const raw = Buffer.alloc(257 * 64)
    for (let y = 0; y < 64; y++) {
        for (let x = 1; x <= 256; x++) {
            state = (Math.imul(state,1664525) + 1013904223) >>> 0
            raw[y * 257 + x] = state >>> 24
        }
    }
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',Buffer.concat([u32(64),u32(64),Buffer.from([8,6,0,0,0])])),pngChunk('IDAT',deflateSync(raw)),pngChunk('IEND',Buffer.alloc(0))])
}
const title = `Cache completion ${workload}`
const images = Array.from({length:64},(_,i) => workload === 'none' ? null : png(workload === 'unique' ? i : 42))
const entries = images.map((image,i) => ({key:`term-${String(i).padStart(4,'0')}`,value:`<div>definition ${i} 日本語${image ? `<img src="data:image/png;base64,${image.toString('base64')}">` : ''}</div>`}))
const fixture = makeMdictFixture(entries,{title,compression:'zlib',keysPerBlock:32,recordBlockSize:256 * 1024})
const output = resolve('builds/cache-completion')
await mkdir(output,{recursive:true})
const reportPath = resolve(output,`${workload}${preflight ? '-preflight' : ''}.json`)
const report = {base,candidate,workload,preflight,node:process.version,converterHashes:{A:sha(sources.A),B:sha(sources.B)},fixtureSha256:sha(fixture.bytes),fixtureBytes:fixture.bytes.length,rows:64,observations:[],status:'running'}
const save = () => writeFile(reportPath,JSON.stringify(report,null,2))
async function api(page,action,params = {}) {
    return page.evaluate(message => new Promise((yes,no) => chrome.runtime.sendMessage(message,response => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })),{action,params})
}
function imagePaths(value) {
    const paths = new Set()
    const visit = item => {
        if (item === null || typeof item !== 'object') { return }
        if ((item.tag === 'img' || item.type === 'image') && typeof item.path === 'string') { paths.add(item.path) }
        for (const child of Object.values(item)) { visit(child) }
    }
    visit(value)
    return [...paths]
}
async function observe(plan) {
    await writeFile(modulePath,sources[plan.arm])
    const context = await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:[`--disable-extensions-except=${resolve('ext')}`,`--load-extension=${resolve('ext')}`]})
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror',error => pageErrors.push(String(error)))
    try {
        await page.goto(`${baseUrl}/settings.html`)
        await expect(page.locator('html')).toHaveAttribute('data-loaded','true',{timeout:30000})
        for (const other of context.pages()) {
            if (other !== page && other.url().endsWith('/welcome.html')) { await other.close() }
        }
        await page.bringToFront()
        await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
        await page.locator('#dictionary-import-button').click()
        await page.evaluate(() => {
            globalThis.__manabitanImportCompletionSignalEnabled = true
            const input = document.querySelector('#dictionary-import-file-input')
            input.addEventListener('change',() => { globalThis.__reviewImportStart = performance.now() },{once:true,capture:true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({name:'cache-completion.mdx',mimeType:'application/octet-stream',buffer:Buffer.from(fixture.bytes)})
        await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion?.sequence === 1,null,{timeout:90000})
        const timing = await page.evaluate(() => ({start:globalThis.__reviewImportStart,completion:globalThis.__manabitanLastImportCompletion,debug:globalThis.__manabitanLastImportDebug}))
        assert.equal(timing.completion.errorCount,0)
        assert.equal(timing.completion.importRunCurrent,true)
        assert.deepEqual(timing.completion.importedTitles,[title])
        assert.equal(timing.debug.hasResult,true)
        assert.equal(timing.debug.errorCount,0)
        assert.equal(timing.debug.addSettingsErrorCount,0)
        assert.equal(timing.debug.usesFallbackStorage,false)
        assert.equal(timing.debug.openStorageDiagnostics?.mode,'opfs-sahpool')
        const elapsedMs = timing.completion.completedAtMonotonicMs - timing.start
        assert.ok(Number.isFinite(elapsedMs) && elapsedMs > 0)
        await expect(page.locator('#dictionaries')).toHaveText('Dictionaries (1 installed, 1 enabled)',{timeout:30000})
        const info = await api(page,'getDictionaryInfo')
        assert.deepEqual(info.map(item => item.title),[title])
        const counts = await api(page,'getDictionaryCounts',{dictionaryNames:[title],getTotal:false})
        assert.equal(counts.counts[0].terms,64)
        const expectedMedia = workload === 'none' ? 0 : (workload === 'repeated' && plan.arm === 'B' ? 1 : 64)
        assert.equal(counts.counts[0].media,expectedMedia)
        const lookups = []
        for (let start = 0; start < entries.length; start += 8) {
            lookups.push(...await Promise.all(entries.slice(start,start + 8).map(({key}) => api(page,'termsFind',{text:key,details:{matchType:'exact',deinflect:false,primaryReading:''},optionsContext:{depth:0,url:page.url()}}))))
        }
        const targets = new Map()
        for (let i = 0; i < entries.length; i++) {
            assert.ok(JSON.stringify(lookups[i]).includes(`definition ${i} 日本語`),`missing definition ${i}`)
            const paths = imagePaths(lookups[i])
            assert.equal(paths.length,images[i] === null ? 0 : 1)
            if (paths.length) { targets.set(paths[0],images[i]) }
        }
        assert.equal(targets.size,expectedMedia)
        const stored = targets.size ? await api(page,'getMedia',{targets:[...targets.keys()].map(path => ({path,dictionary:title}))}) : []
        assert.equal(stored.length,expectedMedia)
        for (const item of stored) { assert.deepEqual(Buffer.from(item.content,'base64'),targets.get(item.path)) }
        const executedSourceHash = await page.evaluate(async () => {
            const bytes = await (await fetch('/js/dictionary/mdx/mdx-converter.js')).arrayBuffer()
            return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x => x.toString(16).padStart(2,'0')).join('')
        })
        assert.equal(executedSourceHash,report.converterHashes[plan.arm])
        assert.deepEqual(pageErrors,[])
        return {...plan,elapsedMs,timing,counts:counts.counts[0],verifiedTerms:64,verifiedMedia:stored.length,sourceHash:executedSourceHash,browser:context.browser()?.version(),pageErrors}
    } finally { await context.close() }
}
const schedule = [{kind:'warmup',arm:'A'},{kind:'warmup',arm:'B'}]
if (!preflight) {
    for (let pair = 0; pair < 2; pair++) {
        schedule.push({kind:'control',pair,side:0,arm:'A'},{kind:'control',pair,side:1,arm:'A'})
    }
    for (let block = 0; block < 6; block++) {
        for (const [slot,arm] of [...(block % 2 ? 'BAAB' : 'ABBA')].entries()) { schedule.push({kind:'measurement',block,slot,arm}) }
    }
    for (let pair = 2; pair < 4; pair++) {
        schedule.push({kind:'control',pair,side:0,arm:'A'},{kind:'control',pair,side:1,arm:'A'})
    }
}
report.schedule = schedule
try {
    for (const [index,plan] of schedule.entries()) {
        const result = await observe({...plan,index})
        report.observations.push(result)
        await save()
        console.log(JSON.stringify({workload,index,kind:plan.kind,arm:plan.arm,elapsedMs:result.elapsedMs}))
    }
    report.status = 'success'
} catch (error) {
    report.status = 'failure'
    report.failure = {index:report.observations.length,message:String(error),stack:error.stack}
    throw error
} finally {
    await writeFile(modulePath,sources.A)
    await save()
}
