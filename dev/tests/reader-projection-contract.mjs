import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exactReaderEntries, readerEntriesWithSurface} from '../../ext/js/app/reader-lookup-bridge.js';
const request={term:'見る',reading:'みる',surface:'見られなかった',sentence:'見られなかった。',offset:0};
function entry(){return {
 type:'term',isPrimary:true,matchPrimaryReading:false,score:10,frequencyOrder:1,dictionaryIndex:0,dictionaryAlias:'unrelated',
 sourceTermExactMatchCount:2,maxOriginalTextLength:2,textProcessorRuleChainCandidates:[['unrelated']],inflectionRuleChainCandidates:[{source:'dictionary',inflectionRules:[{name:'unrelated'}]}],
 headwords:[{index:0,headwordIndex:0,term:'観る',reading:'みる',tags:[],wordClasses:[],sources:[{isPrimary:true,originalText:'見る',matchType:'exact'}]},
 {index:1,headwordIndex:1,term:'見る',reading:'みる',tags:[],wordClasses:[],sources:[{isPrimary:true,originalText:'見る',matchType:'exact'}]}],
 definitions:[{index:0,headwordIndices:[0],id:10,sequences:[10],dictionaryIndex:0,dictionaryAlias:'wrong',score:10,frequencyOrder:1,entries:['unrelated']},
 {index:1,headwordIndices:[1,0],id:20,sequences:[20],dictionaryIndex:2,dictionaryAlias:'right',score:5,frequencyOrder:3,entries:['shared definition']}],
 frequencies:[{index:0,headwordIndex:0,frequency:10},{index:1,headwordIndex:1,frequency:100}],
 pronunciations:[{index:0,headwordIndex:0,pronunciations:[1]},{index:1,headwordIndex:1,pronunciations:[2]}]
};}
test('mixed group keeps exact headword and remaps every dependent index',()=>{
 const input=entry(),before=structuredClone(input);const [result]=exactReaderEntries([input],request);
 assert.equal(result.headwords.length,1);assert.equal(result.headwords[0].term,'見る');assert.equal(result.headwords[0].index,1);assert.equal(result.headwords[0].headwordIndex,0);
 assert.equal(result.definitions.length,1);assert.deepEqual(result.definitions[0].headwordIndices,[0]);assert.equal(result.definitions[0].id,20);assert.equal(result.definitions[0].index,1);
 assert.equal(result.frequencies.length,1);assert.equal(result.frequencies[0].headwordIndex,0);assert.equal(result.frequencies[0].frequency,100);
 assert.deepEqual(result.pronunciations[0].pronunciations,[2]);assert.equal(result.pronunciations[0].headwordIndex,0);
 assert.equal(result.dictionaryAlias,'right');assert.equal(result.score,5);assert.deepEqual(result.inflectionRuleChainCandidates,[]);assert.deepEqual(input,before);
});
test('projected entry keeps real inflected mining span rather than lemma length',()=>{
 const [result]=readerEntriesWithSurface(exactReaderEntries([entry()],request),request);
 assert.equal(result.maxOriginalTextLength,request.surface.length);assert.equal(result.headwords[0].sources[0].originalText,request.surface);
});
test('matched word with no attached definitions does not inherit unrelated meaning',()=>{
 const e=entry();e.definitions=e.definitions.slice(0,1);assert.deepEqual(exactReaderEntries([e],request),[]);
});
test('different reading is excluded and malformed relationships are not guessed',()=>{
 assert.deepEqual(exactReaderEntries([entry()],{...request,reading:'けん'}),[]);
 const e=entry();e.headwords[1].headwordIndex=99;assert.deepEqual(exactReaderEntries([e],request),[]);
});
test('original headword order may differ from the remapped relationship index',()=>{
 const e=entry();e.headwords[1].index=99;
 const [result]=exactReaderEntries([e],request);
 assert.equal(result.headwords[0].index,99);assert.equal(result.headwords[0].headwordIndex,0);
 assert.deepEqual(result.definitions[0].headwordIndices,[0]);
});
