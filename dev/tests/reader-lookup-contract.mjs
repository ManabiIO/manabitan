import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseReaderLookup, exactReaderEntries} from '../../ext/js/app/reader-lookup-bridge.js';
const request={protocol:1,term:'食べる',reading:'たべる',surface:'食べた',sentence:'私は食べた。',offset:2};

test('document handoff validates original surface sentence offsets',()=>{
 assert.ok(parseReaderLookup(JSON.stringify(request)));assert.equal(parseReaderLookup(JSON.stringify({...request,offset:0})),null);
 for(const bad of [{term:''},{entryID:12},{entryID:'-1'},{namespace:'rowid'},{surface:'食べる'}]) assert.equal(parseReaderLookup(JSON.stringify({...request,...bad})),null);
});

test('exact popup refuses unrelated or mixed-headword mining results',()=>{
 const right={headwords:[{term:'食べる',reading:'たべる'}]}, wrong={headwords:[{term:'食べる',reading:'くう'}]}, mixed={headwords:[...right.headwords,{term:'喰う',reading:'くう'}]};
 assert.deepEqual(exactReaderEntries([right,wrong,mixed],request),[right]);
});

test('popup mining uses original inflected surface length without mutating cached entries',async()=>{
 const {readerEntriesWithSurface}=await import('../../ext/js/app/reader-lookup-bridge.js');
 const r={...request,surface:'食べさせられた',sentence:'私は食べさせられた。'};
 const input=[{maxOriginalTextLength:3,headwords:[{term:'食べる',reading:'たべる',sources:[{isPrimary:true,originalText:'食べる',deinflectedText:'食べる'}]}]}];
 const output=readerEntriesWithSurface(input,r);
 assert.equal(output[0].maxOriginalTextLength,r.surface.length);assert.equal(output[0].headwords[0].sources[0].originalText,r.surface);
 assert.equal(input[0].headwords[0].sources[0].originalText,'食べる');assert.equal(output[0].headwords[0].sources[0].deinflectedText,'食べる');
});
