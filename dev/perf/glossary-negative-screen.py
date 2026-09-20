#!/usr/bin/env python3
"""Synthetic component controls, not full-import timing or production heuristics."""
import argparse, subprocess
from pathlib import Path
JS=r'''
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [root,wasmPath,out]=process.argv.slice(2);
const parser=await import(pathToFileURL(root+'/ext/js/dictionary/term-bank-wasm-parser.js'));
const wasm=await readFile(wasmPath);parser.setTermBankWasmModule(await WebAssembly.compile(wasm));
const enc=new TextEncoder(),count=24000;
const cases={
 'short-unique':i=>[String(i).padStart(6,'0')],
 'long-unique':i=>[`${String(i).padStart(6,'0')}${'x'.repeat(1000)}${String(i).padStart(6,'0')}`],
 'long-common-prefix':i=>['x'.repeat(960)+String(i).padStart(6,'0')+'x'.repeat(60)],
 'structured-unique':i=>[{type:'structured-content',content:{tag:'ul',content:Array.from({length:8},(_,k)=>({tag:'li',content:`${k===6?String(i).padStart(6,'0'):'nested'} ${'Japanese 日本語'.repeat(8)}`}))}}],
 'structured-repeated':i=>[{type:'structured-content',content:{tag:'ul',content:Array.from({length:8},(_,k)=>({tag:'li',content:`${k} ${String(Math.floor(i/8)).padStart(6,'0')} ${'Japanese 日本語'.repeat(8)}`}))}}],
};
const result={boundary:'Resident synthetic banks through native parse/content/lookup completion; allocation, fixture construction, digest, warmups and GC excluded. Not browser import.',node:process.version,wasmSha256:createHash('sha256').update(wasm).digest('hex'),cases:{}};
const median=v=>{const a=[...v].sort((a,b)=>a-b);return(a[(a.length-1)>>1]+a[a.length>>1])/2;};
for(const[name,glossary]of Object.entries(cases)){
 const banks=[];for(let b=0;b<4;b++){const rows=[];for(let j=0;j<count/4;j++){const i=b*count/4+j;rows.push([`word${i}`,'','','',0,glossary(i),i,'']);}banks.push(enc.encode(JSON.stringify(rows)));}
 const run=async(enabled,verify)=>{
  global.gc?.();let chunk;const start=performance.now();
  await parser.parseTermBankWithWasmColumnChunks(banks,3,c=>{chunk=c;},count,{experimentalValidatedGlossaryReuse:enabled,singleChunk:true,emitTermByteLists:false,computeContentHashes:true,emitContentSlab:true,emitTokenBinaryContent:true,mediaHintFastScan:true,prepareLookupIndexes:true});
  const elapsedMs=performance.now()-start,profile=parser.consumeLastTermBankWasmParseProfile();let digest=null;
  if(verify){const h=createHash('sha256');for(const[key,e]of chunk.preparedLookupIndexes){h.update(key);h.update(e.bytes);}for(const v of[chunk.scoreList,chunk.sequenceList,chunk.readingEqualsExpressionList])h.update(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));for(let i=0;i<chunk.rowCount;i++){const off=chunk.contentBytesBaseOffset+chunk.contentMetaList[i*4];h.update(chunk.contentBytesBuffer.subarray(off,off+chunk.contentMetaList[i*4+1]));}digest=h.digest('hex');}
  return{enabled,elapsedMs,digest,rows:chunk.rowCount,reuse:profile.validatedGlossaryReuseCount??0,fallbacks:profile.fusedParseFallbacks??0,heap:profile.maxWasmHeapBytes};
 };
 for(const enabled of[false,true,true,false])await run(enabled,false);
 const obs=[];for(let block=0;block<3;block++)for(const role of(block%2===0?['effect','control']:['control','effect']))for(const arm of['A','B','B','A'])obs.push({block,role,arm,...await run(role==='effect'&&arm==='B',true)});
 if(new Set(obs.map(o=>o.digest)).size!==1||obs.some(o=>o.rows!==count||o.fallbacks))throw Error('Parity/path failed '+name);
 const summaries={};for(const role of['effect','control']){const rows=obs.filter(o=>o.role===role),pairs=[];for(let i=0;i<rows.length;i+=4){const[a,b,c,d]=rows.slice(i,i+4).map(o=>o.elapsedMs);pairs.push(100*(b/a-1),100*(c/d-1));}summaries[role]={pairs,median:median(pairs),medianAbsolute:median(pairs.map(Math.abs))};}
 result.cases[name]={bytes:banks.reduce((s,b)=>s+b.length,0),observations:obs,summaries};
 console.log(name,summaries);await writeFile(out,JSON.stringify(result,null,2));
}
'''
def main():
 p=argparse.ArgumentParser();p.add_argument('--wasm',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 root=Path(__file__).resolve().parents[2];out=Path(a.out).resolve();out.parent.mkdir(parents=True,exist_ok=True)
 script=out.with_suffix('.mjs');script.write_text(JS)
 subprocess.run(['node','--expose-gc',str(script),str(root),str(Path(a.wasm).resolve()),str(out)],check=True,timeout=180)
if __name__=='__main__':main()
