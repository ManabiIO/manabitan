/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium,expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'

const base='2d79cd1dec164caa3075884133d9d12204a4f48a'
const candidate='8a1877ee8d7df36486150cbc4cf65bbcea592328'
const modulePath='ext/js/dictionary/dictionary-importer.js'
const workload=process.argv[2]??'large'
const junkCount={large:30000,medium:10000}[workload];assert.ok(junkCount)
const reverse=process.env.REVERSE_ORDER==='1',preflight=process.env.PREFLIGHT==='1'
const hash=v=>createHash('sha256').update(v).digest('hex')
const sources=Object.fromEntries([['A',base],['B',candidate]].map(([a,r])=>[a,execFileSync('git',['show',`${r}:${modulePath}`],{maxBuffer:6*1024*1024})]))
const title=`Archive prefilter ${workload}`,termCount=128
const zip=new JSZip(),date=new Date('2026-01-01T00:00:00Z')
zip.file('index.json',JSON.stringify({title,format:3,revision:'prefilter-current',sequenced:true}),{date})
zip.file('term_bank_1.json',JSON.stringify(Array.from({length:termCount},(_,i)=>[`term-${i}`,'','','',0,[`definition ${i} 日本語`],i+1,''])),{date})
for(let i=0;i<junkCount;i++)zip.file(`assets/${String(i).padStart(6,'0')}.bin`,new Uint8Array(0),{date})
const fixture=await zip.generateAsync({type:'nodebuffer',compression:'STORE'})
const out=resolve('builds/archive-prefilter');await mkdir(out,{recursive:true})
const manifest=new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json',ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION','0.0.0.0'))
const extensionId=[...hash(Buffer.from(manifest.key,'base64')).slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join(''),baseUrl=`chrome-extension://${extensionId}`
const report={base,candidate,workload,junkCount,reverse,preflight,moduleHashes:{A:hash(sources.A),B:hash(sources.B)},fixtureHash:hash(fixture),fixtureBytes:fixture.length,focusHash:hash(await readFile('ext/js/dom/document-focus-controller.js')),observations:[],status:'running'}
const save=()=>writeFile(resolve(out,`${workload}${preflight?'-preflight':''}.json`),JSON.stringify(report,null,2))
async function api(page,action,params={}){return page.evaluate(m=>new Promise((yes,no)=>chrome.runtime.sendMessage(m,r=>{const e=chrome.runtime.lastError??r?.error;e?no(new Error(e.message??'Runtime error')):yes(r?.result)})),{action,params})}
async function observe(plan){
 await writeFile(modulePath,sources[plan.arm])
 const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:[`--disable-extensions-except=${resolve('ext')}`,`--load-extension=${resolve('ext')}`]})
 const page=await context.newPage(),errs=[];page.on('pageerror',e=>errs.push(String(e)))
 try{
  await page.goto(`${baseUrl}/settings.html`);await expect(page.locator('html')).toHaveAttribute('data-loaded','true',{timeout:30000});for(const o of context.pages())if(o!==page&&o.url().endsWith('/welcome.html'))await o.close()
  await page.bringToFront();await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click();await page.locator('#dictionary-import-button').click()
  await page.evaluate(()=>{globalThis.__manabitanImportCompletionSignalEnabled=true;document.querySelector('#dictionary-import-file-input').addEventListener('change',()=>{globalThis.__reviewImportStart=performance.now()},{once:true,capture:true})})
  await page.locator('#dictionary-import-file-input').setInputFiles({name:'prefilter.zip',mimeType:'application/zip',buffer:fixture})
  await page.waitForFunction(()=>globalThis.__manabitanLastImportCompletion?.sequence===1,null,{timeout:120000})
  const t=await page.evaluate(()=>({start:globalThis.__reviewImportStart,completion:globalThis.__manabitanLastImportCompletion,debug:globalThis.__manabitanLastImportDebug}))
  assert.equal(t.completion.errorCount,0);assert.equal(t.debug.usesFallbackStorage,false);assert.equal(t.debug.openStorageDiagnostics?.mode,'opfs-sahpool')
  const elapsedMs=t.completion.completedAtMonotonicMs-t.start;assert.ok(elapsedMs>0)
  const counts=(await api(page,'getDictionaryCounts',{dictionaryNames:[title],getTotal:false})).counts[0];assert.equal(counts.terms,termCount);assert.equal(counts.media,0)
  const found=await api(page,'termsFind',{text:'term-127',details:{matchType:'exact',deinflect:false,primaryReading:''},optionsContext:{depth:0,url:page.url()}});assert.ok(JSON.stringify(found).includes('definition 127 日本語'))
  const served=await page.evaluate(async p=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch('/'+p.replace(/^ext\//,''))).arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join(''),modulePath);assert.equal(served,report.moduleHashes[plan.arm]);assert.deepEqual(errs,[])
  return {...plan,elapsedMs,counts,contentDigest:hash(JSON.stringify(found)),served,browser:context.browser()?.version()}
 }finally{await context.close()}
}
const schedule=reverse?[{kind:'warmup',arm:'B'},{kind:'warmup',arm:'A'}]:[{kind:'warmup',arm:'A'},{kind:'warmup',arm:'B'}]
if(!preflight){schedule.push({kind:'control',pair:0,side:0,arm:'A'},{kind:'control',pair:0,side:1,arm:'A'});for(let b=0;b<4;b++){const order=(b%2===1)!==reverse?'BAAB':'ABBA';for(const[slot,arm]of[...order].entries())schedule.push({kind:'measurement',block:b,slot,arm})}schedule.push({kind:'control',pair:1,side:0,arm:'A'},{kind:'control',pair:1,side:1,arm:'A'})}
report.schedule=schedule
try{for(const[index,plan]of schedule.entries()){const o=await observe({...plan,index});report.observations.push(o);await save();console.log(JSON.stringify({workload,index,kind:plan.kind,arm:plan.arm,elapsedMs:o.elapsedMs}))}report.status='success'}catch(error){report.status='failure';report.failure={index:report.observations.length,message:String(error),stack:error.stack};throw error}finally{await writeFile(modulePath,sources.A);await save()}
