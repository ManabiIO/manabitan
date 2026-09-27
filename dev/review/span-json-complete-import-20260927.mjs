/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'

const base = '60695b51226f6b86978bfd5ea3f11c53fcf55f11'
const candidate = '98a02a994998adac2e2bbba89aace381ec93dcb1'
const modulePath = 'ext/js/dictionary/term-content-block-store.js'
const workload = process.argv[2] ?? 'jmdict'
const specs = {
    jmdict: {rows: 50000, title: 'JMdict JSON span benchmark'},
    generic: {rows: 50000, title: 'Generic JSON span benchmark'},
}
const spec = specs[workload]
assert.ok(spec)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [
    arm,
    execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 4 * 1024 * 1024}),
]))
const zip = new JSZip()
const date = new Date('2026-01-01T00:00:00Z')
zip.file('index.json', JSON.stringify({title: spec.title, format: 3, revision: 'span-json-20260927', sequenced: true}), {date})
const bankSize = 10000
for (let start = 0, bank = 1; start < spec.rows; start += bankSize, ++bank) {
    const count = Math.min(bankSize, spec.rows - start)
    const rows = Array.from({length: count}, (_, j) => {
        const i = start + j
        return [
            `term-${String(i).padStart(6, '0')}`,
            '',
            '',
            '',
            i % 100,
            [`definition ${i} 日本語 ${'x'.repeat(180)}`],
            i,
            '',
        ]
    })
    zip.file(`term_bank_${bank}.json`, JSON.stringify(rows), {date, compression: 'DEFLATE'})
}
const fixture = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const out = resolve('builds/span-json')
await mkdir(out, {recursive: true})
const report = {
    base,candidate,workload,spec,reverse,preflight,node:process.version,
    moduleHashes:{A:hash(sources.A),B:hash(sources.B)},
    fixtureHash:hash(fixture),fixtureBytes:fixture.length,
    focusHash:hash(await readFile('ext/js/dom/document-focus-controller.js')),
    observations:[],status:'running',
}
const save=()=>writeFile(resolve(out,`${workload}${preflight?'-preflight':''}.json`),JSON.stringify(report,null,2))
async function api(page,action,params={}){
    return page.evaluate((message)=>new Promise((yes,no)=>chrome.runtime.sendMessage(message,(response)=>{
        const error=chrome.runtime.lastError??response?.error
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
        await page.locator('#dictionary-import-file-input').setInputFiles({name:'span-json.zip',mimeType:'application/zip',buffer:fixture})
        await page.waitForFunction(()=>globalThis.__manabitanLastImportCompletion?.sequence===1,null,{timeout:180000})
        const timing=await page.evaluate(()=>({start:globalThis.__reviewImportStart,completion:globalThis.__manabitanLastImportCompletion,debug:globalThis.__manabitanLastImportDebug}))
        assert.equal(timing.completion.errorCount,0)
        assert.equal(timing.completion.importRunCurrent,true)
        assert.deepEqual(timing.completion.importedTitles,[spec.title])
        assert.equal(timing.debug.hasResult,true)
        assert.equal(timing.debug.errorCount,0)
        assert.equal(timing.debug.addSettingsErrorCount,0)
        assert.equal(timing.debug.usesFallbackStorage,false)
        assert.equal(timing.debug.openStorageDiagnostics?.mode,'opfs-sahpool')
        const elapsedMs=timing.completion.completedAtMonotonicMs-timing.start
        assert.ok(Number.isFinite(elapsedMs)&&elapsedMs>0)
        const counts=(await api(page,'getDictionaryCounts',{dictionaryNames:[spec.title],getTotal:false})).counts[0]
        assert.equal(counts.terms,spec.rows)
        const ids=[0,1,Math.floor(spec.rows/2),spec.rows-1]
        const content=[]
        for(const i of ids){
            const found=await api(page,'termsFind',{text:`term-${String(i).padStart(6,'0')}`,details:{matchType:'exact',deinflect:false,primaryReading:''},optionsContext:{depth:0,url:page.url()}})
            assert.ok(JSON.stringify(found).includes(`definition ${i} 日本語`))
            content.push(found)
        }
        const hashes=await page.evaluate(async()=>{
            const digest=async(path)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch(path)).arrayBuffer()))].map((x)=>x.toString(16).padStart(2,'0')).join('')
            return {store:await digest('/js/dictionary/term-content-block-store.js'),focus:await digest('/js/dom/document-focus-controller.js')}
        })
        assert.equal(hashes.store,report.moduleHashes[plan.arm])
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
