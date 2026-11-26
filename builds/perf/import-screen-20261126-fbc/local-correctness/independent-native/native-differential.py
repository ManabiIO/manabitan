from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path('/workspace/scratch/fbc366eaf75c')
work = Path(os.environ.get('OUTPUT_DIR', Path(__file__).resolve().parent))
work.mkdir(parents=True, exist_ok=True)
sources = {
    'baseline': Path(os.environ.get('BASELINE_C', root / 'manabitan/ext/js/dictionary/wasm/term-bank-parser.c')),
    'candidate': Path(os.environ.get('CANDIDATE_C', root / 'manabitan-jmdict/ext/js/dictionary/wasm/term-bank-parser.c')),
}
functions = []
identities = {}
for label, path in sources.items():
    raw = path.read_bytes()
    contents = raw.decode()
    start = contents.index('static int copy_valid_utf8(')
    end = contents.index('\nstatic uint32_t key_hex4', start)
    function = contents[start:end].strip()
    identities[label] = {
        'path': str(path),
        'sourceSha256': hashlib.sha256(raw).hexdigest(),
        'functionSha256': hashlib.sha256(function.encode()).hexdigest(),
    }
    functions.append(function.replace('copy_valid_utf8(', f'{label}_copy('))

prefix = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
'''
runner = r'''
static uint64_t checked = 0;
static void compare(const uint8_t *bytes, uint32_t length, int expected) {
    uint8_t baseline[112], candidate[112];
    assert(length <= 96);
    memset(baseline, 0xa5, sizeof baseline);
    memset(candidate, 0xa5, sizeof candidate);
    int a = baseline_copy(baseline + 8, bytes, length);
    int b = candidate_copy(candidate + 8, bytes, length);
    assert(a == b);
    assert(expected < 0 || b == expected);
    assert(memcmp(baseline, candidate, sizeof baseline) == 0);
    for (uint32_t i = 0; i < 8; ++i) assert(candidate[i] == 0xa5);
    for (uint32_t i = 8 + length; i < sizeof candidate; ++i) assert(candidate[i] == 0xa5);
    if (b) assert(memcmp(candidate + 8, bytes, length) == 0);
    ++checked;
}
static uint32_t encode(uint32_t cp, uint8_t *bytes) {
    if (cp < 0x80) { bytes[0] = cp; return 1; }
    if (cp < 0x800) { bytes[0] = 0xc0 | (cp >> 6); bytes[1] = 0x80 | (cp & 63); return 2; }
    if (cp < 0x10000) { bytes[0] = 0xe0 | (cp >> 12); bytes[1] = 0x80 | ((cp >> 6) & 63); bytes[2] = 0x80 | (cp & 63); return 3; }
    bytes[0] = 0xf0 | (cp >> 18); bytes[1] = 0x80 | ((cp >> 12) & 63); bytes[2] = 0x80 | ((cp >> 6) & 63); bytes[3] = 0x80 | (cp & 63); return 4;
}
static uint32_t state = 0xc73419a5;
static uint32_t random_word(void) {
    state ^= state << 13; state ^= state >> 17; state ^= state << 5; return state;
}
int main(void) {
    uint8_t bytes[96] = {0};
    compare(bytes, 0, 1);
    for (uint32_t width = 1; width <= 3; ++width) {
        uint32_t count = 1u << (width * 8);
        for (uint32_t value = 0; value < count; ++value) {
            for (uint32_t i = 0; i < width; ++i) bytes[i] = value >> (i * 8);
            compare(bytes, width, -1);
        }
    }
    fprintf(stderr, "exhaustive complete: %llu\n", (unsigned long long)checked);
    const uint64_t exhaustive = checked;
    for (uint32_t cp = 0; cp <= 0x10ffff; ++cp) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        uint32_t width = encode(cp, bytes);
        compare(bytes, width, 1);
        bytes[width] = 'x'; bytes[width + 1] = 'y';
        compare(bytes, width + 2, 1);
    }
    fprintf(stderr, "scalar complete: %llu\n", (unsigned long long)checked);
    const uint64_t valid_scalars = checked - exhaustive;
    for (uint32_t i = 0; i < 1000000; ++i) {
        uint32_t length = random_word() % 97;
        for (uint32_t j = 0; j < length; ++j) bytes[j] = random_word();
        compare(bytes, length, -1);
    }
    const long page = sysconf(_SC_PAGESIZE);
    assert(page >= 4096);
    uint8_t *input = mmap(0, page * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    uint8_t *output = mmap(0, page * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    assert(input != MAP_FAILED && output != MAP_FAILED);
    assert(mprotect(input + page, page, PROT_NONE) == 0);
    assert(mprotect(output + page, page, PROT_NONE) == 0);
    uint64_t guarded = 0;
    for (uint32_t length = 0; length <= 4; ++length) {
        for (uint32_t lead = 0; lead <= 255; ++lead) {
            for (uint32_t tail = 0; tail < 4; ++tail) {
                uint8_t expected[8];
                uint8_t *source = input + page - length;
                uint8_t *target = output + page - length;
                memset(source, (uint8_t[]){0x7f, 0x80, 0xbf, 0xc0}[tail], length);
                if (length > 0) source[0] = lead;
                memset(target, 0xa5, length);
                memset(expected, 0xa5, sizeof expected);
                int a = baseline_copy(expected, source, length);
                int b = candidate_copy(target, source, length);
                assert(a == b && memcmp(expected, target, length) == 0);
                ++guarded;
            }
        }
    }
    assert(munmap(input, page * 2) == 0);
    assert(munmap(output, page * 2) == 0);
    printf("{\"allByteStringsThroughThreeBytes\":%llu,\"unicodeScalarCases\":%llu,\"randomByteStrings\":1000000,\"guardedTailCases\":%llu,\"totalCases\":%llu,\"parity\":true}\n", (unsigned long long)exhaustive, (unsigned long long)valid_scalars, (unsigned long long)guarded, (unsigned long long)(checked + guarded));
    return 0;
}
'''
c_source = work / 'native-differential.c'
c_source.write_text(prefix + '\n\n'.join(functions) + runner)
compile_args = ['gcc', '-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-Wall', '-Wextra', '-Werror', str(c_source), '-o', str(work / 'native-differential')]
subprocess.run(compile_args, check=True)
sanitizer_env = {**os.environ, 'ASAN_OPTIONS': 'detect_leaks=0'}
run = subprocess.run([str(work / 'native-differential')], check=True, text=True, stdout=subprocess.PIPE, env=sanitizer_env)
report = {'sources': identities, 'compile': compile_args, 'sanitizerOptions': {'ASAN_OPTIONS': 'detect_leaks=0', 'reason': 'LeakSanitizer cannot run under sandbox ptrace; ASan and UBSan bounds checks remain enabled'}, 'result': json.loads(run.stdout), 'stderrLog': str(work / 'native-differential.log')}
(work / 'native-differential.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report['result']))
