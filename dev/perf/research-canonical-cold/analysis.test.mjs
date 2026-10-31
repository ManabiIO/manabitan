import test from 'node:test';import assert from 'node:assert/strict';import {analyze} from './analysis.mjs';
const order=[['candidate',['A','B']],['control',['A','A']],['candidate',['B','A']],['control',['A','A']],['candidate',['A','B']],['control',['A','A']],['candidate',['B','A']],['control',['A','A']]];
function records(){return order.flatMap(([kind,sides])=>sides.map(side=>({side,wallMs:side==='B'?90:100,cpuMs:side==='B'?90:100,maxRSSKiB:1000})));}
test('accepts consistent attributed cold-owner savings',()=>assert.equal(analyze(records(),order).passed,true));
test('rejects an opposite-signed candidate pair',()=>{const r=records();r[1].wallMs=101;assert.equal(analyze(r,order).gates.allWallPairsFaster,false);});
test('rejects wall effect inside AA variation',()=>{const r=records();r[3].wallMs=120;assert.equal(analyze(r,order).gates.wallBeyondWorstAA,false);});
test('rejects CPU effect inside AA variation',()=>{const r=records();r[3].cpuMs=120;assert.equal(analyze(r,order).gates.cpuBeyondWorstAA,false);});
test('requires both relative and absolute lifetime RSS guards',()=>{const r=records();r[1].maxRSSKiB=1200;assert.equal(analyze(r,order).gates.lifetimeRssEveryPairWithin128MiBAnd15Percent,false);const s=records().map(x=>({...x,maxRSSKiB:2e6}));s[1].maxRSSKiB+=128*1024+1;assert.equal(analyze(s,order).gates.lifetimeRssEveryPairWithin128MiBAnd15Percent,false);});
test('rejects less than five percent median wall improvement',()=>{const r=records();for(const x of r)if(x.side==='B')x.wallMs=96;assert.equal(analyze(r,order).gates.wallMedianAtLeastFivePercent,false);});
test('rejects dropped or reordered observations',()=>{assert.throws(()=>analyze(records().slice(1),order));const r=records();[r[0],r[1]]=[r[1],r[0]];assert.throws(()=>analyze(r,order));});
test('rejects nonfinite measurements',()=>{const r=records();r[0].wallMs=NaN;assert.throws(()=>analyze(r,order));});
