import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {Worker} from 'node:worker_threads'
import {pathToFileURL} from 'node:url'
const root=process.cwd()
const bootstrap=`import {parentPort,workerData} from 'node:worker_threads'
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'
const base=workerData.root
const zstd=await import(pathToFileURL(base+'/ext/lib/zstd-wasm.js').href)
await zstd.init('data:application/wasm;base64,'+fs.readFileSync(base+'/dev/data/zstd-simd.wasm').toString('base64'))
globalThis.fetch=async url=>{if(url!=='/lib/zstd-dicts/jmdict.zdict')throw new Error('Unexpected fetch '+url);return new Response(fs.readFileSync(base+'/dev/data/zstd-dicts/jmdict.zdict'))}
globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer),addEventListener:(type,listener)=>{if(type!=='message')throw new Error(type);parentPort.on('message',data=>listener({data}))}}
await import(pathToFileURL(base+'/ext/js/dictionary/zstd-term-content-compression-worker.js').href)`
const workers=[]
class Adapter{
  calls=[]
  constructor(){this.worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{workerData:{root}})}
  addEventListener(type,cb){this.worker.on(type,type==='message'?data=>cb({data}):error=>cb({message:error.message}))}
  postMessage(data,transfer){this.calls.push({data,transfer});this.worker.postMessage(data,transfer)}
  terminate(){return this.worker.terminate()}
}
const load=p=>import(pathToFileURL(path.join(root,p)).href)
const zstd=await load('ext/lib/zstd-wasm.js')
await zstd.init('data:application/wasm;base64,'+fs.readFileSync('dev/data/zstd-simd.wasm').toString('base64'))
globalThis.fetch=async()=>new Response(fs.readFileSync('dev/data/zstd-dicts/jmdict.zdict'))
const codec=await load('ext/js/dictionary/zstd-term-content.js')
await codec.initializeTermContentZstd()
try{
 for(let i=0;i<4;i++){
   const a=new Adapter();workers.push(a)
   await new Promise((resolve,reject)=>{a.worker.once('error',reject);a.worker.once('message',m=>m.type==='ready'?resolve():reject(new Error(JSON.stringify(m))))})
 }
 const pool=new codec.TermContentCompressionPool(workers)
 let jobs=0
 for(const dict of [null,'jmdict'])for(const enabled of [false,true]){
   const opts={experimentalBalancedCompression:enabled}
   if(enabled||dict==='jmdict'){
     for(const w of workers)w.calls=[]
     const source=new Uint8Array(new SharedArrayBuffer(128*1024+9),7)
     for(let i=0;i<source.length;i++)source[i]=(i*71^(i>>5))&255
     const offsets=Uint32Array.of(0,321,8000,35000,4),lengths=Uint32Array.of(300,701,4096,70000,300)
     const blocks=Uint32Array.of(0,1,2,3,4,5)
     const expected=Array.from(offsets,(offset,i)=>codec.compressWrappedTermContentZstd(source.subarray(offset,offset+lengths[i]),dict,opts).bytes)
     const operation=pool.beginCompressWrappedSpans(source,offsets,lengths,blocks,lengths,dict,opts)
     await operation.sourceConsumed
     source.fill(0)
     assert.deepEqual((await operation.completion).chunks,expected)
     assert.deepEqual(workers.map(w=>w.calls.length),[2,1,1,1])
     jobs+=5
   }
   for(const w of workers)w.calls=[]
   const contents=Array.from({length:9},(_,i)=>new Uint8Array(65536+i).fill(50+i))
   const baseline=contents.map(b=>codec.compressWrappedTermContentZstd(b,dict,opts).bytes)
   assert.deepEqual((await pool.compressWrapped(contents,dict,opts)).chunks,baseline)
   assert.ok(contents.every(x=>x.byteLength===0),'Actual transfer must detach packed buffers')
   assert.deepEqual(workers.map(w=>w.calls.length),[3,2,2,2])
   jobs+=9
 }
 const bad=pool.beginCompressWrappedSpans(new Uint8Array(new SharedArrayBuffer(8)),Uint32Array.of(8),Uint32Array.of(1),Uint32Array.of(0,1),Uint32Array.of(1),null,{experimentalBalancedCompression:true})
 await assert.rejects(bad.sourceConsumed)
 await assert.rejects(bad.completion)
 pool.close()
 const receipt={status:'success',jobs,malformedWorkerRejection:true,notes:'Actual Node worker threads load the production worker entrypoint; exact compiled codec bytes, real message transfers, shared-source consumption, packed detachment and unchanged four-worker scheduling'}
 const output=process.env.WORKER_CHECK_OUT??'builds/compression-worker-check.json'
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt))
}finally{await Promise.all(workers.map(w=>w.terminate()))}
