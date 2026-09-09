/* SPDX-License-Identifier: GPL-3.0-or-later
 * Production miniz core, with a test-selected bit-buffer type. No source edits.
 * zlib creates the independent compressed inputs. mmap guards bounded reads.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <zlib.h>

#define MINIZ_NO_MALLOC
#define MINIZ_NO_STDIO
#define MINIZ_NO_TIME
#define MINIZ_NO_ARCHIVE_APIS
#define MINIZ_NO_DEFLATE_APIS
#define MINIZ_NO_ZLIB_APIS
#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES
#ifndef TEST_BITS
#define TEST_BITS 64
#endif
/* Fix the type before the platform heuristic is loaded by miniz.h. */
#define MINIZ_HAS_64BIT_REGISTERS (TEST_BITS == 64)
#include "miniz_tinfl.h"
#undef MINIZ_HAS_64BIT_REGISTERS
#include "miniz_tinfl.c"
_Static_assert(TINFL_BITBUF_SIZE == TEST_BITS, "test did not select the requested bit buffer");

static void require(int ok, const char *why) {
    if (!ok) { fprintf(stderr, "FAIL: %s\n", why); exit(1); }
}
static unsigned cases = 0;
static void check(const unsigned char *input, size_t compressed_size,
                  const unsigned char *raw, size_t raw_size, size_t in_chunk, size_t out_chunk) {
    unsigned char *output = malloc(raw_size + 32);
    require(output != NULL, "allocation");
    memset(output, 0xa5, raw_size + 32);
    tinfl_decompressor decoder;
    tinfl_init(&decoder);
    size_t in_pos = 0, out_pos = 0, iteration = 0;
    tinfl_status status;
    do {
        size_t in_size = compressed_size - in_pos;
        if (in_size > in_chunk) in_size = in_chunk;
        size_t out_size = raw_size - out_pos;
        if (out_size > out_chunk) out_size = out_chunk;
        unsigned flags = TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
        if (in_pos + in_size < compressed_size) flags |= TINFL_FLAG_HAS_MORE_INPUT;
        status = tinfl_decompress(&decoder, input + in_pos, &in_size,
                                 output + 16, output + 16 + out_pos, &out_size, flags);
        in_pos += in_size; out_pos += out_size;
        require(++iteration <= raw_size + compressed_size + 100, "progress");
    } while (status > TINFL_STATUS_DONE);
    require(status == TINFL_STATUS_DONE && out_pos == raw_size && in_pos == compressed_size, "decode completion");
    require(memcmp(output + 16, raw, raw_size) == 0, "independent bytes");
    for (size_t i = 0; i < 16; ++i) {
        require(output[i] == 0xa5 && output[16 + raw_size + i] == 0xa5, "output guard");
    }
    free(output); ++cases;
}
int main(void) {
    const int levels[] = {0, 1, 6, 9};
    const size_t lengths[] = {0, 1, 2, 7, 8, 9, 31, 32, 63, 64, 257, 258, 1024, 32767, 32768, 32769, 65536};
    const size_t page = (size_t)sysconf(_SC_PAGESIZE);
    require(page > 0, "page size");
    for (size_t l = 0; l < sizeof(levels) / sizeof(levels[0]); ++l) {
        for (size_t n = 0; n < sizeof(lengths) / sizeof(lengths[0]); ++n) {
            for (unsigned mode = 0; mode < 4; ++mode) {
                size_t size = lengths[n];
                unsigned char *raw = malloc(size + 1);
                uLong bound = compressBound(size) + 64;
                unsigned char *compressed = malloc(bound);
                require(raw != NULL && compressed != NULL, "fixture allocation");
                uint32_t random = 0x91e10da5u;
                for (size_t i = 0; i < size; ++i) {
                    random ^= random << 13; random ^= random >> 17; random ^= random << 5;
                    raw[i] = mode == 0 ? 'a' : mode == 1 ? (unsigned char)(i % 251) :
                             mode == 2 ? (unsigned char)((i / 259) % 17) : (unsigned char)random;
                }
                z_stream encoder = {0};
                require(deflateInit2(&encoder, levels[l], Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) == Z_OK, "zlib init");
                encoder.next_in = raw; encoder.avail_in = (uInt)size;
                encoder.next_out = compressed; encoder.avail_out = (uInt)bound;
                require(deflate(&encoder, Z_FINISH) == Z_STREAM_END, "zlib encode");
                size_t compressed_size = encoder.total_out;
                deflateEnd(&encoder);
                size_t pages = (compressed_size + page - 1) / page;
                unsigned char *mapping = mmap(NULL, (pages + 1) * page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
                require(mapping != MAP_FAILED, "mmap");
                require(mprotect(mapping + pages * page, page, PROT_NONE) == 0, "guard page");
                unsigned char *guarded_input = mapping + pages * page - compressed_size;
                memcpy(guarded_input, compressed, compressed_size);
                check(guarded_input, compressed_size, raw, size, compressed_size, size + 1);
                check(guarded_input, compressed_size, raw, size, 7, 257);
                check(guarded_input, compressed_size, raw, size, 31, 4096);
                /* Every truncated suffix ends immediately at the unreadable page. */
                for (size_t cut = 1; cut <= 16 && cut <= compressed_size; ++cut) {
                    size_t truncated = compressed_size - cut;
                    unsigned char *tail = mapping + pages * page - truncated;
                    memmove(tail, compressed, truncated);
                    unsigned char *output = malloc(size + 32);
                    require(output != NULL, "truncated output");
                    memset(output, 0xa5, size + 32);
                    tinfl_decompressor decoder; tinfl_init(&decoder);
                    size_t in_size = truncated, out_size = size;
                    tinfl_status status = tinfl_decompress(&decoder, tail, &in_size, output + 16, output + 16, &out_size, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
                    require(status != TINFL_STATUS_DONE, "truncated stream unexpectedly complete");
                    for (size_t i = 0; i < 16; ++i) require(output[i] == 0xa5 && output[16 + size + i] == 0xa5, "truncated guard");
                    free(output); ++cases;
                }
                munmap(mapping, (pages + 1) * page);
                free(compressed); free(raw);
            }
        }
    }
    printf("PASS: %u exact-byte, streaming and guard-page cases; bit buffer %u\n", cases, TINFL_BITBUF_SIZE);
    return 0;
}
