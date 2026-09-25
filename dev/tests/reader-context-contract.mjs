import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseReaderLookup} from '../../ext/js/app/reader-lookup-bridge.js';
const request={protocol:1,term:'食べる',reading:'たべる',surface:'食べた',offset:2,contextID:'sentence-1'};
const context={protocol:1,id:'sentence-1',text:'私は食べた。'};
test('one sentence context resolves to the original document lookup contract',()=>{
 const result=parseReaderLookup(JSON.stringify(request),JSON.stringify(context));
 assert.equal(result.sentence,'私は食べた。');assert.equal(result.offset,2);assert.equal(result.surface,'食べた');assert.ok(!('contextID' in result));
});
test('missing, foreign, ambiguous or malformed context cannot become a lookup',()=>{
 for(const c of [null,'not JSON',JSON.stringify({...context,id:'other'}),JSON.stringify({...context,text:'食べる'}),JSON.stringify({...context,protocol:2})]) assert.equal(parseReaderLookup(JSON.stringify(request),c),null);
 assert.equal(parseReaderLookup(JSON.stringify({...request,sentence:context.text}),JSON.stringify(context)),null);
});
test('context and sentence limits are checked after resolving the reference',()=>{
 assert.equal(parseReaderLookup(JSON.stringify(request),JSON.stringify({...context,text:'私'.repeat(17000)})),null);
 assert.equal(parseReaderLookup(JSON.stringify({...request,contextID:'x'.repeat(513)}),JSON.stringify(context)),null);
});
