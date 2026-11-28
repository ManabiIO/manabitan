// SPDX-License-Identifier: GPL-3.0-or-later
// I/O adapter around the exact independently executed functions-V8 review body.
// Run from a checkout containing both frozen commits; this script fetches nothing.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const baselineSha = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const candidateSha = '8b4f502cdc26541c542b7473fae4e51c0713ef98';
const repositoryPath = 'ext/js/dictionary/dictionary-database.js';
const evidence = new Map();
const readSource = (sha) => execFileSync('git', ['show', sha + ':' + repositoryPath], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
evidence.set('review-parts:ext/js/dictionary/dictionary-database.js', {structuredContent: {content: readSource(baselineSha)}});
evidence.set('review-registration-fixed-db', {structuredContent: {content: readSource(candidateSha)}});
const load = (key) => evidence.get(key);
const store = (key, value) => evidence.set(key, value);
const text = (value) => console.log(JSON.stringify(value));

// BEGIN exact review body executed in functions V8.
function extractMethod(source,name){const start=source.indexOf("    "+name+"("); if(start<0)throw Error("missing "+name);const end=source.indexOf("\n    }\n",start);return source.slice(start,end+6);}
const baselineSource=load("review-parts:ext/js/dictionary/dictionary-database.js").structuredContent.content;
const fixedSource=load("review-registration-fixed-db").structuredContent.content;
const helperStart=fixedSource.indexOf("function hasPlainTypedArrayProperties(");
const helper=fixedSource.slice(helperStart,fixedSource.indexOf("\n}\n",helperStart)+3);
const make=(source,fixed)=>new Function(
 (fixed?"const artifactTermContentSpanOrigins=new WeakSet();\n"+helper:"")+
 "\nreturn class ReviewedRegistration {constructor(){this._inFlightTermContentSourceBatches=new Set();}"+
 ["_getTermContentStorageKey","_findInFlightTermContentSource","_registerInFlightTermContentSources"].map(n=>extractMethod(source,n)).join("\n")+
 (fixed?extractMethod(source,"_createArtifactTermContentSpans"):"_createArtifactTermContentSpans(buffer,offsets,lengths){return {buffer,offsets,lengths};}")+"};")();
const Base=make(baselineSource,false),Fixed=make(fixedSource,true);
store("registration-review-extracted-methods",{helper,baselineMethods:["_getTermContentStorageKey","_findInFlightTermContentSource","_registerInFlightTermContentSources"].map(n=>extractMethod(baselineSource,n)),fixedMethods:["_getTermContentStorageKey","_findInFlightTermContentSource","_registerInFlightTermContentSources","_createArtifactTermContentSpans"].map(n=>extractMethod(fixedSource,n))});
const offsetCases=[[0,1,2],[100,200,300],[300,100,200],[0,0,1],[100,100,100],[-0,1,2],[-1,1,2],[.5,1,2],[NaN,1,2],[Infinity,1,2],[Number.MAX_SAFE_INTEGER-2,Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER],[100,200,Number.MAX_SAFE_INTEGER+1]];
const spanCases=[[0,2,4],[0,2,6],[0,2,7],[0,2,0xffffffff],[4,2,0],[0,0,0]];
const lengthCases=[[2,2,2],[0,0,0],[2,2,0],[2,0,2]];
const kinds=["typed","array","proxy","accessor","short-offsets","short-lengths"];
function run(Class,offsetsInput,sourceOffsetsInput,lengthsInput,kind,prior){
 const db=new Class(),buffer=Uint8Array.of(10,11,12,13,14,15),lens=Uint32Array.from(lengthsInput);
 let offsets=kind==="array"?[...offsetsInput]:Float64Array.from(offsetsInput);
 let spans=db._createArtifactTermContentSpans(buffer,Uint32Array.from(sourceOffsetsInput),lens);
 if(kind==="short-offsets")spans.offsets=spans.offsets.subarray(0,2);
 if(kind==="short-lengths")spans.lengths=spans.lengths.subarray(0,2);
 let reads=0,descriptorReads=0;
 if(kind==="proxy")spans=new Proxy(spans,{getOwnPropertyDescriptor(t,k){descriptorReads++;return Reflect.getOwnPropertyDescriptor(t,k)},get(t,k,r){if(k==="offsets"){reads++;return reads<3?t.offsets:Uint32Array.of(0,2,99)}return Reflect.get(t,k,r)}});
 if(kind==="accessor"){const original=spans.offsets;Object.defineProperty(spans,"offsets",{get(){reads++;return reads<3?original:Uint32Array.of(0,2,99)}})}
 let priorRelease; if(prior){const p=db._createArtifactTermContentSpans(new Uint8Array(6),Uint32Array.of(0,2,4),Uint32Array.of(2,2,2));priorRelease=db._registerInFlightTermContentSources(Float64Array.of(99,200,301),p.lengths,"raw",[],p);}
 let result;try{const release=db._registerInFlightTermContentSources(offsets,lens,"raw",[],spans);const batch=[...db._inFlightTermContentSourceBatches].at(-1);result={success:true,minimum:batch.minimumOffset,maximum:batch.maximumOffset,negativeZeroMinimum:Object.is(batch.minimumOffset,-0),sorted:batch.sortedOffsets,batchCount:db._inFlightTermContentSourceBatches.size};release();result.remaining=db._inFlightTermContentSourceBatches.size;}
 catch(e){result={name:e.name,message:e.message,batchCount:db._inFlightTermContentSourceBatches.size};}
 priorRelease?.();return {...result,reads,descriptorReads};
}
let count=0;const mismatches=[];
for(const offsets of offsetCases)for(const spans of spanCases)for(const lengths of lengthCases)for(const kind of kinds)for(const prior of [false,true]){
 const a=run(Base,offsets,spans,lengths,kind,prior),b=run(Fixed,offsets,spans,lengths,kind,prior);count++;if(JSON.stringify(a)!==JSON.stringify(b))mismatches.push({offsets,spans,lengths,kind,prior,a,b});
}
text({cases:count,mismatchCount:mismatches.length,mismatches:mismatches.slice(0,8)});
store("registration-independent-review-oracle",{cases:count,mismatchCount:mismatches.length,mismatches:mismatches.slice(0,20),sourceSha:"8b4f502cdc26541c542b7473fae4e51c0713ef98",scope:"Exact extracted register/find/key/factory methods and minimal Set-only constructor in functions V8; cross product numeric boundaries, ordered/overlap/duplicate reservations, source bounds, empty spans, typed/array/proxy/accessor/short inputs, prior live batch. Not full module/CI."});
// END exact review body.
const summary = evidence.get('registration-independent-review-oracle');
const outputPath = process.argv[2];
if (outputPath) {
    writeFileSync(outputPath, JSON.stringify({environment: process.version, baselineSha, candidateSha, ...summary}, null, 2) + '\n');
}
if (summary.cases !== 3456 || summary.mismatchCount !== 0) { process.exitCode = 1; }
