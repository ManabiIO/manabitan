/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chromium, expect} from '@playwright/test';
import {runExtended} from './extended-e2e.mjs';
const root=path.resolve('builds/manabitan-web');
const fixtures=path.resolve(process.env.DICTIONARY_FIXTURES);
const output=path.resolve('builds/web-evidence');await fs.mkdir(output,{recursive:true});
const profile=path.resolve(process.env.RUNNER_TEMP||'/tmp','manabitan-web-profile-'+Date.now());
const results=[], errors=[], requests=[];
let context,page;
const html=`<!doctype html><meta charset="utf-8"><title>ManabiTan web qualification</title>
<link rel="stylesheet" href="/vendor/css/structured-content.css"><p id="text" lang="ja">猫が学校で日本語を勉強しています。食べました。</p>
<input id="archive" type="file" accept=".zip"><div id="status"></div><div id="result"></div>
<script type="module">
import {ManabiTanWebClient} from '/vendor/web/client.js';
import {createReaderScanner} from '/vendor/web/scanner.js';
import {renderDictionaryResults} from '/vendor/web/render.js';
window.createRuntime=()=>new ManabiTanWebClient();window.runtime=createRuntime();
window.openRuntime=async()=>{window.status=await runtime.open();document.querySelector('#status').textContent='open';};
window.find=async(text)=>{const r=await runtime.lookup(text);window.disposeRender?.();window.disposeRender=renderDictionaryResults(document.querySelector('#result'),r,runtime,find);return r;};
window.scan=()=>{window.scanner=createReaderScanner(runtime,document.querySelector('#text'),{onResult: r=>{window.disposeRender?.();window.disposeRender=renderDictionaryResults(document.querySelector('#result'),r,runtime,find);},onError: e=>{window.scanError=e.message;}});scanner.start();};
document.querySelector('#archive').onchange=async(event)=>{window.importDone=false;window.importError=null;
window.importController=new AbortController();
try{window.importResult=await runtime.importDictionary(event.target.files[0],{signal:importController.signal,onProgress:p=>{window.progress=p;if(window.cancelDuringImport && p.count>20 && p.index>0)importController.abort();}});}
catch(e){window.importError=e.message;}finally{window.importDone=true;}};
window.hostReady=true;
</script>`;
const mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.ttf':'font/ttf'};
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 requests.push(pathname);
 if(pathname==='/short-default.zip'){res.writeHead(200).end('bad');return;}
 if(pathname==='/default.zip'){
  try{res.writeHead(200,{'Content-Type':'application/zip'}).end(await fs.readFile(path.join(fixtures,'jitendex-yomitan.zip')));}
  catch{res.writeHead(404).end();}return;
 }
 if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-cache'}).end(html);return;}
 if(!pathname.startsWith('/vendor/')){res.writeHead(404).end();return;}
 const filename=path.resolve(root,decodeURIComponent(pathname.slice(8)));
 if(!filename.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{const data=await fs.readFile(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'public, max-age=86400'}).end(data);}
 catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(4180,'127.0.0.1',r));const origin='http://127.0.0.1:4180';
async function save(){await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));}
async function check(name,fn){const start=Date.now();try{const data=await fn();results.push({name,status:'passed',ms:Date.now()-start,data});console.log('PASS',name);}
catch(error){results.push({name,status:'failed',ms:Date.now()-start,error:String(error.stack||error)});console.error('FAIL',name,error);throw error;}finally{await save();}}
async function launch(){context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true});context.setDefaultTimeout(20000);page=context.pages()[0]||await context.newPage();
 context.on('page',watch);watch(page);await page.goto(origin);await page.waitForFunction(()=>window.hostReady);}
function watch(p){p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.type()==='error')console.log('BROWSER',m.text());});}
async function importFile(filename){await page.locator('#archive').setInputFiles(path.join(fixtures,filename));await page.waitForFunction(()=>window.importDone,{},{timeout:600000});const error=await page.evaluate(()=>window.importError);assert.equal(error,null);return page.evaluate(()=>window.importResult);}
try{
 await launch();
 await check('no-extension host and persistent OPFS initialize without cross-origin isolation',async()=>{
  assert.equal(await page.evaluate(()=>!!globalThis.chrome?.runtime?.id),false);assert.equal(await page.evaluate(()=>crossOriginIsolated),false);
  await page.evaluate(()=>openRuntime());return page.evaluate(()=>runtime.status());});
 const metadata=JSON.parse(await fs.readFile(path.join(fixtures,'jmdict.json')));
 let dictionary;
 await check('full official JMdict imports via a real file input using the shared importer',async()=>{
  const result=await importFile('JMdict_english.zip');dictionary=result.summary.title;
  assert.equal(result.status.counts.counts[0].terms,metadata.termRows);assert.equal(result.summary.importSuccess,true);
  return {title:dictionary,terms:metadata.termRows,storage:result.status.storage};});
 for(const query of ['猫','学校','食べました'])await check('real core translation '+query,async()=>{
  const result=await page.evaluate(q=>find(q),query);assert.ok(result.dictionaryEntries.length);if(query==='食べました')assert.ok(JSON.stringify(result).includes('食べる'));
  await expect(page.locator('#result')).toContainText(dictionary);return result.dictionaryEntries.length;});
 await check('real ManabiTan scanner renders the requested headword',async()=>{
  await page.evaluate(()=>scan());const rect=await page.locator('#text').evaluate(el=>{const t=el.firstChild;const r=document.createRange();r.setStart(t,0);r.setEnd(t,1);const b=r.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});
  await page.keyboard.down('Shift');try{await page.mouse.move(rect.x,rect.y);await expect(page.locator('#result .headword').first()).toContainText('猫');}finally{await page.keyboard.up('Shift');}
  assert.equal(await page.evaluate(()=>window.scanError),undefined);});
 await check('popup dismissal permits rescanning the same word and never enables a stopped scanner',async()=>{
  await page.evaluate(()=>{scanner.dismiss();window.disposeRender?.();document.querySelector('#result').replaceChildren();});
  const rect=await page.locator('#text').evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,1);const b=r.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});
  await page.mouse.move(0,0);await page.keyboard.down('Shift');
  try{await page.mouse.move(rect.x,rect.y);await expect(page.locator('#result .headword').first()).toContainText('猫');}finally{await page.keyboard.up('Shift');}
  await page.evaluate(()=>{scanner.stop();scanner.dismiss();document.querySelector('#result').replaceChildren();});
  await page.mouse.move(0,0);await page.keyboard.down('Shift');
  try{await page.mouse.move(rect.x,rect.y);await page.waitForTimeout(150);assert.equal(await page.locator('#result .headword').count(),0);}finally{await page.keyboard.up('Shift');}
 });
 await check('second independent tab cannot open the same SQLite pool',async()=>{
  const tab=await context.newPage();await tab.goto(origin);await tab.waitForFunction(()=>window.hostReady);
  const failure=await tab.evaluate(()=>runtime.open().then(()=>null,e=>e.code));assert.equal(failure,'storage_busy');
  await page.evaluate(async()=>{scanner.stop();await runtime.close();});
  await tab.evaluate(async()=>{window.runtime=createRuntime();await runtime.open();});assert.ok((await tab.evaluate(()=>runtime.lookup('猫'))).dictionaryEntries.length);
  await tab.evaluate(()=>runtime.close());await tab.close();await page.evaluate(async()=>{window.runtime=createRuntime();await runtime.open();});});
 await check('frequency dictionary uses the same importer and appears in results',async()=>{
  await importFile('web-frequency.zip');const result=await page.evaluate(()=>find('猫'));assert.ok(result.dictionaryEntries.some(e=>e.frequencies.some(f=>f.dictionary==='Web Frequency'&&f.frequency===42)));await expect(page.locator('#result .frequency')).toContainText('42');});
 await check('failed custom ZIP does not erase the committed dictionary',async()=>{
  const before=await page.evaluate(()=>runtime.status());const error=await page.evaluate(()=>runtime.importDictionary(new Blob(['invalid zip'])).then(()=>null,e=>e.message));assert.ok(error);
  const after=await page.evaluate(()=>runtime.status());assert.deepEqual(after.dictionaries.map(d=>d.title),before.dictionaries.map(d=>d.title));assert.ok((await page.evaluate(()=>runtime.lookup('猫'))).dictionaryEntries.length);});
 await runExtended({context,page,origin,fixtures,check,importFile,dictionary,requests});
 await check('disable and re-enable persists explicit choice without reimport',async()=>{
  await page.evaluate(t=>runtime.setEnabled(t,false),dictionary);assert.equal((await page.evaluate(()=>runtime.lookup('猫'))).dictionaryEntries.length,0);
  await page.evaluate(()=>runtime.close());await page.evaluate(async()=>{window.runtime=createRuntime();await runtime.open();});
  assert.equal((await page.evaluate(()=>runtime.lookup('猫'))).dictionaryEntries.length,0);await page.evaluate(t=>runtime.setEnabled(t,true),dictionary);});
 await check('default choice, dictionary and lookup survive full browser restart',async()=>{
  await page.evaluate(t=>runtime.setDefault('installed',t),dictionary);await context.close();await launch();await page.evaluate(()=>openRuntime());
  const status=await page.evaluate(()=>runtime.status());assert.equal(status.preferences.defaultChoice,'installed');assert.equal(status.preferences.defaultTitle,dictionary);assert.ok((await page.evaluate(()=>find('猫'))).dictionaryEntries.length);});
 await check('already-open worker performs dictionary lookup while offline',async()=>{await context.setOffline(true);try{const result=await page.evaluate(()=>find('学校'));assert.ok(result.dictionaryEntries.length);}finally{await context.setOffline(false);}});
 await check('deletion removes dictionary and retains its no-reinstall choice across restart',async()=>{
  await page.evaluate(t=>runtime.deleteDictionary(t),dictionary);await page.evaluate(()=>runtime.close());await page.evaluate(async()=>{window.runtime=createRuntime();await runtime.open();});
  const status=await page.evaluate(()=>runtime.status());assert.equal(status.preferences.defaultChoice,'deleted');assert.ok(!status.dictionaries.some(d=>d.title===dictionary));assert.equal((await page.evaluate(()=>runtime.lookup('猫'))).dictionaryEntries.length,0);});
 await check('no uncaught browser exceptions',async()=>assert.deepEqual(errors,[]));
}catch(error){process.exitCode=1;}finally{await context?.close();await new Promise(r=>server.close(r));await fs.rm(profile,{recursive:true,force:true});await save();}
