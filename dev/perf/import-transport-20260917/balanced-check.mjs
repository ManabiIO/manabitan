import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const load = p => import(pathToFileURL(path.resolve(p)).href)
const zstd = await load('ext/lib/zstd-wasm.js')
await zstd.init('data:application/wasm;base64,' + fs.readFileSync('dev/data/zstd-simd.wasm').toString('base64'))
const dictionary = fs.readFileSync('dev/data/zstd-dicts/jmdict.zdict')
globalThis.fetch = async input => {
    assert.equal(input, '/lib/zstd-dicts/jmdict.zdict')
    return new Response(dictionary)
}
const codec = await load('ext/js/dictionary/zstd-term-content.js')
await codec.initializeTermContentZstd()
const {wrapCompressedTermContentBlock} = await load('ext/js/dictionary/term-content-block-envelope.js')
const {snapshotTermBankExperiments} = await load('ext/js/dictionary/term-bank-experiments.js')
assert.equal(snapshotTermBankExperiments().experimentalBalancedCompression, false)
for (const value of [false,0,1,null,undefined,'true',{}]) assert.equal(snapshotTermBankExperiments({experimentalBalancedCompression:value}).experimentalBalancedCompression,false)
const referenceContext = zstd.createCCtx()
let frames = 0, rejections = 0, spans = 0
try {
    for (const dictName of [null,'jmdict','other']) for (const enabled of [false,true]) {
        const options = {experimentalBalancedCompression:enabled}
        for (const size of [1,15,16,31,255,1024,8199,65537,1048579]) for (let alignment=0;alignment<8;alignment++) {
            const input = new Uint8Array(new SharedArrayBuffer(size+alignment),alignment)
            for(let i=0;i<input.length;i++) input[i] = i % 11 === 0 ? (i * 71) & 255 : (i % 19)
            const expectedFrame = dictName === 'jmdict' ? zstd.compressUsingDict(referenceContext,input,dictionary,enabled?-3:-1) : zstd.compress(input,1)
            assert.deepEqual(codec.compressTermContentZstd(input,dictName,options),expectedFrame)
            const wrapped = codec.compressWrappedTermContentZstd(input,dictName,options).bytes
            assert.deepEqual(wrapped,wrapCompressedTermContentBlock(expectedFrame))
            assert.deepEqual(codec.decompressTermContentZstd(expectedFrame,dictName),new Uint8Array(input))
            const offsets=Uint32Array.of(0,Math.floor(size/2),0),lengths=Uint32Array.of(Math.floor(size/2),size-Math.floor(size/2),Math.min(7,size))
            const expected=new Uint8Array(size+Math.min(7,size));expected.set(input);expected.set(input.subarray(0,Math.min(7,size)),size)
            if(enabled||dictName==='jmdict') {
                const expectedWrapped=wrapCompressedTermContentBlock(dictName==='jmdict'?zstd.compressUsingDict(referenceContext,expected,dictionary,enabled?-3:-1):zstd.compress(expected,1))
                const prepared=codec.prepareWrappedTermContentZstdSpans(input,offsets,lengths,expected.length,dictName,options)
                input.fill(0)
                const result=codec.finishWrappedTermContentZstdSpans(prepared).bytes
                assert.deepEqual(result,expectedWrapped)
                assert.deepEqual(codec.decompressTermContentZstd(result.subarray(12),dictName),expected)
                spans++
                for(const [badOffsets,badLengths,total] of [[Uint32Array.of(size),Uint32Array.of(1),1],[Uint32Array.of(0),Uint32Array.of(1),0],[Uint32Array.of(0),new Uint32Array(),1]]) {
                    assert.throws(()=>codec.prepareWrappedTermContentZstdSpans(input,badOffsets,badLengths,total,dictName,options),RangeError)
                    rejections++
                }
                const recovered=codec.prepareWrappedTermContentZstdSpans(expected,Uint32Array.of(0),Uint32Array.of(expected.length),expected.length,dictName,options)
                assert.deepEqual(codec.finishWrappedTermContentZstdSpans(recovered).bytes,expectedWrapped)
            } else {
                assert.throws(()=>codec.prepareWrappedTermContentZstdSpans(input,offsets,lengths,expected.length,dictName,options))
            }
            frames++
        }
    }
} finally { zstd.freeCCtx(referenceContext) }
const result={status:'success',frames,spans,rejections,note:'Actual compiled codec compared with direct standard Zstd APIs at independently selected levels: trained -1/-3, generic 1 in both arms; native envelope parity, borrowed-byte ownership, malformed spans and recovery'}
const out=process.env.CHECK_OUT??'builds/balanced-check.json'
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
