/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {readFileSync} from 'node:fs';
import {expect, test} from 'vitest';
import {createArtifactTermChunkSinkCompletion, takeArtifactTermChunkSinkCompletion} from '../ext/js/dictionary/term-content-ownership.js';

test('public parallel callbacks retain their legacy result assignability', async () => {
    const numericCallback = () => 12;
    /** @type {() => void} */
    const ordinaryVoidCallback = numericCallback;
    const callbacks = /** @satisfies {{
     * eager: Parameters<typeof import('../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunksParallel>[2],
     * deferred: Parameters<typeof import('../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunksParallelDeferred>[3],
     * lazy: Parameters<typeof import('../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunksParallelLazy>[3],
     * compressed: Parameters<typeof import('../ext/js/dictionary/term-bank-wasm-parser.js').parseTermBankWithWasmColumnChunksParallelCompressedLazy>[3],
     * }} */ ({
        eager: ordinaryVoidCallback,
        deferred: () => ({completed: true}),
        lazy: () => Promise.resolve({completion: 12}),
        compressed: async () => 12,
    });
    expect(callbacks.eager()).toBe(12);
    expect(callbacks.deferred()).toEqual({completed: true});
    await expect(callbacks.lazy()).resolves.toEqual({completion: 12});
    await expect(callbacks.compressed()).resolves.toBe(12);
});

// The class is intentionally private. Extract its current production text so
// the checks use its real run, worker-loop, lead-budget, failure, and disposal
// logic with deterministic worker transport. No parser or codec timings are
// measured here. Hosted Node uses native SharedArrayBuffer for the owned input.
const fixtureSource = String.raw`
function createParserFixture(ClassSource, HelperSource, specifications, onChunk, takeCompletion) {
 const owned = new WeakSet();
 const events = [], loaded = [], parsed = [], releases = [];
 const timers = new Map();let nextTimer=0,clock=0,cancelled=false;
 let stopReject;const stop = new Promise((_,reject)=>{stopReject=reject;});void stop.catch(()=>{});
 const SharedArrayBufferStandIn=typeof globalThis.SharedArrayBuffer==='function'?globalThis.SharedArrayBuffer:class extends ArrayBuffer {};
 const cancellationError=()=>Object.assign(new Error('Cancelled'),{name:'AbortError'});
 const deps = {
  OWNED_PROJECTED_CONTENT_MIN_SOURCE_BYTES:1024*1024*1024,
  MIN_WINDOWS_FOR_INCREMENTAL_SOURCE_ACTIVATION:4,
  PARALLEL_WORKER_CANCELLATION_POLL_MS:50,
  snapshotTermBankExperiments:value=>({...value}),
  safePerformance:{now:()=>++clock},
  waitForParallelWork:async(promises,shouldCancel)=>{
   const value=await Promise.all(promises);
   if(shouldCancel())throw cancellationError();return value;
  },
  createParallelParserError:error=>error instanceof Error?error:new Error(String(error)),
  TermBankWasmResourceError:class TermBankWasmResourceError extends Error{},
  aggregateSequentialParseProfiles:(_profiles,rowCount,chunkDispatchMs)=>({rowCount,chunkDispatchMs}),
  getParallelSourceReadWallMs:()=>0,
  loadParallelTermBankSource:source=>{
   if(source.promise===null){loaded.push(source.index);source.promise=Promise.resolve(new Uint8Array([91,93]));}
   return source.promise;
  },
  getJsonArrayContentSpan:()=>({start:0,end:2}),
  isCompressedTermBankSource:()=>false,
  sumParallelSourceByteLengths:group=>group.reduce((n,x)=>n+x.byteLength,0),
  runParallelParserJob:async(worker,id,_group,_version,_options,shouldCancel)=>{
   const index=id-1,spec=specifications[index];parsed.push(index);events.push('parse:'+index);
   if(spec.parseGate)await Promise.race([spec.parseGate.promise,stop]);
   if(shouldCancel())throw cancellationError();
   if(spec.parseError)throw spec.parseError;
   const chunk=spec.empty?null:{rowCount:1,contentBytesBuffer:spec.source,id:index};
   if(chunk!==null&&spec.owned)owned.add(spec.source.buffer);
   return {chunk,rowCount:chunk===null?0:1,error:null,profile:{rowCount:chunk===null?0:1,chunkDispatchMs:0},finishedAt:++clock,borrowsWorkerMemory:spec.borrowed===true};
  },
  createParallelParserCancellationError:cancellationError,
  hasOwnedTermContent:source=>source instanceof Uint8Array&&owned.has(source.buffer),
  takeArtifactTermChunkSinkCompletion:takeCompletion,
  SharedArrayBuffer:SharedArrayBufferStandIn,
  setTimeout:callback=>{const id=++nextTimer;timers.set(id,callback);return id;},
  clearTimeout:id=>{timers.delete(id);},
 };
 const names=Object.keys(deps),values=Object.values(deps);
 const factory=new Function(...names,'let lastTermBankWasmParseProfile=null;\n'+HelperSource+ClassSource+'\nreturn {Run:ParallelTermBankPipelineRun,profile:()=>lastTermBankWasmParseProfile};');
 const {Run,profile}=factory(...values);
 for(const spec of specifications){
  spec.source=new Uint8Array(spec.private?new ArrayBuffer(8):new SharedArrayBufferStandIn(8));spec.source[0]=spec.id??0;
 }
 const sources=specifications.map((_,index)=>({index,promise:null,estimatedBytes:2,resolvedAt:0}));
 const groups=sources.map(source=>[source]);
 const workers=[{id:0},{id:1}];
 let instance;
 const poolLease={getWorkers:async()=>({workers}),release:async keep=>{releases.push(keep);events.push('pool-release:'+keep);}};
 instance=new Run(sources,groups,sources.length*2,3,async(chunk,progress)=>{
  events.push('sink:'+chunk.id);
  return await onChunk(chunk,progress,{run:instance,owned,events});
 },{},()=>cancelled,poolLease,2);
 const fail=instance._fail.bind(instance);
 instance._fail=error=>{fail(error);stopReject(error);};
 return {run:instance,events,loaded,parsed,releases,profile,timers,owned,cancel:()=>{cancelled=true;},fail:error=>instance._fail(error),start:()=>instance.run()};
}
`;

const checksSource = String.raw`
async function runParserChecks(ClassSource, HelperSource, FactorySource, createCompletion, takeCompletion) {
 const createFixture=new Function(FactorySource+'\nreturn createParserFixture;')();
 const results=[];
 const assert=(condition,message)=>{if(!condition)throw new Error(message);};
 const equal=(actual,expected,message)=>assert(actual===expected,message+': expected '+String(expected)+', got '+String(actual));
 const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
 const observe=promise=>{const state={status:'pending'};promise.then(value=>{state.status='fulfilled';state.value=value;},reason=>{state.status='rejected';state.reason=reason;});return state;};
 const flush=async(n=250)=>{for(let i=0;i<n;i++)await Promise.resolve();};
 const finished=async(state,label)=>{await flush();assert(state.status!=='pending',label+' deadlocked');return state;};
 const spec=(extra={})=>({owned:true,...extra});
 const run=async(name,body)=>{try{results.push({name,status:'passed',detail:await body()});}catch(error){results.push({name,status:'failed',error:String(error),stack:error?.stack});}};
 const fixture=(specs,sink)=>createFixture(ClassSource,HelperSource,specs,sink,takeCompletion);
 const ticket=completion=>createCompletion(completion);

 await run('one owned lookahead preserves source lead and byte budget until completion',async()=>{
  const gates=Array.from({length:6},gate),calls=[];
  const h=fixture(Array.from({length:6},()=>spec()),(chunk,_progress,{owned})=>{
   calls.push(chunk.id);owned.delete(chunk.contentBytesBuffer.buffer);return ticket(gates[chunk.id].promise);
  });
  const state=observe(h.start());await flush();
  equal(calls.join(','),'0,1','initial sink admission');
  equal(h.parsed.join(','),'0,1,2,3','initial parser lead');
  equal(h.loaded.join(','),'0,1,2,3','initial source activation');
  equal(h.run._nextSinkGroupIndex,0,'no early sink advancement');
  equal(h.run._queuedOwnedContentBytes,32,'no early byte release');
  gates[0].resolve();await flush();
  equal(calls.join(','),'0,1,2','one next callback after completion');
  equal(h.run._nextSinkGroupIndex,1,'completed sink advancement');
  equal(h.parsed.join(','),'0,1,2,3,4','lead advanced exactly once');
  equal(h.loaded.join(','),'0,1,2,3,4','source activation advanced exactly once');
  equal(h.run._queuedOwnedContentBytes,32,'byte budget remains bounded');
  gates[1].resolve();await flush();equal(h.run._nextSinkGroupIndex,2,'second completion advancement');
  for(const item of gates)item.resolve();await finished(state,'owned lookahead success');
  equal(state.status,'fulfilled','success status');equal(h.run._queuedOwnedContentBytes,0,'all owned bytes retired');
  equal(h.run._nextSinkGroupIndex,6,'all sink groups retired');
  equal(h.profile().parallelPeakQueuedOwnedContentBytes,32,'peak budget unchanged');
  equal(h.profile().rowCount,6,'profile row count');equal(h.releases.join(','),'true','successful worker lease');
  equal(h.timers.size,0,'lead timers leaked');return h.events;
 });

 await run('borrowed next result waits predecessor and its own ticket blocks later callbacks',async()=>{
  const first=gate(),borrowed=gate(),last=gate(),calls=[];
  const h=fixture([spec(),spec({owned:false,borrowed:true}),spec()],chunk=>{
   calls.push(chunk.id);return ticket([first,borrowed,last][chunk.id].promise);
  });
  const state=observe(h.start());await flush();
  equal(calls.join(','),'0','borrowed callback admitted before predecessor completion');
  first.resolve();await flush();equal(calls.join(','),'0,1','borrowed callback did not start');
  equal(h.run._nextSinkGroupIndex,1,'borrowed publication advanced completed sink');
  equal(h.run._pendingResultConsumers.size,0,'active borrowed lease still globally releasable');
  borrowed.resolve();await flush();equal(calls.join(','),'0,1,2','later callback did not resume');
  last.resolve();await finished(state,'borrowed ticket success');equal(state.status,'fulfilled','borrowed success');
  equal(h.releases.join(','),'true','borrowed worker lease');return h.events;
 });

 await run('unwitnessed and private results never overlap pending storage',async()=>{
  for(const variant of [{owned:false},{owned:true,private:true}]){
   const first=gate(),second=gate(),calls=[];
   const h=fixture([spec(),spec(variant)],chunk=>{calls.push(chunk.id);return ticket((chunk.id===0?first:second).promise);});
   const state=observe(h.start());await flush();equal(calls.join(','),'0','unowned callback overlapped predecessor');
   first.resolve();await flush();equal(calls.join(','),'0,1','unowned callback did not resume');
   equal(h.run._nextSinkGroupIndex,1,'unowned ticket advanced sink early');second.resolve();
   await finished(state,'unowned ticket completion');equal(state.status,'fulfilled','unowned status');
  }
  return 'both variants remained serial';
 });

 await run('peer failure retains active borrowed ticket lease until storage completion',async()=>{
  const borrowed=gate(),parsePeer=gate(),error=new Error('peer parser failure');
  const h=fixture([spec({owned:false,borrowed:true}),spec({parseGate:parsePeer})],()=>(ticket(borrowed.promise)));
  const state=observe(h.start());await flush();
  equal(h.run._pendingResultConsumers.size,0,'active borrowed lease not shielded');
  parsePeer.reject(error);await flush();equal(state.status,'pending','run released storage early');
  equal(h.releases.length,0,'pool released while borrowed source live');
  const workerState=observe(Promise.allSettled(h.run._workerLoops));await flush();
  equal(workerState.status,'pending','borrowed parser resumed before sink completed');
  borrowed.resolve();await finished(state,'peer failure with borrowed ticket');
  equal(state.reason,error,'peer failure identity');equal(h.releases.join(','),'false','failed worker lease');return h.events;
 });

 await run('peer failure also retains legacy active borrowed callback lease',async()=>{
  const callback=gate(),parsePeer=gate(),error=new Error('legacy peer parser failure');
  const h=fixture([spec({owned:false,borrowed:true}),spec({parseGate:parsePeer})],async()=>{await callback.promise;});
  const state=observe(h.start());await flush();parsePeer.reject(error);await flush();
  equal(h.releases.length,0,'legacy borrowed source released early');
  const workerState=observe(Promise.allSettled(h.run._workerLoops));await flush();equal(workerState.status,'pending','legacy borrowed parser resumed early');
  callback.resolve();await finished(state,'legacy borrowed callback failure');
  equal(state.reason,error,'legacy peer error');return h.events;
 });

 await run('callback exception drains admitted predecessor before pool release',async()=>{
  const first=gate(),error=new Error('successor callback failed');
  const h=fixture([spec(),spec()],chunk=>{if(chunk.id===1)throw error;return ticket(first.promise);});
  const state=observe(h.start());await flush();equal(state.status,'pending','failed callback abandoned predecessor');
  equal(h.releases.length,0,'pool released with prior storage pending');equal(h.run._queuedOwnedContentBytes,16,'failed callback released active owners early');
  first.resolve();await finished(state,'callback exception drain');
  equal(state.reason,error,'callback error identity');equal(h.run._queuedOwnedContentBytes,0,'callback failure owned bytes');return h.events;
 });

 await run('ticket rejection wakes a wait for the next parser result',async()=>{
  const first=gate(),nextParse=gate(),error=new Error('storage failed while next parser pending');
  const h=fixture([spec(),spec({parseGate:nextParse})],()=>(ticket(first.promise)));
  const state=observe(h.start());await flush();first.reject(error);
  await finished(state,'storage failure waiting result');equal(state.reason,error,'storage rejection identity');
  equal(h.releases.join(','),'false','failure waiting result lease');return h.events;
 });

 await run('parser failure waiting next result drains earlier storage ticket',async()=>{
  const first=gate(),nextParse=gate(),error=new Error('next parser result failed');
  const h=fixture([spec(),spec({parseGate:nextParse})],()=>(ticket(first.promise)));
  const state=observe(h.start());await flush();nextParse.reject(error);await flush();
  equal(state.status,'pending','parser failure abandoned storage owner');equal(h.releases.length,0,'parser failure released pool early');
  first.resolve();await finished(state,'parser failure drain');equal(state.reason,error,'parser error identity');return h.events;
 });

 await run('late successor ticket remains owned after predecessor failure during callback',async()=>{
  const first=gate(),callback=gate(),second=gate(),error=new Error('predecessor failed during callback');
  const h=fixture([spec(),spec()],async chunk=>{
   if(chunk.id===0)return ticket(first.promise);
   await callback.promise;return ticket(second.promise);
  });
  const state=observe(h.start());await flush();first.reject(error);await flush();equal(h.releases.length,0,'pool released while callback active');
  callback.resolve();await flush();equal(state.status,'pending','late successor completion was lost');
  equal(h.releases.length,0,'late successor source released early');second.resolve();
  await finished(state,'late successor drain');equal(state.reason,error,'first failure identity');equal(h.run._queuedOwnedContentBytes,0,'late ticket byte retirement');return h.events;
 });

 await run('cancellation during final ticket cannot report successful parse',async()=>{
  const first=gate(),last=gate();
  const h=fixture([spec(),spec()],chunk=>(ticket((chunk.id===0?first:last).promise)));
  const state=observe(h.start());await flush();first.resolve();await flush();
  equal(h.run._nextSinkGroupIndex,1,'pre-final completion index');h.cancel();last.resolve();
  await finished(state,'final ticket cancellation');equal(state.status,'rejected','cancel status');equal(state.reason.name,'AbortError','cancel error');
  equal(h.releases.join(','),'false','cancelled worker lease');equal(h.profile(),null,'cancelled profile should not publish');return h.events;
 });

 await run('empty result cannot jump an outstanding ticket or invent sink work',async()=>{
  const first=gate(),calls=[];
  const h=fixture([spec(),spec({empty:true})],chunk=>{calls.push(chunk.id);return ticket(first.promise);});
  const state=observe(h.start());await flush();equal(h.run._nextSinkGroupIndex,0,'empty group skipped prior completion');equal(calls.join(','),'0','empty callback invented');
  first.resolve();await finished(state,'empty group drain');equal(state.status,'fulfilled','empty success');
  equal(h.profile().rowCount,1,'empty profile rows');equal(h.run._nextSinkGroupIndex,2,'empty group retirement');return h.events;
 });

 await run('legacy void callbacks retain ordered completion semantics',async()=>{
  const first=gate(),calls=[];
  const h=fixture([spec(),spec(),spec()],async chunk=>{calls.push(chunk.id);if(chunk.id===0)await first.promise;});
  const state=observe(h.start());await flush();equal(calls.join(','),'0','legacy callback overlap introduced');
  equal(h.run._nextSinkGroupIndex,0,'legacy work retired early');first.resolve();
  await finished(state,'legacy void callbacks');equal(calls.join(','),'0,1,2','legacy order');equal(state.status,'fulfilled','legacy status');return h.events;
 });

 await run('invalid internal ticket construction still drains prior admitted completion',async()=>{
  const first=gate();
  const h=fixture([spec(),spec()],chunk=>chunk.id===0?ticket(first.promise):ticket(123));
  const state=observe(h.start());await flush();equal(state.status,'pending','invalid ticket abandoned prior completion');
  first.resolve();await finished(state,'invalid ticket drain');assert(state.reason instanceof TypeError,'invalid ticket did not reject type');
  equal(h.releases.join(','),'false','invalid ticket pool lease');return h.events;
 });

 await run('ordinary values and incidental completion properties retain legacy void behavior',async()=>{
  const unused=gate(),first=gate(),calls=[];
  const getter=Object.defineProperty({},'completion',{get(){throw new Error('ordinary completion getter was read');}});
  const values=[12,{done:true},null,{completion:unused.promise},getter];
  const h=fixture(values.map(()=>spec()),async chunk=>{
   calls.push(chunk.id);if(chunk.id===0)await first.promise;return values[chunk.id];
  });
  const state=observe(h.start());await flush();equal(calls.join(','),'0','ordinary promise returned before fulfillment');
  first.resolve();await finished(state,'ordinary incidental return values');
  equal(state.status,'fulfilled','ordinary return values rejected');equal(calls.join(','),'0,1,2,3,4','ordinary order');
  equal(h.run._queuedOwnedContentBytes,0,'ordinary values retained content');equal(h.releases.join(','),'true','ordinary pool lease');return h.events;
 });

 await run('ordinary thenables are awaited and their resolved values are ignored',async()=>{
  const first=gate(),unused=gate(),calls=[];let thenCalls=0;
  const h=fixture([spec(),spec()],chunk=>{
   calls.push(chunk.id);return {then(resolve){thenCalls++;void first.promise.then(()=>resolve({completion:unused.promise}));}};
  });
  const state=observe(h.start());await flush();equal(calls.join(','),'0','thenable bypassed ordinary callback join');
  equal(thenCalls,1,'first thenable was not awaited once');first.resolve();await finished(state,'ordinary thenable completion');
  equal(state.status,'fulfilled','resolved incidental completion was treated as a ticket');equal(thenCalls,2,'thenable count');
  equal(calls.join(','),'0,1','thenable callback order');return h.events;
 });

 await run('copied inherited and proxied ticket shapes cannot claim a producer completion',async()=>{
  const pending=gate(),calls=[],original=ticket(pending.promise);
  const values=[{...original},Object.create(original),new Proxy(original,{}),original];
  const h=fixture(values.map(()=>spec()),chunk=>{calls.push(chunk.id);return values[chunk.id];});
  const state=observe(h.start());await flush();equal(calls.join(','),'0,1,2,3','borrowed ticket shape acquired completion');
  equal(state.status,'pending','genuine completion was not joined');pending.resolve();await finished(state,'genuine ticket after borrowed shapes');
  equal(state.status,'fulfilled','borrowed shapes consumed genuine owner');return h.events;
 });

 await run('authentic ticket reuse fails only after its previously admitted work drains',async()=>{
  const pending=gate(),original=ticket(pending.promise),calls=[];
  const h=fixture([spec(),spec()],chunk=>{calls.push(chunk.id);return original;});
  const state=observe(h.start());await flush();equal(calls.join(','),'0,1','reuse schedule');
  equal(state.status,'pending','reuse abandoned the first completion');pending.resolve();await finished(state,'reused completion drain');
  assert(state.reason instanceof TypeError,'authentic ticket reuse was not rejected');
  assert(/already claimed/.test(String(state.reason)),'reuse failure lost its cause');equal(h.releases.join(','),'false','reused ticket worker lease');return h.events;
 });

 return {kind:'actual extracted ParallelTermBankPipelineRun control-flow component; fake worker transport; native SharedArrayBuffer when available, stand-in otherwise; no browser/native parser/DB execution',total:results.length,passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results};
}
`;

/** @typedef {{name: string, status: string, error?: string}} CheckResult */
/** @typedef {{total: number, passed: number, failed: number, results: CheckResult[]}} CheckReport */

test('retains parser budgets and source leases until admitted sink tickets complete', async () => {
    const source = readFileSync(new URL('../ext/js/dictionary/term-bank-wasm-parser.js', import.meta.url), 'utf8');
    const helperStart = source.indexOf('function getTermBankChunkSinkCompletion(');
    const classStart = source.indexOf('class ParallelTermBankPipelineRun {');
    const classEnd = source.indexOf('const parallelTermBankParserPool =', classStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(classStart).toBeGreaterThan(helperStart);
    expect(classEnd).toBeGreaterThan(classStart);
    const runChecks = /** @type {(classSource: string, helperSource: string, fixture: string, createCompletion: typeof createArtifactTermChunkSinkCompletion, takeCompletion: typeof takeArtifactTermChunkSinkCompletion) => Promise<CheckReport>} */ (
        new Function(checksSource + '\nreturn runParserChecks;')()
    );
    const report = await runChecks(
        source.slice(classStart, classEnd),
        source.slice(helperStart, classStart),
        fixtureSource,
        createArtifactTermChunkSinkCompletion,
        takeArtifactTermChunkSinkCompletion,
    );
    expect(report.total).toBe(17);
    expect(report.results.filter(({status}) => status !== 'passed')).toEqual([]);
    expect(report.passed).toBe(17);
    expect(report.failed).toBe(0);
});
