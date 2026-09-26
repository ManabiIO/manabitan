/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import createZstdModule from '../lib/zstd-simd-module.js'

const wasmBinary=await fs.readFile(new URL('../data/zstd-simd.wasm',import.meta.url))
const m=await createZstdModule({wasmBinary})
const plain=new TextEncoder().encode('zstd exact frame '.repeat(4096))
const bound=m._ZSTD_compressBound(plain.length)
const src=m._malloc(plain.length)
const dst=m._malloc(bound)
assert.ok(src&&dst)
m.HEAPU8.set(plain,src)
const compressedSize=m._ZSTD_compress(dst,bound,src,plain.length,3)
assert.equal(m._ZSTD_isError(compressedSize),0)
const compressed=m.HEAPU8.slice(dst,dst+compressedSize)
const decode=(bytes)=>{
  const s=m._malloc(bytes.length)
  const d=m._malloc(plain.length)
  try{
    m.HEAPU8.set(bytes,s)
    const frameSize=m._ZSTD_getFrameContentSize(s,bytes.length)
    const size=m._ZSTD_decompress(d,plain.length,s,bytes.length)
    return {frameSize:String(frameSize),size,error:m._ZSTD_isError(size),bytes:size>0&&m._ZSTD_isError(size)===0?m.HEAPU8.slice(d,d+size):null}
  }finally{m._free(d);m._free(s)}
}
const results={complete:decode(compressed),truncated:[],trailing:[],concatenated:null}
for(let cut=1;cut<=8;cut++) results.truncated.push({cut,...decode(compressed.subarray(0,compressed.length-cut))})
for(const extra of [1,4,16]) {
 const b=new Uint8Array(compressed.length+extra);b.set(compressed);b.fill(0x7f,compressed.length)
 results.trailing.push({extra,...decode(b)})
}
const cat=new Uint8Array(compressed.length*2);cat.set(compressed);cat.set(compressed,compressed.length)
results.concatenated=decode(cat)
assert.equal(results.complete.error,0)
assert.deepEqual(results.complete.bytes,plain)
console.log(JSON.stringify({compressedBytes:compressed.length,plainBytes:plain.length,results},null,2))
