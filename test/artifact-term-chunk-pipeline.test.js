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

import {expect, test} from 'vitest';
import {ArtifactTermChunkPipeline} from '../ext/js/dictionary/artifact-term-chunk-pipeline.js';

// These deterministic dependency-injected cases exercise the actual coordinator.
// Persistence and native metadata mutation require separate integration tests.
const checksSource = String.raw`
async function runCoordinatorChecks(Pipeline) {
 const results = [];
 const assert = (condition, message) => { if (!condition) throw new Error(message); };
 const equal = (actual, expected, message) => assert(actual === expected, message + ': expected ' + String(expected) + ', got ' + String(actual));
 const gate = () => {
  let resolve, reject;
  const promise = new Promise((a,b) => {resolve = a; reject = b;});
  void promise.catch(() => {});
  return {promise, resolve, reject};
 };
 const observe = promise => {
  const state = {status: 'pending', value: undefined, reason: undefined};
  promise.then(value => {state.status = 'fulfilled';state.value = value;}, reason => {state.status = 'rejected';state.reason = reason;});
  return state;
 };
 const flush = async (n=120) => {for(let i=0;i<n;i++) await Promise.resolve();};
 const settled = async (state, label) => {await flush(); assert(state.status !== 'pending', label + ' deadlocked'); return state;};
 const throws = (fn, expected, label) => {
  let caught = false, value;
  try {fn();} catch(error) {caught=true;value=error;}
  assert(caught, label + ' did not throw');
  if(expected instanceof RegExp) assert(expected.test(String(value)), label + ' wrong error ' + String(value));
  else equal(value, expected, label + ' wrong error');
 };
 const job = (id, eligible=true, prepare=null) => ({id,eligible,prepare,content:gate(),records:gate(),metrics:{id,rows:id+1}});
 const harness = () => {
  const events = [], contexts = new Map(), jobs = [], ownerError = new Error('owner changed');
  let active=true, invalidChecks=0;
  const pipeline = new Pipeline({
   validateOwner: () => {if(!active){invalidChecks++;throw ownerError;}},
   canOverlap: chunk => chunk.eligible,
   append: async (chunk, context) => {
    const id=chunk.id, pending=[];
    jobs.push(chunk);contexts.set(id,context);events.push('reserve:'+id);
    try {
     if(chunk.prepare) await chunk.prepare.promise;
     context.throwIfStopped();
     events.push('compress:'+id);
     pending.push(chunk.content.promise);
     void chunk.content.promise.catch(context.failed);
     await context.beforePublication();
     events.push('publish:'+id);
     pending.push(chunk.records.promise);
     void chunk.records.promise.catch(context.failed);
     events.push('records:'+id);
     context.published();
     const states=await Promise.allSettled(pending);
     const failures=states.filter(x=>x.status==='rejected').map(x=>x.reason);
     if(failures.length===1) throw failures[0];
     if(failures.length>1) throw new AggregateError(failures,'content and records failed');
     context.throwIfStopped();
     events.push('complete:'+id);
     return chunk.metrics;
    } catch(error) {
     await Promise.allSettled(pending);
     await context.beforeRollback(error);
     events.push('rollback:'+id);
     throw error;
    }
   },
  });
  return {pipeline,events,contexts,jobs,ownerError,setActive:value=>{active=value;},invalidChecks:()=>invalidChecks,
   has:event=>events.includes(event),complete:chunk=>{chunk.content.resolve();chunk.records.resolve();}};
 };
 const run = async (name, body) => {
  try { const detail=await body(); results.push({name,status:'passed',detail}); }
  catch(error) {results.push({name,status:'failed',error:String(error),stack:error?.stack});}
 };

 await run('eligible successor prepares before predecessor completion; publication and metrics ordered', async()=>{
  const h=harness(),a=job(0),b=job(1),c=job(2);
  const x=h.pipeline.begin(a);await flush();assert(h.has('publish:0'),'first not published');
  const sx=observe(x.completion),y=h.pipeline.begin(b),sy=observe(y.completion),py=observe(y.published);
  await flush();
  assert(h.has('compress:1'),'successor compression not started');
  assert(!h.has('publish:1'),'successor published before predecessor complete');
  equal(sx.status,'pending','first completion');
  throws(()=>h.pipeline.begin(c),/one successor/,'third owner bound');
  a.content.resolve();await flush();assert(!h.has('publish:1'),'record completion not required');
  a.records.resolve();await settled(sx,'first completion');await flush();
  equal(sx.value,a.metrics,'first metrics identity');equal(py.status,'fulfilled','second publication');
  h.complete(b);await settled(sy,'second completion');equal(sy.value,b.metrics,'second metrics identity');
  equal(h.pipeline.getFailures().length,0,'unexpected terminal errors');
  await h.pipeline.close();return h.events;
 });

 await run('predecessor failure waits for successor preparation and reverses rollback', async()=>{
  const h=harness(),a=job(0),prepare=gate(),b=job(1,true,prepare),error=new Error('content failed');
  const x=h.pipeline.begin(a);await flush();const y=h.pipeline.begin(b),sx=observe(x.completion),sy=observe(y.completion);
  await flush();assert(h.has('reserve:1'),'successor not admitted');
  a.content.reject(error);a.records.resolve();await flush();
  throws(()=>h.pipeline.begin(job(2)),error,'immediate failure admission latch');
  equal(sx.status,'pending','predecessor must wait for successor');
  assert(!h.events.some(x=>x.startsWith('rollback:')),'rollback began while successor preparation blocked');
  prepare.resolve();await settled(sx,'predecessor failed completion');await settled(sy,'successor failed completion');
  equal(sx.reason,error,'predecessor error');equal(sy.reason,error,'successor error');
  equal(h.events.filter(x=>x.startsWith('rollback:')).join(','),'rollback:1,rollback:0','rollback order');
  assert(!h.has('compress:1'),'new compression started after failure latch');
  return h.events;
 });

 await run('predecessor failure drains successor compression before predecessor rollback', async()=>{
  const h=harness(),a=job(0),b=job(1),error=new Error('predecessor record failed');
  const x=h.pipeline.begin(a);await flush();const y=h.pipeline.begin(b),sx=observe(x.completion),sy=observe(y.completion);
  await flush();assert(h.has('compress:1'),'successor compression not admitted');
  a.records.reject(error);await flush();
  throws(()=>h.pipeline.begin(job(2)),error,'record failure admission latch');
  equal(sx.status,'pending','content owner still unresolved');
  a.content.resolve();await flush();
  equal(sx.status,'pending','predecessor failed to join successor');
  equal(sy.status,'pending','successor failed to drain compression');
  assert(!h.has('publish:1'),'successor publication escaped failure');
  b.content.resolve();await settled(sx,'predecessor failure');await settled(sy,'successor failure');
  equal(h.events.filter(x=>x.startsWith('rollback:')).join(','),'rollback:1,rollback:0','rollback order');
  return h.events;
 });

 await run('successor preparation failure does not deadlock pending predecessor', async()=>{
  const h=harness(),a=job(0),prepare=gate(),b=job(1,true,prepare),error=new Error('scan failed');
  const x=h.pipeline.begin(a);await flush();const y=h.pipeline.begin(b),sx=observe(x.completion),sy=observe(y.completion);
  await flush();prepare.reject(error);await settled(sy,'successor preparation failure');
  equal(sy.reason,error,'successor scan error');equal(sx.status,'pending','predecessor persistence still owned');
  h.complete(a);await settled(sx,'predecessor unwind');equal(sx.reason,error,'first failure preserved');
  equal(h.events.filter(x=>x.startsWith('rollback:')).join(','),'rollback:1,rollback:0','rollback order');
  return h.events;
 });

 await run('undefined rejection retains a distinct failed state', async()=>{
  const h=harness(),a=job(0),b=job(1);
  const x=h.pipeline.begin(a);await flush();const y=h.pipeline.begin(b),sx=observe(x.completion),sy=observe(y.completion);
  await flush();a.content.reject(undefined);a.records.resolve();await flush();b.content.resolve();
  await settled(sx,'undefined predecessor failure');await settled(sy,'undefined successor failure');
  equal(sx.status,'rejected','first rejection status');equal(sx.reason,undefined,'first rejection value');
  equal(sy.status,'rejected','second rejection status');equal(sy.reason,undefined,'second rejection value');
  throws(()=>h.pipeline.begin(job(2)),undefined,'undefined failure latch');
  const failures=h.pipeline.getFailures();equal(failures.length,1,'deduplicated undefined failure');equal(failures[0],undefined,'stored undefined failure');
  return h.events;
 });

 await run('terminal aggregate errors survive first-failure latch', async()=>{
  const h=harness(),a=job(0),content=new Error('content'),records=new Error('records');
  const x=h.pipeline.begin(a),sx=observe(x.completion);await flush();
  a.content.reject(content);a.records.reject(records);await settled(sx,'aggregate completion');
  assert(sx.reason instanceof AggregateError,'terminal error is not aggregate');
  equal(sx.reason.errors[0],content,'content error identity');equal(sx.reason.errors[1],records,'record error identity');
  const terminal=h.pipeline.getFailures();equal(terminal.length,1,'terminal failure count');equal(terminal[0],sx.reason,'terminal aggregate retained');
  const draining=observe(h.pipeline.close());await settled(draining,'aggregate close');equal(draining.reason,content,'first-error latch remains original');
  return {terminalCount:terminal.length,aggregateMembers:sx.reason.errors.map(x=>x.message)};
 });

 await run('forced serial request occupies bound and cannot be leapfrogged', async()=>{
  const h=harness(),a=job(0),b=job(1),c=job(2);
  const x=h.pipeline.begin(a);await flush();const serial=h.pipeline.appendSerial(b),ss=observe(serial);
  await flush();assert(!h.has('reserve:1'),'serial operation prepared early');
  throws(()=>h.pipeline.begin(c),/one successor/,'serial bound');
  h.complete(a);await flush();assert(h.has('publish:1'),'serial operation failed to start');
  const y=h.pipeline.begin(c),sy=observe(y.completion);await flush();
  assert(!h.has('reserve:2'),'later eligible owner leapfrogged serial operation');
  h.complete(b);await settled(ss,'serial completion');await flush();
  equal(ss.value,b.metrics,'serial metrics');assert(h.has('publish:2'),'third owner did not resume');
  h.complete(c);await settled(sy,'third completion');await x.completion;await h.pipeline.close();return h.events;
 });

 await run('ineligible successor touches no state until predecessor completion', async()=>{
  const h=harness(),a=job(0),b=job(1,false);
  const x=h.pipeline.begin(a);await flush();const y=h.pipeline.begin(b),py=observe(y.published),sy=observe(y.completion);
  await flush();assert(!h.has('reserve:1'),'ineligible successor mutated early');
  h.complete(a);await flush();assert(h.has('publish:1'),'ineligible successor did not run');
  equal(py.status,'pending','ineligible early publication');h.complete(b);
  await settled(sy,'ineligible completion');await flush();equal(py.status,'fulfilled','ineligible publication completion');await x.completion;
  return h.events;
 });

 await run('close fences new admission while draining and remains closed', async()=>{
  const h=harness(),a=job(0);const x=h.pipeline.begin(a);await flush();
  const closing=observe(h.pipeline.close());throws(()=>h.pipeline.begin(job(1)),/closed/,'close admission fence');
  equal(closing.status,'pending','close must drain active owner');h.complete(a);
  await settled(closing,'close completion');equal(closing.status,'fulfilled','close status');await x.completion;
  throws(()=>h.pipeline.begin(job(2)),/closed/,'retained close fence');return h.events;
 });

 await run('active cancellation outranks stale-owner validation', async()=>{
  const h=harness(),a=job(0),b=job(1),cancel=new Error('synthetic cancellation');
  const x=h.pipeline.begin(a);await flush();const y=h.pipeline.begin(b),sx=observe(x.completion),sy=observe(y.completion);
  await flush();h.pipeline.cancel(cancel);h.setActive(false);h.complete(a);await flush();b.content.resolve();
  await settled(sx,'cancelled predecessor');await settled(sy,'cancelled successor');
  equal(sx.reason,cancel,'predecessor cancellation reason');equal(sy.reason,cancel,'successor cancellation reason');
  equal(h.invalidChecks(),0,'active contexts validated stale owner after cancellation');
  throws(()=>h.pipeline.begin(job(2)),h.ownerError,'new admission still validates owner');
  return h.events;
 });

 await run('owner changes reject new and active operations without new mutation', async()=>{
  const h=harness(),a=job(0);const x=h.pipeline.begin(a),sx=observe(x.completion);await flush();
  h.setActive(false);throws(()=>h.pipeline.begin(job(1)),h.ownerError,'stale new owner');
  assert(!h.has('reserve:1'),'stale successor mutated');h.complete(a);await settled(sx,'stale active owner');
  equal(sx.reason,h.ownerError,'active ownership failure');return h.events;
 });

 await run('no early publication branch still settles both ticket phases', async()=>{
  const events=[],first=gate(),second=gate();
  const p=new Pipeline({canOverlap:()=>true,validateOwner:()=>{},append:async(chunk,context)=>{
   events.push('start:'+chunk.id);await chunk.g.promise;await context.beforePublication();return {id:chunk.id};
  }});
  const x=p.begin({id:0,g:first}),px=observe(x.published),sx=observe(x.completion),y=p.begin({id:1,g:second}),py=observe(y.published),sy=observe(y.completion);
  await flush();equal(events.join(','),'start:0','unpublished predecessor gating');equal(px.status,'pending','first publication pending');
  first.resolve();await settled(sx,'first fallback completion');await flush();equal(px.status,'fulfilled','first fallback publication');
  equal(events.join(','),'start:0,start:1','second fallback admission');equal(py.status,'pending','second fallback publication pending');
  second.resolve();await settled(sy,'second fallback completion');await flush();equal(py.status,'fulfilled','second fallback publication');await p.close();return events;
 });

 await run('synchronous append failure rejects publication and completion', async()=>{
  const error=new Error('append failed before database scope');
  const p=new Pipeline({canOverlap:()=>true,validateOwner:()=>{},append:()=>{throw error;}});
  const x=p.begin({}),px=observe(x.published),sx=observe(x.completion);
  await settled(sx,'synchronous append failure');await flush();equal(px.status,'rejected','publication rejection');equal(px.reason,error,'publication error');equal(sx.reason,error,'completion error');
  equal(p.getFailures()[0],error,'terminal failure');return {terminalCount:p.getFailures().length};
 });


 await run('coordinator rejects cancellation after fallback append returns without context checks', async()=>{
  const io=gate(),error=new Error('cancel while fallback I/O pending');
  const p=new Pipeline({append:async()=>{await io.promise;return{rows:1};},canOverlap:()=>false,validateOwner:()=>{}});
  const operation=p.begin({}),publication=observe(operation.published),completion=observe(operation.completion);
  await flush();p.cancel(error);io.resolve();
  await settled(completion,'fallback cancellation');await flush();
  equal(publication.status,'rejected','fallback publication rejection');
  equal(completion.status,'rejected','fallback completion rejection');
  equal(publication.reason,error,'fallback publication cancellation identity');
  equal(completion.reason,error,'fallback completion cancellation identity');
  return {publication:publication.status,completion:completion.status};
 });

 return {kind:'dependency-injected coordinator component only',total:results.length,passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results};
}
`;

/** @typedef {{name: string, status: string, error?: string}} CheckResult */
/** @typedef {{total: number, passed: number, failed: number, results: CheckResult[]}} CheckReport */

test('preserves bounded artifact append ordering, failure ownership, and cancellation', async () => {
    const runChecks = /** @type {(Pipeline: typeof ArtifactTermChunkPipeline) => Promise<CheckReport>} */ (
        new Function(checksSource + '\nreturn runCoordinatorChecks;')()
    );
    const report = await runChecks(ArtifactTermChunkPipeline);
    expect(report.total).toBe(14);
    expect(report.results.filter(({status}) => status !== 'passed')).toEqual([]);
    expect(report.passed).toBe(14);
    expect(report.failed).toBe(0);
});
