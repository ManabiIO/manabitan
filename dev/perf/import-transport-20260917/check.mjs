import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const load = p => import(pathToFileURL(path.resolve(p)).href)
const zstd = await load('ext/lib/zstd-wasm.js')
await zstd.init('data:application/wasm;base64,' + fs.readFileSync('dev/data/zstd-simd.wasm').toString('base64'))
const originalFetch = globalThis.fetch
const dictionary = fs.readFileSync('dev/data/zstd-dicts/jmdict.zdict')
globalThis.fetch = async input => {
    if (input === '/lib/zstd-dicts/jmdict.zdict') return new Response(dictionary)
    return originalFetch(input)
}
const codec = await load('ext/js/dictionary/zstd-term-content.js')
await codec.initializeTermContentZstd()
globalThis.fetch = originalFetch
const {wrapCompressedTermContentBlock} = await load('ext/js/dictionary/term-content-block-envelope.js')
const {snapshotTermBankExperiments} = await load('ext/js/dictionary/term-bank-experiments.js')
const flags = ['experimentalZstdFast2', 'experimentalCompressionWorkers2', 'experimentalGenericSpanCompression']
for (const key of flags) {
    assert.equal(snapshotTermBankExperiments()[key], false)
    for (const value of [false,0,1,null,undefined,'true',{}]) assert.equal(snapshotTermBankExperiments({[key]:value})[key],false)
    assert.equal(snapshotTermBankExperiments({[key]:true})[key],true)
}
let frames = 0
let rejections = 0
for (const dictName of [null,'jmdict','other']) for (const fast of [false,true]) {
    for (const size of [1,15,16,31,255,1024,8199,65537,1048579]) for (let alignment=0;alignment<8;alignment++) {
        const input = new Uint8Array(new SharedArrayBuffer(size+alignment),alignment)
        for(let i=0;i<input.length;i++) input[i] = i % 11 === 0 ? (i * 71) & 255 : (i % 19)
        const opts = {experimentalZstdFast2:fast}
        const frame = codec.compressTermContentZstd(input,dictName,opts)
        assert.deepEqual(codec.decompressTermContentZstd(frame,dictName), new Uint8Array(input))
        const wrapped = codec.compressWrappedTermContentZstd(input,dictName,opts).bytes
        assert.deepEqual(wrapped, wrapCompressedTermContentBlock(frame))
        const generic = {...opts,experimentalGenericSpanCompression:true}
        assert.deepEqual(codec.compressWrappedTermContentZstd(input,dictName,generic).bytes, wrapped)
        const offsets = Uint32Array.of(0, Math.floor(size/2), 0)
        const lengths = Uint32Array.of(Math.floor(size/2),size-Math.floor(size/2),Math.min(7,size))
        const expected = new Uint8Array(size+Math.min(7,size))
        expected.set(input)
        expected.set(input.subarray(0,Math.min(7,size)),size)
        const expectedWrapped = codec.compressWrappedTermContentZstd(expected,dictName,opts).bytes
        const prepared = codec.prepareWrappedTermContentZstdSpans(input,offsets,lengths,expected.length,dictName,generic)
        input.fill(0)
        const result = codec.finishWrappedTermContentZstdSpans(prepared).bytes
        assert.deepEqual(result,expectedWrapped)
        assert.deepEqual(codec.decompressTermContentZstd(result.subarray(12),dictName),expected)
        for(const [badOffsets,badLengths,total] of [[Uint32Array.of(size),Uint32Array.of(1),1],[Uint32Array.of(0),Uint32Array.of(1),0],[Uint32Array.of(0),new Uint32Array(),1]]) {
            assert.throws(()=>codec.prepareWrappedTermContentZstdSpans(input,badOffsets,badLengths,total,dictName,generic),RangeError)
            rejections++
        }
        const valid = codec.prepareWrappedTermContentZstdSpans(expected,Uint32Array.of(0),Uint32Array.of(expected.length),expected.length,dictName,generic)
        assert.deepEqual(codec.finishWrappedTermContentZstdSpans(valid).bytes,expectedWrapped)
        frames++
    }
}
// Only transport is mocked here; every reply contains actual compiled Zstd output.
class MockWorker {
    listeners = new Map()
    calls = []
    terminateCount = 0
    addEventListener(type,cb){this.listeners.set(type,[...(this.listeners.get(type)??[]),cb])}
    postMessage(message,transfer){
        this.calls.push({message,transfer})
        const result=message.source ? codec.compressWrappedTermContentZstdSpans(message.source,message.sourceOffsets,message.sourceLengths,message.contentBytes,message.dictName,message.compressionExperiments).bytes : codec.compressWrappedTermContentZstd(message.content,message.dictName,message.compressionExperiments).bytes
        queueMicrotask(()=>{for(const cb of this.listeners.get('message')??[])cb({data:{id:message.id,compressed:result.buffer}})})
    }
    terminate(){this.terminateCount++}
}
const workers=Array.from({length:4},()=>new MockWorker())
const pool=new codec.TermContentCompressionPool(workers)
for(const count2 of [false,true,true,false]) {
    for(const w of workers) w.calls=[]
    const opts={experimentalCompressionWorkers2:count2,experimentalZstdFast2:true,experimentalGenericSpanCompression:true}
    const inputs=Array.from({length:9},(_,i)=>new Uint8Array(2049).fill(i+3))
    const expected=inputs.map(x=>codec.compressWrappedTermContentZstd(x,null,opts).bytes)
    assert.deepEqual((await pool.compressWrapped(inputs,null,opts)).chunks,expected)
    assert.deepEqual(workers.map(w=>w.calls.length),count2?[5,4,0,0]:[3,2,2,2])
}
pool.close()
const result={status:'success',frames,rejections,schedulingJobs:36,note:'Actual compiled Zstd frames, portable envelope equality, all alignments, shared source overwritten before finishing, and per-call worker selection; mock transport only for scheduling'}
const out=process.env.CHECK_OUT??'builds/compression-check.json'
fs.mkdirSync(path.dirname(out),{recursive:true})
fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result))
