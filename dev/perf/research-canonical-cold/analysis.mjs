import assert from 'node:assert/strict';
const median = xs => { const s=[...xs].sort((a,b)=>a-b); return s.length%2?s[s.length>>1]:(s[s.length/2-1]+s[s.length/2])/2; };
export function analyze(records, order) {
 assert.equal(order.length,8);assert.equal(records.length,16);
 const pairs=[];
 for(let i=0;i<order.length;++i){const [kind,sides]=order[i],r=records.slice(i*2,i*2+2);assert.deepEqual(r.map(x=>x.side),sides);const a=kind==='control'?r[0]:r.find(x=>x.side==='A'),b=kind==='control'?r[1]:r.find(x=>x.side==='B');assert.ok(a&&b);
 for(const x of r)for(const k of ['wallMs','cpuMs','maxRSSKiB'])assert.ok(Number.isFinite(x[k])&&x[k]>0);
 pairs.push({kind,order:sides,wallPercent:100*(b.wallMs/a.wallMs-1),cpuPercent:100*(b.cpuMs/a.cpuMs-1),rssUpliftKiB:b.maxRSSKiB-a.maxRSSKiB,rssUpliftPercent:100*(b.maxRSSKiB/a.maxRSSKiB-1)});}
 const candidates=pairs.filter(x=>x.kind==='candidate'),controls=pairs.filter(x=>x.kind==='control');assert.equal(candidates.length,4);assert.equal(controls.length,4);
 const wallMedianPercent=median(candidates.map(x=>x.wallPercent)),cpuMedianPercent=median(candidates.map(x=>x.cpuPercent)),maxAbsoluteAAWallPercent=Math.max(...controls.map(x=>Math.abs(x.wallPercent))),maxAbsoluteAACpuPercent=Math.max(...controls.map(x=>Math.abs(x.cpuPercent)));
 const gates={allWallPairsFaster:candidates.every(x=>x.wallPercent<0),wallMedianAtLeastFivePercent:wallMedianPercent<=-5,wallBeyondWorstAA:-wallMedianPercent>maxAbsoluteAAWallPercent,cpuBeyondWorstAA:-cpuMedianPercent>maxAbsoluteAACpuPercent,lifetimeRssEveryPairWithin128MiBAnd15Percent:candidates.every(x=>x.rssUpliftKiB<=128*1024&&x.rssUpliftPercent<=15)};
 return {classification:'Cold-native-module complete-owner component; no browser/full-import acceptance',pairs,wallMedianPercent,cpuMedianPercent,maxAbsoluteAAWallPercent,maxAbsoluteAACpuPercent,gates,passed:Object.values(gates).every(Boolean)};
}
