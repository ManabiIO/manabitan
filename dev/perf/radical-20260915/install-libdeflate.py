#!/usr/bin/env python3
"""Install an isolated, checksum-pinned DEFLATE candidate into an exact baseline."""
from pathlib import Path
import hashlib
import io
import os
import tarfile
import urllib.request

root = Path.cwd()
variant = os.environ.get('CANDIDATE', 'libdeflate')
assert variant in ('libdeflate', 'libdeflate64')
source = root / 'ext/js/dictionary/wasm/term-bank-parser.c'
assert hashlib.sha256(source.read_bytes()).hexdigest() == '6289568b029db08c7df0498c0c80c97d8d944174d30c4ce53ff43480b0fa6615'
url = 'https://github.com/ebiggers/libdeflate/releases/download/v1.26/libdeflate-1.26.tar.gz'
with urllib.request.urlopen(url, timeout=60) as response:
    archive = response.read()
assert hashlib.sha256(archive).hexdigest() == '125856d4656e0feab660f94842f835923410c9281fedbcee64598c918da42b5a'
vendor = root / 'ext/js/dictionary/wasm/vendor/libdeflate'
files = ['COPYING', 'libdeflate.h', 'common_defs.h', 'lib/lib_common.h', 'lib/deflate_constants.h',
         'lib/deflate_decompress.c', 'lib/decompress_template.h']
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    for name in files:
        item = tar.extractfile('libdeflate-1.26/' + name)
        assert item is not None
        destination = vendor / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(item.read())
if variant == 'libdeflate64':
    path = vendor / 'common_defs.h'
    text = path.read_text()
    assert text.count('typedef size_t machine_word_t;') == 1
    path.write_text(text.replace('typedef size_t machine_word_t;', '''#if defined(__wasm32__)
typedef u64 machine_word_t;
#else
typedef size_t machine_word_t;
#endif'''))

(root / 'ext/js/dictionary/wasm/term-bank-inflate.c').write_text('''/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* Compile only libdeflate's portable full-buffer DEFLATE implementation.
 * No allocator, host imports, CPU dispatcher or streaming state is needed.
 * Each parser worker owns a separate module instance. Calls within an instance
 * are synchronous and non-reentrant, as for the parser's existing heap arena.
 */
#define FREESTANDING
#include "vendor/libdeflate/lib/deflate_decompress.c"

/* Zero initialization satisfies the upstream decompressor construction
 * contract. Never free this static object or expose it to another worker. */
static struct libdeflate_decompressor term_bank_decompressor;

int32_t term_bank_inflate(
    const uint8_t* input,
    uint32_t input_length,
    uint8_t* output,
    uint32_t output_length
) {
    size_t consumed = 0;
    size_t produced = 0;
    const enum libdeflate_result result = libdeflate_deflate_decompress_ex(
        &term_bank_decompressor, input, input_length, output, output_length,
        &consumed, &produced
    );
    if (result != LIBDEFLATE_SUCCESS) { return -2; }
    if (produced != output_length) { return -3; }
    if (consumed != input_length) { return -6; }
    return 0;
}
''')
text = source.read_text()
a = text.index('#define MINIZ_NO_MALLOC')
b = text.index('static uint32_t crc32_table', a)
text = text[:a] + '''int32_t term_bank_inflate(const uint8_t* input, uint32_t input_length,
                          uint8_t* output, uint32_t output_length);

''' + text[b:]
a = text.index('            tinfl_decompressor decompressor;')
b = text.index('        } else {', a)
text = text[:a] + '''            const int32_t status = term_bank_inflate(
                input + input_offset, compressed_length, inflated, uncompressed_length
            );
            if (status != 0) { return status; }
''' + text[b:]
source.write_text(text)
assert hashlib.sha256(source.read_bytes()).hexdigest() == '723f12e258cf4bf6c0bcd311d7ad92a17ab90c4f3bc9ad85f45e2565cc946850'
assert hashlib.sha256((root / 'ext/js/dictionary/wasm/term-bank-inflate.c').read_bytes()).hexdigest() == '6d86d0a56f524cdccd1701a9ac7c466c50ecc699ef68d377a82b9f2aaaa317cc'
path = root / 'dev/build-libs.js'
text = path.read_text()
old = "args.push('-Wl,--strip-all', '-o', target.outputPath, target.sourcePath);"
assert text.count(old) == 1
path.write_text(text.replace(old, "args.push('-Wl,--strip-all', '-o', target.outputPath, target.sourcePath, path.join(extDir, 'js', 'dictionary', 'wasm', 'term-bank-inflate.c'));"))
