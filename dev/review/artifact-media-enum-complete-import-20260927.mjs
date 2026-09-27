/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {hashTermEntryContentBytesPair} from '../../ext/js/dictionary/term-entry-content-hash.js'

const base = '60695b51226f6b86978bfd5ea3f11c53fcf55f11'
const candidate = 'a95f7fe7059ed78b9d2f09ae045dd82bd567f0e7'
const modulePath = 'ext/js/dictionary/dictionary-importer.js'
const workload = process.argv[2] ?? 'many'
const specs = {
    many: {dummyFiles: 20000, rows: 512},
    medium: {dummyFiles: 5000, rows: 512},
    small: {dummyFiles: 64, rows: 128},
}
const spec = specs[workload]
assert.ok(spec)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [
    arm,
    execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 8 * 1024 * 1024}),
]))
const encoder = new TextEncoder()
function artifact(terms) {
    const keys = terms.map((term) => encoder.encode(term))
    const values = terms.map((term, i) => encoder.encode(JSON.stringify({
        rules: '',
        definitionTags: '',
        termTags: '',
        glossary: [`definition ${i} 日本語`],
    })))
    const arenaBytes = keys.reduce((sum, key) => sum + key.length, 0)
    const indexesStart = 20 + keys.length * 2 + arenaBytes
    const padding = (-indexesStart) & 3
    const headerBytes = indexesStart + padding + terms.length * 8
    const rowsBytes = values.reduce((sum, value) => sum + value.length + 20, 0)
    const bytes = new Uint8Array(headerBytes + rowsBytes)
    const view = new DataView(bytes.buffer)
    bytes.set(encoder.encode('MBTB0005'))
    view.setUint32(8, terms.length, true)
    let cursor = 12
    view.setUint32(cursor, keys.length, true)
    view.setUint32(cursor + 4, arenaBytes, true)
    cursor += 8
    for (const key of keys) { view.setUint16(cursor, key.length, true); cursor += 2 }
    for (const key of keys) { bytes.set(key, cursor); cursor += key.length }
    cursor += padding
    for (let list = 0; list < 2; ++list) {
        for (let i = 0; i < terms.length; ++i) { view.setUint32(cursor, i, true); cursor += 4 }
    }
    for (let i = 0; i < terms.length; ++i) {
        const [hash1, hash2] = hashTermEntryContentBytesPair(values[i])
        view.setInt32(cursor, i, true)
        view.setInt32(cursor + 4, -1, true)
        view.setUint32(cursor + 8, hash1, true)
        view.setUint32(cursor + 12, hash2, true)
        view.setUint32(cursor + 16, values[i].length, true)
        cursor += 20
        bytes.set(values[i], cursor)
        cursor += values[i].length
    }
    assert.equal(cursor, bytes.length)
    return bytes
}
const title = `Artifact media enumeration ${workload}`
const terms = Array.from({length: spec.rows}, (_, i) => `term-${String(i).padStart(5, '0')}`)
const termArtifact = artifact(terms)
const manifestJson = {
    termBanks: [{artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: termArtifact.byteLength, rows: spec.rows}],
    includesMediaFiles: true,
}
const zip = new JSZip()
const date = new Date('2026-01-01T00:00:00Z')
zip.file('index.json', JSON.stringify({title, format: 3, revision: 'media-enum-20260927', sequenced: true}), {date})
zip.file('manabitan-import-artifact.json', JSON.stringify(manifestJson), {date})
zip.file('term_bank_1.mbtb', termArtifact, {date, compression: 'STORE'})
for (let i = 0; i < spec.dummyFiles; ++i) {
    zip.file(`aux/dummy-${String(i).padStart(6, '0')}.txt`, '', {date, compression: 'STORE'})
}
const fixture = await zip.generateAsync({type: 'nodebuffer', compression: 'STORE'})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const out = resolve('builds/artifact-media-enum')
await mkdir(out, {recursive: true})
const report = {
    base,candidate,workload,spec,reverse,preflight,node:process.version,
    moduleHashes:{A:hash(sources.A),B:hash(sources.B)},
    fixtureHash:hash(fixture),fixtureBytes:fixture.length,
    focusHash:hash(await readFile('ext/js/dom/document-focus-controller.js')),
    observations:[],status:'running',
}
const save = () => writeFile(resolve(out,`${workload}${preflight?'-preflight':''}.json`),JSON.stringify(report,null,2))
async function api(page, action, params = {}) {
    return page.evaluate((message)=>new Promise((yes,no)=>chrome.runtime.sendMessage(message,(response)=>{
        const error=chrome.runtime.lastError ?? response?.error
        if(error){no(new Error(error.message??'Runtime error'))}else{yes(response?.result)}
    })),{action,params})
}
async function observe(plan){
    await writeFile(modulePath,sources[plan.arm])
    const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:[`--disable-extensions-except=${resolve('ext')}`,`--load-extension=${resolve('ext')}`]})
    const page=await context.newPage()
    const pageErrors=[]
    page.on('pageerror',(error)=>pageErrors.push(String(error)))
    try{
        await page.goto(`${baseUrl}/settings.html`)
        await expect(page.locator('html')).toHaveAttribute('data-loaded','true',{timeout:30000})
        for(const other of context.pages()){if(other!==page&&other.url().endsWith('/welcome.html')){await other.close()}}
        await page.bringToFront()
        await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
        await page.locator('#dictionary-import-button').click()
        await page.evaluate(()=>{
            globalThis.__manabitanImportCompletionSignalEnabled=true
            document.querySelector('#dictionary-import-file-input').addEventListener('change',()=>{globalThis.__reviewImportStart=performance.now()},{once:true,capture:true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({name:'media-enum.zip',mimeType:'application/zip',buffer:fixture})
        await page.waitForFunction(()=>globalThis.__manabitanLastImportCompletion?.sequence===1,null,{timeout:180000})
        const timing=await page.evaluate(()=>({start:globalThis.__reviewImportStart,completion:globalThis.__manabitanLastImportCompletion,debug:globalThis.__manabitanLastImportDebug}))
        assert.equal(timing.completion.errorCount,0)
        assert.equal(timing.completion.importRunCurrent,true)
        assert.deepEqual(timing.completion.importedTitles,[title])
        assert.equal(timing.debug.hasResult,true)
        assert.equal(timing.debug.errorCount,0)
        assert.equal(timing.debug.addSettingsErrorCount,0)
        assert.equal(timing.debug.usesFallbackStorage,false)
        assert.equal(timing.debug.openStorageDiagnostics?.mode,'opfs-sahpool')
        const elapsedMs=timing.completion.completedAtMonotonicMs-timing.start
        assert.ok(Number.isFinite(elapsedMs)&&elapsedMs>0)
        const counts=(await api(page,'getDictionaryCounts',{dictionaryNames:[title],getTotal:false})).counts[0]
        assert.equal(counts.terms,spec.rows)
        assert.equal(counts.media,0)
        const ids=[0,Math.floor(spec.rows/2),spec.rows-1]
        const content=[]
        for(const i of ids){
            const found=await api(page,'termsFind',{text:terms[i],details:{matchType:'exact',deinflect:false,primaryReading:''},optionsContext:{depth:0,url:page.url()}})
            assert.ok(JSON.stringify(found).includes(`definition ${i} 日本語`))
            content.push(found)
        }
        const hashes=await page.evaluate(async()=>{
            const digest=async(path)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch(path)).arrayBuffer()))].map((x)=>x.toString(16).padStart(2,'0')).join('')
            return {importer:await digest('/js/dictionary/dictionary-importer.js'),focus:await digest('/js/dom/document-focus-controller.js')}
        })
        assert.equal(hashes.importer,report.moduleHashes[plan.arm])
        assert.equal(hashes.focus,report.focusHash)
        assert.deepEqual(pageErrors,[])
        return {...plan,elapsedMs,counts,contentDigest:hash(JSON.stringify(content)),debug:timing.debug,hashes,browser:context.browser()?.version(),pageErrors}
    }finally{await context.close()}
}
const schedule=reverse?[{kind:'warmup',arm:'B'},{kind:'warmup',arm:'A'}]:[{kind:'warmup',arm:'A'},{kind:'warmup',arm:'B'}]
if(!preflight){
    for(let pair=0;pair<2;++pair){schedule.push({kind:'control',pair,side:0,arm:'A'},{kind:'control',pair,side:1,arm:'A'})}
    for(let block=0;block<6;++block){
        const order=(block%2===1)!==reverse?'BAAB':'ABBA'
        for(const[slot,arm]of[...order].entries()){schedule.push({kind:'measurement',block,slot,arm})}
    }
    for(let pair=2;pair<4;++pair){schedule.push({kind:'control',pair,side:0,arm:'A'},{kind:'control',pair,side:1,arm:'A'})}
}
report.schedule=schedule
try{
    for(const[index,plan]of schedule.entries()){
        const result=await observe({...plan,index})
        report.observations.push(result);await save()
        console.log(JSON.stringify({workload,index,kind:plan.kind,arm:plan.arm,elapsedMs:result.elapsedMs}))
    }
    report.status='success'
}catch(error){
    report.status='failure';report.failure={index:report.observations.length,message:String(error),stack:error.stack};throw error
}finally{await writeFile(modulePath,sources.A);await save()}
