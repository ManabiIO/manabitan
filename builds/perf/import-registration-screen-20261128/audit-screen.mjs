#!/usr/bin/env node
// Independent arithmetic audit. This does not execute a new import.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
function med(xs){xs=[...xs].sort((a,b)=>a-b);const n=xs.length;return n%2?xs[n>>1]:(xs[n/2-1]+xs[n/2])/2}
function compute(obs,kind,right){
 const p=new Map();for(const x of obs.filter(x=>x.kind===kind)){if(!p.has(x.pair))p.set(x.pair,{});p.get(x.pair)[x.arm]=x.totalImportMs;}
 const pairs=[...p].map(([id,v])=>({pair:id,baselineMs:v.A,comparisonMs:v[right],ratio:v[right]/v.A,changePercent:(v[right]/v.A-1)*100}));
 if(pairs.some(v=>!(v.baselineMs>0&&v.comparisonMs>0)))throw Error('Incomplete pair');
 const ratios=pairs.map(x=>x.ratio), n=ratios.length, N=n**n, boots=[];
 for(let j=0;j<N;j++){let k=j;const sample=[];for(let i=0;i<n;i++){sample.push(ratios[k%n]);k=Math.floor(k/n)}boots.push(med(sample))}
 boots.sort((a,b)=>a-b);
 return {count:n,pairs,ratios,medianPairedChangePercent:(med(ratios)-1)*100,equalWorkChangePercent:(pairs.reduce((t,x)=>t+x.comparisonMs,0)/pairs.reduce((t,x)=>t+x.baselineMs,0)-1)*100,worstPairChangePercent:(Math.max(...ratios)-1)*100,fasterPairs:ratios.filter(x=>x<1).length,exactEnumeratedBootstrap95Percent:[boots[Math.ceil(.025*N)-1],boots[Math.ceil(.975*N)-1]].map(x=>(x-1)*100),exactEnumeratedBootstrapSampleCount:N};
}
const evidence = JSON.parse(await readFile(process.argv[2] ?? new URL('./hosted-46102503309.json', import.meta.url), 'utf8'));
const output = [];
for (const corpus of evidence.corpora) {
    const data = corpus.originalCompactEvidence;
    const candidate = compute(data['observations.json'], 'candidate', 'B');
    const control = compute(data['observations.json'], 'control', 'C');
    for (const [name, value] of [['candidateVsBaseline', candidate], ['identicalCodeControl', control]]) {
        const reported = data['analysis.json'][name];
        for (const key of ['count', 'ratios', 'medianPairedChangePercent', 'equalWorkChangePercent', 'worstPairChangePercent', 'fasterPairs']) {
            assert.deepEqual(value[key], reported[key], corpus.dictionary + ': ' + name + ': ' + key);
        }
        assert.deepEqual(value.exactEnumeratedBootstrap95Percent, reported.descriptiveBootstrap95Percent, corpus.dictionary + ': exact bootstrap endpoints');
    }
    assert.deepEqual(data['observations.json'].map(({totalImportMs, ...x}) => x), data['registered-plan.json'].schedule);
    const memory = data['memory/memory-comparison.json'];
    const pairs = {};
    for (const observation of memory.observations) { (pairs[observation.pair] ??= {})[observation.arm] = observation; }
    const memoryMetrics = {};
    for (const metric of ['maxSampledPrivateKiB', 'maxSampledPssKiB']) {
        const changes = Object.values(pairs).map(pair => (pair.B[metric] / pair.A[metric] - 1) * 100);
        memoryMetrics[metric] = {medianPairedChangePercent: med(changes), maximumPairedChangePercent: Math.max(...changes)};
        assert.deepEqual(memoryMetrics[metric], memory.metrics[metric]);
    }
    output.push({dictionary: corpus.dictionary, candidate, control, memoryMetrics, memoryQualified: memory.everyObservationQualified, semanticFailures: data['memory/semantic-failures.json']});
}
console.log(JSON.stringify({kind: evidence.kind, testedCandidate: evidence.testedCandidate, status: evidence.status, output}, null, 2));
