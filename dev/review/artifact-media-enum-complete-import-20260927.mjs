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
import {makeFixturePng} from '../../test/util/mdict-binary-fixture.js'

const base = '0a097ce4c5c8534a59417d12446d6991a6bbc4d4'
const candidate = '85b142008f5e7d8640d5f4e58fc526f2c98bc127'
const modulePath = 'ext/js/dictionary/dictionary-importer.js'
const workload = process.argv[2] ?? 'large'
const extras = {large: 40000, small: 200}[workload]
assert.ok(Number.isInteger(extras))
const reverse = process.env.REVERSE_ORDER === '1'
const preflight = process.env.PREFLIGHT === '1'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [
    arm,
    execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 8 * 1024 * 1024}),
]))
const encoder = new TextEncoder()
function artifact(rows) {
    const keys = Array.from({length: rows}, (_, i) => encoder.encode(`term-${String(i).padStart(4, '0')}`))
    const values = Array.from({length: rows}, (_, i) => encoder.encode(JSON.stringify({
        rules: '', definitionTags: '', termTags: '', glossary: [`definition ${i} 日本語`],
    })))
    const arenaBytes = keys.reduce((sum, key) => sum + key.length, 0)
    const indexesStart = 20 + rows * 2 + arenaBytes
    const padding = (-indexesStart) & 3
    const bytes = new Uint8Array(indexesStart + padding + rows * 8 + values.reduce((sum, value) => sum + 20 + value.length, 0))
    const view = new DataView(bytes.buffer)
    bytes.set(encoder.encode('MBTB0005'))
    view.setUint32(8, rows, true)
    let cursor=12
    view.setUint32(cursor, rows, true); cursor+=4
    view.setUint32(cursor, arenaBytes, true); cursor+=4
    for(const key of keys){view.setUint16(cursor,key.length,true);cursor+=2}
    for(const key of keys){bytes.set(key,cursor);cursor+=key.length}
    cursor+=(-cursor)&3
    for(let list=0;list<2;++list){for(let i=0;i<rows;++i){view.setUint32(cursor,i,true);cursor+=4}}
    for(let i=0;i<rows;++i){
        const [h1,h2]=hashTermEntryContentBytesPair(values[i])
        view.setInt32(cursor,i,true);cursor+=4
        view.setInt32(cursor,-1,true);cursor+=4
        view.setUint32(cursor,h1,true);cursor+=4
        view.setUint32(cursor,h2,true);cursor+=4
        view.setUint32(cursor,values[i].length,true);cursor+=4
        bytes.set(values[i],cursor);cursor+=values[i].length
    }
    assert.equal(cursor,bytes.length)
    return bytes
}
const rowCount=100
const termArtifact=artifact(rowCount)
const title=`Artifact media enumeration ${workload}`
const png=makeFixturePng([10,20,30,255])
const zip=new JSZip()
const date=new Date('2026-01-01T00:00:00Z')
zip.file('index.json',JSON.stringify({title,format:3,revision:'media-enum-20260927',sequenced:true}),{date})
zip.file('term_bank_1.mbtb',termArtifact,{date,compression:'STORE'})
zip.file('manabitan-import-artifact.json',JSON.stringify({
    termBanks:[{artifact:'term_bank_1.mbtb',packedOffset:0,packedLength:termArtifact.length,rows:rowCount}],
    includesMediaFiles:true,
}),{date})
zip.file('images/control.png',png,{date,compression:'STORE'})
for(let i=0;i<extras;++i){zip.file(`resources/noise-${String(i).padStart(5,'0')}.dat`,new Uint8Array(0),{date,compression:'STORE'})}
const fixture=await zip.generateAsync({type:'nodebuffer',compression:'STORE'})
const out=resolve('builds/artifact-media-enum-completion')
await mkdir(out,{recursive:true})
const manifest=new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json',ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION','0.0.0.0'))
const extensionId=[...hash(Buffer.from(manifest.key,'base64')).slice(0,32)].map((c)=>String.fromCharCode(97+parseInt(c,16))).join('')
const baseUrl=`chrome-extension://${extensionId}`
const report={
 base,candidate,workload,extras,rowCount,reverse,preflight,node:process.version,
 moduleHashes:{A:hash(sources.A),B:hash(sources.B)},fixtureHash:hash(fixture),fixtureBytes:fixture.length,
 focusHash:hash(await readFile('ext/js/dom/document-focus-controller.js')),observations:[],status:'running'
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
  for(const other of context.pages()){if(other!==page&&other.url().endsWith('/welcome.html'))await other.close()}
  await page.bringToFront()
  await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
  await page.locator('#dictionary-import-button').click()
  await page.evaluate(()=>{
   globalThis.__manabitanImportCompletionSignalEnabled=true
   document.querySelector('#dictionary-import-file-input').addEventListener('change',()=>{globalThis.__reviewImportStart=performance.now()},{once:true,capture:true})
  })
  await page.locator('#dictionary-import-file-input').setInputFiles({name:'artifact-media-enum.zip',mimeType:'application/zip',buffer:fixture})
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
  assert.equal(counts.terms,rowCount)
  assert.equal(counts.media,1)
  for(const key of ['termMeta','kanji','kanjiMeta','tagMeta'])assert.equal(counts[key],0,key)
  const ids=[0,1,50,99]
  const digest=[]
  for(const i of ids){
   const found=await api(page,'termsFind',{text:`term-${String(i).padStart(4,'0')}`,details:{matchType:'exact',deinflect:false,primaryReading:''},optionsContext:{depth:0,url:page.url()}})
   const json=JSON.stringify(found);assert.ok(json.includes(`definition ${i} 日本語`));digest.push(hash(json))
  }
  const servedHash=await page.evaluate(async()=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch('/js/dictionary/dictionary-importer.js')).arrayBuffer()))].map((x)=>x.toString(16).padStart(2,'0')).join(''))
  assert.equal(servedHash,report.moduleHashes[plan.arm])
  assert.deepEqual(pageErrors,[])
  return {...plan,elapsedMs,counts,contentDigest:hash(JSON.stringify(digest)),servedHash,browser:context.browser()?.version(),pageErrors,importDebug:timing.debug}
 } finally {await context.close()}
}
const schedule=reverse?[{kind:'warmup',arm:'B'},{kind:'warmup',arm:'A'}]:[{kind:'warmup',arm:'A'},{kind:'warmup',arm:'B'}]
if(!preflight){
 for(let pair=0;pair<2;++pair)schedule.push({kind:'control',pair,side:0,arm:'A'},{kind:'control',pair,side:1,arm:'A'})
 for(let block=0;block<5;++block){
  const order=(block%2===1)!==reverse?'BAAB':'ABBA'
  for(const [slot,arm] of [...order].entries())schedule.push({kind:'measurement',block,slot,arm})
 }
 for(let pair=2;pair<4;++pair)schedule.push({kind:'control',pair,side:0,arm:'A'},{kind:'control',pair,side:1,arm:'A'})
}
report.schedule=schedule
try{
 for(const [index,plan] of schedule.entries()){
  const observation=await observe({...plan,index});report.observations.push(observation);await save()
  console.log(JSON.stringify({workload,index,kind:plan.kind,arm:plan.arm,elapsedMs:observation.elapsedMs}))
 }
 report.status='success'
}catch(error){report.status='failure';report.failure={index:report.observations.length,message:String(error),stack:error.stack};throw error}
finally{await writeFile(modulePath,sources.A);await save()}
