/* SPDX-License-Identifier: GPL-3.0-or-later */
// Usage: node native-opfs-recovery.mjs <repository> <output.json>
// Isolated local origin only. Uses native OPFS; faults are injected explicitly.
import {createServer} from 'node:http'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const [rootArg, output] = process.argv.slice(2)
if (!rootArg || !output) throw new Error('Expected repository and output JSON')
const root = path.resolve(rootArg)
const {chromium} = await import(pathToFileURL(path.join(root, 'node_modules/@playwright/test/index.mjs')))
const server = createServer(async (request, response) => {
    const headers = {'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        if (pathname === '/') { response.writeHead(200, {...headers,'Content-Type':'text/html'}); response.end('<!doctype html><title>OPFS qualification</title>'); return }
        const file = path.resolve(root, `.${pathname}`)
        if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return }
        const types = {'.js':'application/javascript','.mjs':'application/javascript','.wasm':'application/wasm','.json':'application/json'}
        response.writeHead(200, {...headers,'Content-Type':types[path.extname(file)] ?? 'application/octet-stream'})
        response.end(await readFile(file))
    } catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({headless:true}).catch(async error => { await new Promise(resolve=>server.close(resolve)); throw error })
const context = await browser.newContext()
const page = await context.newPage()
const report = {browser:browser.version(),cases:[],scope:'Native OPFS; deterministic injected API/close failures, not real device I/O failure or power loss'}
try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    report.cases = await page.evaluate(async () => {
        const {TermContentOpfsStore: Content} = await import('/ext/js/dictionary/term-content-opfs-store.js')
        const {TermRecordOpfsStore: Records} = await import('/ext/js/dictionary/term-record-opfs-store.js')
        const root = await navigator.storage.getDirectory()
        const results = []
        const check = (condition, message) => { if (!condition) throw new Error(message) }
        async function rejects(fn, message) { let failed=false; try { await fn() } catch { failed=true }; check(failed, message) }
        async function clear() { for await (const [name] of root.entries()) await root.removeEntry(name, {recursive:true}) }
        async function snapshot(directory=root, prefix='') {
            const files=[]
            for await (const [name,handle] of directory.entries()) {
                if (handle.kind === 'directory') files.push(...await snapshot(handle, `${prefix}${name}/`))
                else files.push([prefix+name,Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()))])
            }
            return files.sort((a,b)=>a[0].localeCompare(b[0]))
        }
        const entry = dictionary => ({dictionary, expression:'\ufeff猫', reading:'ねこ', expressionReverse:null, readingReverse:null,
            entryContentOffset:0, entryContentLength:2, entryContentDictName:'raw', score:1, sequence:17})
        async function seed() {
            const store = new Records()
            await store.prepare(); await store.beginImportSession(); await store.appendBatch([entry('Committed')]); await store.endImportSession()
            return {store,checkpoint:await store.createImportCheckpoint(),before:await snapshot()}
        }
        async function append(store) { await store.beginImportSession(); await store.appendBatch([entry('Unpublished')]); await store.endImportSession() }
        async function verify(store, before) {
            check(JSON.stringify(await snapshot()) === JSON.stringify(before), 'Persisted bytes differ from checkpoint')
            await store.ensureDictionariesLoaded(['Committed','Unpublished'])
            check(store.getDictionaryRecordCount('Committed') === 1, 'Committed record missing')
            check(store.getDictionaryRecordCount('Unpublished') === 0, 'Unpublished record retained')
            check(store.findTermIds('Committed','\ufeff猫','expression').length === 1, 'Reopened Unicode lookup mismatch')
        }
        async function test(name, fn) {
            await clear()
            try { await fn(); results.push({name,passed:true}) }
            catch (error) { results.push({name,passed:false,error:error.stack || String(error)}) }
        }
        await test('fresh record instance restores persisted checkpoint', async () => {
            const {store,checkpoint,before}=await seed(); await append(store)
            const fresh=new Records(); await fresh.rollbackImportSession(checkpoint); await verify(fresh,before)
        })
        await test('failed reload reacquires native directory and retries', async () => {
            const {store,checkpoint,before}=await seed(); await append(store)
            const original=navigator.storage.getDirectory.bind(navigator.storage)
            Object.defineProperty(navigator.storage,'getDirectory',{configurable:true,value:async()=>{throw new Error('injected directory fault')}})
            try { await rejects(()=>store.rollbackImportSession(checkpoint),'Reload should fail') }
            finally { delete navigator.storage.getDirectory }
            check(store._recordsDirectoryHandle===null,'Failed reload did not discard handles')
            check((await original()).kind==='directory','Native directory was not restored')
            await rejects(()=>store.beginImportSession(),'Import accepted after failed recovery')
            await store.rollbackImportSession(checkpoint); await verify(store,before)
        })
        await test('missing committed shard is rejected before native destructive writes', async () => {
            const {store,checkpoint}=await seed(); await append(store)
            const dir=await root.getDirectoryHandle('manabitan-term-records')
            await dir.removeEntry(checkpoint.shards[0].fileName)
            const damaged=await snapshot(), fresh=new Records()
            await rejects(()=>fresh.rollbackImportSession(checkpoint),'Missing shard accepted')
            check(JSON.stringify(await snapshot())===JSON.stringify(damaged),'Recovery modified damaged storage')
            await rejects(()=>fresh.endImportSession(),'Failed recovery reported finalization success')
        })
        await test('fresh empty checkpoint deletes uncommitted native shards', async () => {
            await seed()
            const fresh=new Records(); await fresh.rollbackImportSession({shards:[]})
            check((await snapshot()).length===0,'Empty recovery retained record files')
            await fresh.beginImportSession(); await fresh.appendBatch([entry('After recovery')]); await fresh.endImportSession()
            await fresh.ensureDictionariesLoaded(['After recovery'])
            check(fresh.getDictionaryRecordCount('After recovery')===1,'Recovered store unusable')
        })
        await test('missing nonempty native checkpoint directory is not recreated', async () => {
            const {checkpoint}=await seed()
            await root.removeEntry('manabitan-term-records',{recursive:true})
            await rejects(()=>new Records().rollbackImportSession(checkpoint),'Missing directory accepted')
            await rejects(()=>root.getDirectoryHandle('manabitan-term-records'),'Missing checkpoint directory recreated')
        })
        await test('aborted native content close remains failed until real rollback', async () => {
            const store=new Content(); await store.prepare(); await store.beginImportSession(); await store.append(new Uint8Array([90,91])); await store.endImportSession()
            const checkpoint=await store.createImportCheckpoint(), before=await snapshot()
            await store.beginImportSession(); await store.append(new Uint8Array([1,2,3]))
            const writable=store._writable, abort=writable.abort.bind(writable), fault=new Error('injected close failure after native abort')
            writable.close=async()=>{await abort(); throw fault}
            await rejects(()=>store.endImportSession(),'Aborted native close reported success')
            await rejects(()=>store.endImportSession(),'Retry hid original native close failure')
            check(JSON.stringify(await snapshot())===JSON.stringify(before),'Aborted writes published')
            await store.rollbackImportSession(checkpoint)
            await store.beginImportSession(); await store.append(new Uint8Array([5,6])); await store.endImportSession()
            const fresh=new Content(); await fresh.prepare()
            check(JSON.stringify(Array.from(await fresh.readSlice(0,4)))==='[90,91,5,6]','Recovered content persisted incorrectly')
        })
        await clear()
        return results
    })
    report.passed=report.cases.filter(row=>row.passed).length
    report.failed=report.cases.length-report.passed
    console.log(JSON.stringify(report,null,2))
    await writeFile(output,JSON.stringify(report,null,2))
    if (report.failed) process.exitCode=1
} finally {
    await context.close(); await browser.close(); await new Promise(resolve=>server.close(resolve))
}
