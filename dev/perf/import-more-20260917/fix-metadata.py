from pathlib import Path
p=Path('ext/js/dictionary/wasm/term-bank-parser.c')
s=p.read_text();a=s.index('static int grow_term_row_buffer(');b=s.index('\nstatic int grow_content_buffer(',a)
t=s[a:b]
old='UINT32_MAX / (uint32_t)sizeof(TermRowMeta)'
assert t.count(old)==1
t=t.replace(old,'(UINT32_MAX - 7u) / (uint32_t)sizeof(TermRowMeta)')
old='    const uint32_t old_bytes = old_capacity * (uint32_t)sizeof(TermRowMeta);\n    const uint32_t extra_bytes = (new_capacity - old_capacity) * (uint32_t)sizeof(TermRowMeta);'
assert t.count(old)==1
t=t.replace(old,'''    /* wasm_alloc rounds the whole metadata slab to eight bytes. An odd row
     * capacity has four padding bytes; extend from the aligned allocation end,
     * not the logical end of its 68-byte records. */
    const uint32_t old_bytes = align8(old_capacity * (uint32_t)sizeof(TermRowMeta));
    const uint32_t new_bytes = align8(new_capacity * (uint32_t)sizeof(TermRowMeta));''')
assert t.count('wasm_alloc(extra_bytes)')==1
t=t.replace('wasm_alloc(extra_bytes)','wasm_alloc(new_bytes - old_bytes)')
p.write_text(s[:a]+t+s[b:])
print('Metadata growth now uses the aligned allocation end; ownership and memory limits unchanged')
