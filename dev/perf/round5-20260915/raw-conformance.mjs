import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {constants, crc32, deflateRawSync, inflateRawSync} from 'node:zlib'
const module = await WebAssembly.compile(await readFile(process.argv[2]))
assert.deepEqual(WebAssembly.Module.imports(module), [])
const wasm = (await WebAssembly.instantiate(module)).exports
const heap = new Uint8Array(wasm.memory.buffer)
assert.ok(heap.byteLength <= 1048576)
const input = wasm.media_input_pointer(), output = wasm.media_output_pointer(), capacity = 262144
let cases = 0
function decode(compressed, decoded, method, crc) {
    assert.ok(compressed.length <= capacity)
    heap.set(compressed, input)
    heap.fill(0xa5, output, output + capacity)
    const status = wasm.inflate_media(compressed.length, decoded, method, crc)
    if (decoded + 16 <= capacity) { assert.deepEqual([...heap.subarray(output + decoded, output + decoded + 16)], new Array(16).fill(0xa5)) }
    ++cases
    return {status, bytes: heap.slice(output, output + Math.max(0, status))}
}
const widths = [0,1,2,7,8,15,16,31,32,255,256,4095,4096,32767,65535,131071,262143,262144]
for (const width of widths) {
    const bytes = Uint8Array.from({length:width}, (_,i) => (i * 17 + (i >>> 5)) & 255)
    const signature = crc32(bytes)
    for (const options of [{level:1},{level:6},{level:9},{strategy:constants.Z_FIXED},{strategy:constants.Z_HUFFMAN_ONLY}]) {
        const compressed = new Uint8Array(deflateRawSync(bytes, options))
        if (compressed.length > capacity) { continue }
        assert.deepEqual(inflateRawSync(compressed), Buffer.from(bytes))
        const result = decode(compressed, width, 8, signature)
        assert.equal(result.status, width); assert.deepEqual(result.bytes, bytes)
        assert.equal(decode(compressed, width, 8, (signature ^ 1) >>> 0).status, -4)
        if (compressed.length + 1 <= capacity) {
            const trailing = new Uint8Array(compressed.length + 1); trailing.set(compressed)
            assert.equal(decode(trailing, width, 8, signature).status, -6)
        }
        for (let end=0; end<Math.min(compressed.length,32); ++end) {
            assert.ok(decode(compressed.subarray(0,end), width, 8, signature).status < 0)
        }
        if (width>0) { assert.ok(decode(compressed, width-1, 8, signature).status < 0) }
        if (width<capacity) { assert.equal(decode(compressed, width+1, 8, signature).status, -3) }
        assert.equal(decode(compressed, width, 8, signature).status, width)
    }
    const stored = decode(bytes, width, 0, signature)
    assert.equal(stored.status, width); assert.deepEqual(stored.bytes, bytes)
}
assert.equal(wasm.inflate_media(capacity+1,0,8,0),-1)
assert.equal(wasm.inflate_media(0,capacity+1,8,0),-1)
assert.equal(wasm.inflate_media(0,0,99,0),-1)
let seed=0x91a77f03
for(let trial=0;trial<1000;++trial){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0
    const width=seed%8193
    const bytes=Uint8Array.from({length:width},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24})
    const compressed = new Uint8Array(deflateRawSync(bytes,{level:trial%10}))
    const result=decode(compressed,width,8,crc32(bytes))
    assert.equal(result.status,width); assert.deepEqual(result.bytes,bytes)
    const bad=Uint8Array.from(compressed);bad[Math.floor(bad.length/2)]^=1
    const malformed=decode(bad,width,8,crc32(bytes))
    if(malformed.status>=0){assert.deepEqual(malformed.bytes,bytes);assert.deepEqual(inflateRawSync(bad),Buffer.from(bytes))}
}
console.log(JSON.stringify({status:'passed',cases,heapBytes:heap.byteLength,wasmBytes:(await readFile(process.argv[2])).byteLength}))
