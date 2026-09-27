/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'

const base='65294053e65f7e45937d51dbc3cab70543f327e4'
const candidate='f32ca7bd419e82fc59752e306d820725ce785135'
const modulePath='ext/js/dictionary/dictionary-importer.js'
const reverse=process.env.REVERSE_ORDER==='1'
const preflight=process.env.PREFLIGHT==='1'
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex')
const sources=Object.fromEntries([['A',base],['B',candidate]].map(([arm,ref])=>[arm,execFileSync('git',['show',`${ref}:${modulePath}`],{maxBuffer:4*1024*1024})]))
const title='Quote cache complete import'
const rows=100000
const zip=new JSZip()
const date=new Date('2026-01-01T00:00:00Z')
zip.file('index.json',JSON.stringify({title,format:3,revision:'quote-cache-20260927',sequenced:true}),{date})
const bankSize=10000
for(let bank=0;bank<rows/bankSize;++bank){
    const entries=Array.from({length:bankSize},(_,j)=>{
        const i=bank*bankSize+j
        const group=i%64
        const definitionTag=`definition-tag-${group}`
        const rules=`rule-${group%8} common-rule`
        const termTags=`term-tag-${group} common-tag`
        return [`term-${String(i).padStart(6,'0')}`,`reading-${String(i).padStart(6,'0')}`,definitionTag,rules,i%7,[`definition ${i}`],i+1,termTags]
    })
    zip.file(`term_bank_${bank+1}.json`,JSON.stringify(entries),{date})
}
const fixture=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:3}})
const manifest=new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json',ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION','0.0.0.0'))
const extensionId=[...hash(Buffer.from(manifest.key,'base64')).slice(0,32)].map((c)=>String.fromCharCode(97+parseInt(c,16))).join('')
const baseUrl=`chrome-extension://${extensionId}`
const out=resolve('builds/quote-cache-completion')
await mkdir(out,{recursive:true})
const report={base,candidate,rows,reverse,preflight,node:process.version,moduleHashes:{A:hash(sources.A),B:hash(sources.B)},fixtureHash:hash(fixture),fixtureBytes:fixture.length,focusHash:hash(await readFile('ext/js/dom/document-focus-controller.js')),observations:[],status:'running'}
const save=()=>writeFile(resolve(out,`result${preflight?'-preflight':''}.json`),JSON.stringify(report,null,2))
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
        for(const other of context.pages()){if(other!==page&&other.url().endsWith('/welcome.html'))await other.close()}
        await page.bringToFront()
        await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
        await page.locator('#dictionary-import-button').click()
        await page.evaluate(()=>{
            globalThis.__manabitanImportCompletionSignalEnabled=true
            document.querySelector('#dictionary-import-file-input').addEventListener('change',()=>{globalThis.__reviewImportStart=performance.now()},{once:true,capture:true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({name:'quote-cache.zip',mimeType:'application/zip',buffer:fixture})
        await page.waitForFunction(()=>globalThis.__manabitanLastImportCompletion?.sequence===1,null,{timeout:180000})
        const timing=await page.evaluate(()=>({start:globalThis.__reviewImportStart,completion:globalThis.__manabitanLastImportCompletion,debug:globalThis.__manabitanLastImportDebug}))
        assert.equal(timing.completion.errorCount,0)
        assert.equal(timing.completion.importRunCurrent,true)
        assert.deepEqual(timing.completion.importedTitles,[title])
        assert.equal(timing.debug.hasResult,true)
        assert.equal(timing.debug.errorCount,0)
        assert.equal(timing.debug.usesFallbackStorage,false)
        assert.equal(timing.debug.openStorageDiagnostics?.mode,'opfs-sahpool')
        const elapsedMs=timing.completion.completedAtMonotonicMs-timing.start
        assert.ok(Number.isFinite(elapsedMs)&&elapsedMs>0)
        const counts=(await api(page,'getDictionaryCounts',{dictionaryNames:[title],getTotal:false})).counts[0]
        assert.equal(counts.terms,rows)
        const ids=[0,1,63,64,9999,50000,99999]
        const digests=[]
        for(const i of ids){
            const found=await api(page,'termsFind',{text:`term-${String(i).padStart(6,'0')}`,details:{matchType:'exact',deinflect:false,primaryReading:''},optionsContext:{depth:0,url:page.url()}})
            const text=JSON.stringify(found)
            assert.ok(text.includes(`definition ${i}`))
            digests.push(hash(text))
        }
        const servedHash=await page.evaluate(async(path)=>{
            const bytes=await(await fetch('/'+path.replace(/^ext\//,''))).arrayBuffer()
            return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map((x)=>x.toString(16).padStart(2,'0')).join('')
        },modulePath)
        assert.equal(servedHash,report.moduleHashes[plan.arm])
        assert.deepEqual(pageErrors,[])
        return {...plan,elapsedMs,counts,contentDigest:hash(JSON.stringify(digests)),servedHash,browser:context.browser()?.version(),pageErrors}
    }finally{await context.close()}
}
const schedule=reverse?[{kind:'warmup',arm:'B'},{kind:'warmup',arm:'A'}]:[{kind:'warmup',arm:'A'},{kind:'warmup',arm:'B'}]
if(!preflight){
    schedule.push({kind:'control',pair:0,side:0,arm:'A'},{kind:'control',pair:0,side:1,arm:'A'})
    for(let block=0;block<5;++block){
        const order=(block%2===1)!==reverse?'BAAB':'ABBA'
        for(const [slot,arm] of [...order].entries())schedule.push({kind:'measurement',block,slot,arm})
    }
    schedule.push({kind:'control',pair:1,side:0,arm:'A'},{kind:'control',pair:1,side:1,arm:'A'})
}
report.schedule=schedule
try{
    for(const [index,plan] of schedule.entries()){
        const result=await observe({...plan,index})
        report.observations.push(result);await save()
        console.log(JSON.stringify({index,kind:plan.kind,arm:plan.arm,elapsedMs:result.elapsedMs}))
    }
    report.status='success'
}catch(error){
    report.status='failure';report.failure={index:report.observations.length,message:String(error),stack:error.stack};throw error
}finally{await writeFile(modulePath,sources.A);await save()}
