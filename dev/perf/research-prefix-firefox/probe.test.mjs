import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {armPrefixGuardProbe} from './prefix-probe.mjs';
function setup({gecko=false,error=false}={}){
 const handlers=new Map(),requests=[];let ticks=0;
 const world={setTimeout:(fn)=>{queueMicrotask(fn);return 0;},performance:{now:()=>++ticks},__manabitanImportCompletionSequence:7,addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:(name)=>handlers.delete(name),chrome:{runtime:{lastError:null,sendMessage:(message,done)=>{requests.push(message);queueMicrotask(()=>done(error?{error:{message:'probe failure'}}:{result:{dictionaryEntries:message.params.text.startsWith('manabitan-absent')?[]:[{headwords:[{term:'日本'}]}]}}));}}}};
 world.window=world;const code='('+armPrefixGuardProbe.toString()+')()';vm.runInNewContext(gecko?code.replaceAll(/\bglobalThis\b/g,'window'):code,world);
 return {world,handlers,requests,emit:detail=>handlers.get('manabitan:dictionary-import-complete')?.({detail})};
}
test('uses current completion only and probes exact, prefix, suffix and ordinary miss',async()=>{const s=setup();s.emit({sequence:7,importRunCurrent:true});s.emit({sequence:8,importRunCurrent:false});assert.equal(s.world.__prefixGuardProbe,undefined);s.emit({sequence:8,importRunCurrent:true,completedAtMonotonicMs:0});const result=await s.world.__prefixGuardProbe;assert.equal(result.sequence,8);assert.equal(result.samples.length,12);assert.equal(result.missCount,0);assert.equal(s.requests.length,49);assert.equal(result.settled.length,36);assert.deepEqual([...new Set(s.requests.map(x=>x.params.details.matchType))],['exact','prefix','suffix']);assert.equal(s.handlers.size,0);assert(result.samples.every(x=>x.elapsedMs>=0&&x.count===1));});
test('serialized Gecko observer binds APIs and state to Window',async()=>{const s=setup({gecko:true});s.emit({sequence:8,importRunCurrent:true,completedAtMonotonicMs:0});assert.equal((await s.world.__prefixGuardProbe).samples.length,12);});
test('a backend error fails the probe instead of publishing empty success',async()=>{const s=setup({error:true});s.emit({sequence:8,importRunCurrent:true,completedAtMonotonicMs:0});await assert.rejects(s.world.__prefixGuardProbe,/probe failure/);});
