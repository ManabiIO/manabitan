// Scratch component screen. Preloaded captured content, unchanged codec and block bytes.
// It intentionally excludes parser scheduling, canonical dedup, record encoding and OPFS.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker as NodeWorker} from 'node:worker_threads';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const {values}=parseArgs({options:{
 root:{type:'string',default:'/workspace/scratch/da6c4dbd0097/baseline'},
 manifest:{type:'string',default:'/workspace/scratch/da6c4dbd0097/profiling/compression-groups/jmdict/manifest.json'},
 rounds:{type:'string',default:'4'},
 out:{type:'string',default:'/workspace/scratch/da6c4dbd0097/profiling/compression-scheduling-screen.json'},
 modes:{type:'string',default:'serial,lookahead-reset,lookahead-rotate'},
}});
const root=path.resolve(values.root),manifest=JSON.parse(await readFile(values.manifest));assert(manifest.complete);
const modes=values.modes.split(',');for(const mode of modes)assert(['serial','control','lookahead-reset','lookahead-rotate'].includes(mode));
const rounds=Number(values.rounds);assert(Number.isInteger(rounds)&&rounds>0);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [file,hash]of Object.entries(manifest.sourceHashes))assert.equal(sha(await readFile(path.join(root,file))),hash);
const codec=await import(pathToFileURL(path.join(root,'ext/js/dictionary/zstd-term-content.js')));
const groupData=[];
for(const g of manifest.groups){
 const directory=path.dirname(values.manifest);
 const raw=await readFile(path.join(directory,g.sourceFile)),offsets=await readFile(path.join(directory,g.offsetsFile)),lengths=await readFile(path.join(directory,g.lengthsFile));
 assert.equal(sha(raw),g.sourceSha256);assert.equal(sha(offsets),g.offsetsSha256);assert.equal(sha(lengths),g.lengthsSha256);
 const source=new Uint8Array(new SharedArrayBuffer(raw.length));source.set(raw);
 const sourceOffsets=Uint32Array.from(new Uint32Array(offsets.buffer,offsets.byteOffset,offsets.byteLength/4));
 const sourceLengths=Uint32Array.from(new Uint32Array(lengths.buffer,lengths.byteOffset,lengths.byteLength/4));
 groupData.push({...g,source,sourceOffsets,sourceLengths,blockStartIndexes:Uint32Array.from(g.blockStartIndexes),blockLengths:Uint32Array.from(g.blockLengths)});
}
const report={schemaVersion:3,blockTargetBytes:manifest.blockTargetBytes,blockPlanOrigin:manifest.blockPlanOrigin,complete:false,scriptSha256:sha(await readFile(new URL(import.meta.url))),bridgeSha256:sha(await readFile(new URL('./compression-worker-node-bridge.mjs',import.meta.url))),host:{cpu:os.cpus()[0]?.model,logicalCpuCount:os.cpus().length,parallelism:os.availableParallelism(),memoryBytes:os.totalmem(),loadavg:os.loadavg()},scope:'Compression component only. All exact current native parser+canonical-dedup spans preloaded. Production TermContentCompressionPool and worker entry, four Node worker threads replacing browser transport; actual shipped Zstd module, dictionary, compression settings, source bytes, span order and 1MiB block boundaries computed using the frozen production database target and block planner. Lookahead keeps at most two groups pending. Rotate changes only group-to-worker assignment in this scratch experiment. Explicit GC before each observation outside timing; all six order permutations balanced when three arms.',
 node:process.version,fixture:manifest.fixture,gitSha:manifest.gitSha,manifestSha256:sha(await readFile(values.manifest)),rounds,modes,sourceHashes:manifest.sourceHashes,sourceGroupCount:groupData.length,sourceBytes:groupData.reduce((s,g)=>s+g.sourceBytes,0),inputBytes:groupData.reduce((s,g)=>s+g.uniqueContentBytes,0),blockCount:groupData.reduce((s,g)=>s+g.blockLengths.length,0),warmups:[],observations:[],failures:[]};
const save=()=>writeFile(values.out,JSON.stringify(report,null,2));
await mkdir(path.dirname(values.out),{recursive:true});await save();
const allWorkers=[];
class Adapter {
 constructor(index){
  this.index=index;this.listeners=new Map();this.jobs=[];this.byId=new Map();
  this.worker=new NodeWorker(new URL('./compression-worker-node-bridge.mjs',import.meta.url),{workerData:{entry:pathToFileURL(path.join(root,'ext/js/dictionary/zstd-term-content-compression-worker.js')).href},execArgv:[]});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.worker.on('message',data=>{
   if(data.type==='ready')this.resolveReady();if(data.type==='initialization-error')this.rejectReady(new Error(data.error));
   if(data.__componentMetrics){const job=this.byId.get(data.id);assert(job);Object.assign(job,data.__componentMetrics,{receivedNs:process.hrtime.bigint().toString(),outputBytes:data.compressed?.byteLength??0});}
   for(const listener of this.listeners.get('message')??[])listener({data});
  });
  this.worker.on('error',error=>{this.rejectReady(error);for(const listener of this.listeners.get('error')??[])listener({message:error.message,error});});
 }
 addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
 removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
 postMessage(message,transfer){const job={worker:this.index,id:message.id,dispatchedNs:process.hrtime.bigint().toString(),inputBytes:message.contentBytes??message.content?.byteLength,spans:message.sourceOffsets?.length,group:activeGroup};this.jobs.push(job);this.byId.set(message.id,job);this.worker.postMessage(message,transfer);}
 terminate(){return this.worker.terminate();}
 reset(){this.jobs=[];this.byId.clear();}
}
let activeGroup=-1;
for(let i=0;i<4;++i)allWorkers.push(new Adapter(i));
await Promise.all(allWorkers.map(w=>w.ready));
const pool=new codec.TermContentCompressionPool(allWorkers);
let expectedDigest=null,expectedOutputs=null;
async function run(mode,label){
 globalThis.gc?.();
 for(const w of allWorkers)w.reset();
 const outputs=new Array(groupData.length);let cursor=0,maxPending=0;
 const groupEvents=[];
 const startedNs=process.hrtime.bigint();
 function submit(index){
  const g=groupData[index];activeGroup=index;
  if(mode==='lookahead-rotate'){pool._workers=allWorkers.slice(cursor).concat(allWorkers.slice(0,cursor));cursor=(cursor+g.blockLengths.length)%4;}else pool._workers=allWorkers;
  const admittedNs=process.hrtime.bigint().toString();
  const operation=pool.beginCompressWrappedSpans(g.source,g.sourceOffsets,g.sourceLengths,g.blockStartIndexes,g.blockLengths,'jmdict');
  const event={index,admittedNs,blocks:g.blockLengths.length};groupEvents.push(event);
  operation.sourceConsumed.then(()=>{event.sourceConsumedNs=process.hrtime.bigint().toString();});
  return operation.completion.then(result=>{event.completedNs=process.hrtime.bigint().toString();outputs[index]=result.chunks;});
 }
 if(mode==='serial'||mode==='control'){for(let i=0;i<groupData.length;++i){maxPending=1;await submit(i);}}
 else {const pending=[];for(let i=0;i<groupData.length;++i){pending.push(submit(i));maxPending=Math.max(maxPending,pending.length);if(pending.length===2)await pending.shift();}await Promise.all(pending);}
 const endedNs=process.hrtime.bigint(),elapsedMs=Number(endedNs-startedNs)/1e6;
 const h=createHash('sha256');let outputBytes=0;const outputHashes=[];
 for(let i=0;i<outputs.length;++i){const group=[];for(const bytes of outputs[i]){h.update(bytes);outputBytes+=bytes.byteLength;group.push(sha(bytes));}outputHashes.push(group);}
 const digest=h.digest('hex');if(expectedDigest===null){expectedDigest=digest;expectedOutputs=outputHashes;}assert.equal(digest,expectedDigest);assert.deepEqual(outputHashes,expectedOutputs);
 const jobs=allWorkers.flatMap(w=>w.jobs);assert.equal(jobs.length,report.blockCount);
 const workerBusyMs=allWorkers.map(w=>w.jobs.reduce((s,j)=>s+Number(BigInt(j.endedNs)-BigInt(j.startedNs))/1e6,0));
 const queueMs=jobs.map(j=>Number(BigInt(j.startedNs)-BigInt(j.dispatchedNs))/1e6);
 const result={label,mode,elapsedMs,maxPendingGroups:maxPending,workerBusyMs,totalBusyMs:workerBusyMs.reduce((s,n)=>s+n,0),workerWallTimeFractions:workerBusyMs.map(n=>n/elapsedMs),queueWaitMs:queueMs.reduce((s,n)=>s+n,0),outputBytes,outputSha256:digest,outputBlockSha256:outputHashes,startedNs:startedNs.toString(),endedNs:endedNs.toString(),jobs,groupEvents};
 console.log(JSON.stringify({label,mode,elapsedMs,maxPending,workerBusyMs,outputBytes,digest}));
 return {result,outputs};
}
try {
 // Warm every context, including worker3 which reset-per-group baseline leaves idle.
 for(const mode of modes){const {result}=await run(mode,`warm-${mode}`);report.warmups.push(result);await save();}
 globalThis.gc?.();
 const orders=modes.length===3?[[0,1,2],[2,1,0],[1,0,2],[2,0,1],[0,2,1],[1,2,0]].map(order=>order.map(i=>modes[i])):[modes,[...modes].reverse()];
 for(let round=0;round<rounds;++round){
  const order=orders[round%orders.length];
  for(const mode of order){const {result}=await run(mode,`round-${round}`);report.observations.push({round,order,...result});await save();}
 }
 // Verify every output block using the unchanged production decoder outside timing.
 const {outputs}=await run('serial','verification-only');
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{const url=input instanceof URL?input:new URL(typeof input==='string'?input:input.url);if(url.protocol!=='file:')return originalFetch(input,options);return new Response(await readFile(url),{headers:{'Content-Type':url.pathname.endsWith('.wasm')?'application/wasm':'application/octet-stream'}});};
 await codec.initializeTermContentZstd();
 let checkedBlocks=0,checkedBytes=0;
 for(let i=0;i<outputs.length;++i)for(let j=0;j<outputs[i].length;++j){const decoded=codec.decompressTermContentZstd(outputs[i][j].subarray(12),'jmdict');assert.equal(decoded.byteLength,groupData[i].blockLengths[j]);assert.equal(sha(decoded),groupData[i].inputBlockSha256[j]);++checkedBlocks;checkedBytes+=decoded.byteLength;}
 report.roundtrip={checkedBlocks,checkedBytes};report.complete=true;await save();
}catch(error){report.failures.push({error:String(error),stack:error.stack});await save();throw error;}
finally{pool.close();await Promise.all(allWorkers.map(w=>w.terminate()));}
