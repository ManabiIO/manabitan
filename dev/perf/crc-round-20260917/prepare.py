from pathlib import Path
import sys
root=Path.cwd()
modes=set(sys.argv[1:] or ['slice16','slice32','braid'])
assert modes and modes <= {'slice16','slice32','braid'}
def replace(p,a,b):
    p=root/p
    s=p.read_text()
    assert s.count(a)==1,(p,a[:100],s.count(a))
    p.write_text(s.replace(a,b))
flags={'slice16':'experimentalCrcSlicing16','slice32':'experimentalCrcSlicing32','braid':'experimentalCrcBraided16'}
for key in sorted(modes):
    name=flags[key]
    replace('ext/js/dictionary/term-bank-experiments.js','    return Object.freeze({\n',f'    return Object.freeze({{\n        {name}: options.{name} === true,\n')
    replace('types/ext/dictionary-importer.d.ts','export type ImportExperiments = {\n',f'export type ImportExperiments = {{\n    {name}?: boolean;\n')
width=32 if 'slice32' in modes else 16
s=f'''/* Wider CRC slicing keeps the ZIP polynomial and complete-bank check.
 * The original slicing-by-eight function above remains the flag-off path.
 * Each parser instance owns its tables; no source bytes are retained. */
static uint32_t wide_crc32_table[{width}][256];
static uint32_t wide_crc32_initialized = 0u;

static void init_wide_crc32(void) {{
    if (wide_crc32_initialized != 0u) {{ return; }}
    /* Initialize the original eight slices once, then derive additional ones. */
    (void)crc32_bytes((const uint8_t*)0, 0u);
    for (uint32_t slice = 0u; slice < 8u; ++slice) {{
        for (uint32_t i = 0u; i < 256u; ++i) {{
            wide_crc32_table[slice][i] = crc32_table[slice][i];
        }}
    }}
    for (uint32_t slice = 8u; slice < {width}u; ++slice) {{
        for (uint32_t i = 0u; i < 256u; ++i) {{
            const uint32_t value = wide_crc32_table[slice - 1u][i];
            wide_crc32_table[slice][i] = (value >> 8u) ^ wide_crc32_table[0][value & 0xffu];
        }}
    }}
    wide_crc32_initialized = 1u;
}}

static inline uint32_t crc32_load_le(const uint8_t* p) {{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8u) |
        ((uint32_t)p[2] << 16u) | ((uint32_t)p[3] << 24u);
}}

'''
for n in [16,32]:
    if 'slice'+str(n) not in modes:
        continue
    s+=f'''static uint32_t crc32_slice{n}(const uint8_t* data, uint32_t length) {{
    init_wide_crc32();
    uint32_t crc = 0xffffffffu;
    uint32_t offset = 0u;
    while (length - offset >= {n}u) {{
        const uint32_t first = crc ^ crc32_load_le(data + offset);
        crc =
'''
    terms=[f'wide_crc32_table[{n-1-i}][(first >> {8*i}u) & 0xffu]' for i in range(4)]+[f'wide_crc32_table[{n-1-i}][data[offset + {i}u]]' for i in range(4,n)]
    s+=' ^\n'.join('            '+x for x in terms)+';\n'
    s+=f'''        offset += {n}u;
    }}
    while (offset < length) {{
        crc = (crc >> 8u) ^ wide_crc32_table[0][(crc ^ data[offset++]) & 0xffu];
    }}
    return ~crc;
}}

'''
if 'braid' in modes:
    s+='''/* Four interleaved words remove the single-CRC dependency between blocks.
 * Each lane advances 16 bytes, then the last block combines lane positions. */
static uint32_t crc32_braid16(const uint8_t* data, uint32_t length) {
    init_wide_crc32();
    uint32_t crc = 0xffffffffu;
    uint32_t offset = 0u;
    if (length >= 16u) {
        uint32_t lanes[4] = {crc, 0u, 0u, 0u};
        while (length - offset >= 32u) {
            for (uint32_t lane = 0u; lane < 4u; ++lane) {
                const uint32_t word = lanes[lane] ^ crc32_load_le(data + offset + lane * 4u);
                lanes[lane] = wide_crc32_table[15][word & 0xffu] ^
                    wide_crc32_table[14][(word >> 8u) & 0xffu] ^
                    wide_crc32_table[13][(word >> 16u) & 0xffu] ^
                    wide_crc32_table[12][word >> 24u];
            }
            offset += 16u;
        }
        crc = 0u;
        for (uint32_t lane = 0u; lane < 4u; ++lane) {
            const uint32_t word = lanes[lane] ^ crc32_load_le(data + offset + lane * 4u);
            const uint32_t slice = 15u - lane * 4u;
            crc ^= wide_crc32_table[slice][word & 0xffu] ^
                wide_crc32_table[slice - 1u][(word >> 8u) & 0xffu] ^
                wide_crc32_table[slice - 2u][(word >> 16u) & 0xffu] ^
                wide_crc32_table[slice - 3u][word >> 24u];
        }
        offset += 16u;
    }
    while (offset < length) {
        crc = (crc >> 8u) ^ wide_crc32_table[0][(crc ^ data[offset++]) & 0xffu];
    }
    return ~crc;
}

'''
code='ext/js/dictionary/wasm/term-bank-parser.c'
replace(code,'static int is_json_whitespace(uint8_t value) {',s+'static int is_json_whitespace(uint8_t value) {')
replace(code,'    uint32_t use_libdeflate\n','    uint32_t use_libdeflate,\n    uint32_t crc_mode\n')
expr='crc32_bytes(inflated, uncompressed_length)'
for mode,value,func in [('slice16',16,'crc32_slice16'),('slice32',32,'crc32_slice32'),('braid',64,'crc32_braid16')]:
    if mode in modes:
        expr=f'crc_mode == {value}u ? {func}(inflated, uncompressed_length) :\n            '+expr
replace(code,'        if (crc32_bytes(inflated, uncompressed_length) != signatures[i]) {',f'        const uint32_t actual_crc = {expr};\n        if (actual_crc != signatures[i]) {{')
expr='0'
for mode,value in [('slice16',16),('slice32',32),('braid',64)]:
    if mode in modes:
        expr=f'experiments.{flags[mode]} === true ? {value} : {expr}'
replace('ext/js/dictionary/term-bank-wasm-parser.js','        experiments.experimentalLibdeflate ? 1 : 0,\n',f'        experiments.experimentalLibdeflate ? 1 : 0,\n        {expr},\n')
print('CRC modes:',sorted(modes))
