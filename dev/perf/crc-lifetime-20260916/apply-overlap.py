from pathlib import Path
import hashlib,json,sys
variant=sys.argv[1]
p=Path('ext/js/dictionary/wasm/vendor/miniz/miniz_tinfl.c')
s=original=p.read_text()
assert hashlib.sha256(p.read_bytes()).hexdigest()=='05930a45b5d9fdd5786c4e631373cdfec32b7be50ec0906d3b98caa503e068f3'
needle='#if defined(__wasm_bulk_memory__)\n                    else if ((counter >= 9) && (counter <= dist))'
assert s.count(needle)==1
fill='''#if defined(__wasm_bulk_memory__)
                    else if ((counter >= 9) && (dist == 1) &&
                             (decomp_flags & TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF))
                    {
                        /* The full output range was checked above. A distance-one
                           forward match repeats exactly the last decoded byte. */
                        __builtin_memset(pOut_buf_cur, pSrc[0], counter);
                        pOut_buf_cur += counter;
                        counter = 0;
                        continue;
                    }
'''
expand='''                    else if ((counter >= 16) && (counter > dist) &&
                             (decomp_flags & TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF))
                    {
                        /* Copy only initialized, non-overlapping history. Each
                           subsequent copy doubles the established prefix instead
                           of applying snapshot semantics to a forward LZ match. */
                        mz_uint copied = dist;
                        __builtin_memcpy(pOut_buf_cur, pSrc, copied);
                        while (copied < counter)
                        {
                            const mz_uint amount = MZ_MIN(copied, counter - copied);
                            __builtin_memcpy(pOut_buf_cur + copied, pOut_buf_cur, amount);
                            copied += amount;
                        }
                        pOut_buf_cur += counter;
                        counter = 0;
                        continue;
                    }
'''
assert variant in ('match-fill','match-expand')
s=s.replace(needle,fill+(expand if variant=='match-expand' else '')+'                    else if ((counter >= 9) && (counter <= dist))')
p.write_text(s)
print(json.dumps({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
