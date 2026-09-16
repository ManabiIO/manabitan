from pathlib import Path
import hashlib,json,sys
variant=sys.argv[1]
p=Path('dev/lib/zstd-wasm.js' if variant=='gather-aligned' else 'ext/js/dictionary/dictionary-database.js')
s=original=p.read_text()
tests=[]
if variant=='gather-aligned':
 old='''        module.HEAPU8.set(
            source.subarray(runOffset, runOffset + runLength),
            buffers.source + outputOffset,
        );'''
 new='''        const heap = module.HEAPU8;
        const destinationOffset = buffers.source + outputOffset;
        const prefix = (
            runLength >= 1024 &&
            typeof SharedArrayBuffer !== 'undefined' &&
            source.buffer instanceof SharedArrayBuffer &&
            !(heap.buffer instanceof SharedArrayBuffer)
        ) ? (heap.byteOffset + destinationOffset - source.byteOffset - runOffset) & 7 : 0;
        if (prefix === 0) {
            heap.set(source.subarray(runOffset, runOffset + runLength), destinationOffset);
        } else {
            // Keep the immutable source in bounds, align the shared bulk copy,
            // then shift only private bytes. No padding or extra buffer is needed.
            heap.set(source.subarray(runOffset + prefix, runOffset + runLength), destinationOffset);
            heap.copyWithin(destinationOffset + prefix, destinationOffset, destinationOffset + runLength - prefix);
            heap.set(source.subarray(runOffset, runOffset + prefix), destinationOffset);
        }'''
 assert s.count(old)==1
 s=s.replace(old,new)
elif variant=='typed-pending':
 start=s.index('            const contentRowEnd = contentRowStart + count;')
 end=s.index('        let tableSize = 1;',start)
 old=chunk=s[start:end]
 needle='            const lastUniqueIndex = lowerBoundUint32(uniqueRowIndexes, contentRowEnd);'
 assert chunk.count(needle)==1
 chunk=chunk.replace(needle,needle+'''
            // Hashes are already unsigned 32-bit values. Keep bounded, owning
            // columns instead of growing two boxed-number arrays for every row.
            const canonicalHash1s = new Uint32Array(lastUniqueIndex - firstUniqueIndex);
            const canonicalHash2s = new Uint32Array(lastUniqueIndex - firstUniqueIndex);''')
 for n in (1,2):
  a=f'pendingContentHash{n}s.push(hash{n});'
  assert chunk.count(a)==1
  chunk=chunk.replace(a,f'canonicalHash{n}s[pendingContentCount] = hash{n};')
  a=f'                pendingContentHash{n}s,'
  assert chunk.count(a)==1
  chunk=chunk.replace(a,f'                pendingContentHash{n}s: canonicalHash{n}s.subarray(0, pendingContentCount),')
 s=s[:start]+chunk+s[end:]
 for n in (1,2):
  s=s.replace(f'@param {{number[]}} pendingContentHash{n}s',f'@param {{number[]|Uint32Array}} pendingContentHash{n}s')
  s=s.replace(f'pendingContentHash{n}s: number[]',f'pendingContentHash{n}s: number[]|Uint32Array')
 test=Path('test/dictionary-database-content-dedup.test.js')
 t=test.read_text()
 for n in (1,2):
  a=f'expect(result.pendingContentHash{n}s).toEqual'
  assert t.count(a)==1
  t=t.replace(a,f'expect([...result.pendingContentHash{n}s]).toEqual')
 test.write_text(t)
 tests=[str(test)]
else:
 raise ValueError(variant)
assert s!=original
p.write_text(s)
print(json.dumps({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'tests':tests}))
