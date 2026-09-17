from pathlib import Path
import hashlib,json,subprocess,sys
modes=sys.argv[1:] or ['slice32']
names={'slice16':('experimentalCrcSlicing16',16,'crc32_slice16'),'slice32':('experimentalCrcSlicing32',32,'crc32_slice32'),'braid':('experimentalCrcBraided16',64,'crc32_braid16')}
assert modes and len(set(modes))==len(modes) and all(x in names for x in modes)
assets=Path(__file__).parent
s=(assets/'test-crc.js').read_text()
a=s.index('const candidates = ')
b=s.index('\nconst encoder',a)
# A fixed selected list must fail on a parent without the flag rather than
# silently dropping cases by inspecting the implementation under test.
s=s[:a]+'const candidates = '+json.dumps([[names[m][0],names[m][1]] for m in modes])+s[b:]
Path('test/term-bank-crc.test.js').write_text(s)
source=Path('ext/js/dictionary/wasm/term-bank-parser.c').read_text()
code=source[source.index('static uint32_t crc32_table'):source.index('static int is_json_whitespace')]
functions=['crc32_bytes']+[names[m][2] for m in modes]
main=r'''
static uint32_t reference_crc(const uint8_t* data, uint32_t length) {
    uint32_t crc = 0xffffffffu;
    for (uint32_t i=0; i<length; ++i) {
        crc ^= data[i];
        for (uint32_t bit=0; bit<8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0u);
    }
    return ~crc;
}
int main(void) {
    uint32_t seed=0x917c3216u;
    uint32_t lengths[]={0,1,2,3,7,8,15,16,17,31,32,33,63,64,65,127,128,129,255,256,257,1023,1024,1025,4095,4096,4097,65535,65536,65537};
    uint32_t count=0;
    for (uint32_t trial=0; trial<1024; ++trial) {
        seed = seed * 1664525u + 1013904223u;
        const uint32_t length=trial<30?lengths[trial]:seed%8193u;
        for (uint32_t alignment=0; alignment<16; ++alignment) {
            uint8_t* allocation=malloc(length+alignment+1);
            assert(allocation);
            uint8_t* bytes=allocation+alignment+1;
            for (uint32_t i=0;i<length;++i) {seed=seed*1664525u+1013904223u; bytes[i]=(uint8_t)(seed>>24);}
            const uint32_t expected=reference_crc(bytes,length);
            CHECKS
            free(allocation);
        }
    }
    printf("%u production-helper checks passed at ASan allocation ends\n",count);
    return 0;
}
'''.replace('CHECKS','\n            '.join(f'assert({f}(bytes,length)==expected); ++count;' for f in functions))
out=Path('builds/crc-qualification');out.mkdir(parents=True,exist_ok=True)
c=out/'crc-sanitizer.c'
c.write_text('#include <assert.h>\n#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n'+code+main)
(out/'helper-provenance.json').write_text(json.dumps({'productionCrcHelpersSha256':hashlib.sha256(code.encode()).hexdigest(),'productionParserSha256':hashlib.sha256(source.encode()).hexdigest(),'modes':modes},indent=2)+'\n')
subprocess.run(['clang','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',str(c),'-o',str(out/'crc-sanitizer')],check=True)
print('Fixed tests and exact-source sanitizer generated')
