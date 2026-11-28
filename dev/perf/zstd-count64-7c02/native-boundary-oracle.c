/* Research-only boundary oracle for the pinned Zstd_count change.
 * Includes the exact patched upstream helper; the reference is a scalar byte
 * comparison. Guard pages catch reads beyond either actual allocation end.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <sys/mman.h>
#include <unistd.h>
#include "lib/compress/zstd_compress_internal.h"

#ifndef __wasm32__
#error Compile with __wasm32__ to exercise the new target-specific branch.
#endif

static unsigned long long checks;

static BYTE* guarded(size_t page) {
    void* p = mmap(NULL, page * 2, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED || mprotect((BYTE*)p + page, page, PROT_NONE) != 0) {
        perror("guarded allocation");
        exit(2);
    }
    return (BYTE*)p;
}

static size_t scalar(const BYTE* a, const BYTE* b, size_t length) {
    size_t i = 0;
    while (i < length && a[i] == b[i]) ++i;
    return i;
}

static void check(size_t actual, size_t expected, const char* phase,
                  size_t length, size_t position) {
    ++checks;
    if (actual != expected) {
        fprintf(stderr, "%s length=%zu position=%zu actual=%zu expected=%zu\n",
                phase, length, position, actual, expected);
        exit(1);
    }
}

int main(void) {
    size_t const page = (size_t)sysconf(_SC_PAGESIZE);
    BYTE* const a = guarded(page);
    BYTE* const b = guarded(page);
    BYTE* const c = guarded(page);
    for (size_t slackA = 0; slackA < 16; ++slackA) {
        for (size_t slackB = 0; slackB < 16; ++slackB) {
            for (size_t n = 0; n <= 260; ++n) {
                BYTE* const x = a + page - slackA - n;
                BYTE* const y = b + page - slackB - n;
                for (size_t i = 0; i < n; ++i) x[i] = y[i] = (BYTE)(i * 29 + n);
                check(ZSTD_count(x, y, x + n), scalar(x, y, n), "equal", n, n);
                for (size_t i = 0; i < n; ++i) {
                    y[i] ^= (BYTE)(1u << (i % 8));
                    check(ZSTD_count(x, y, x + n), scalar(x, y, n), "mismatch", n, i);
                    y[i] ^= (BYTE)(1u << (i % 8));
                }
            }
        }
    }
    /* Longer exact-end cases, including the whole final readable page. */
    const size_t longLengths[] = {511, 512, 513, 1023, 1024, 1025, 4095, 4096};
    for (size_t k = 0; k < sizeof(longLengths) / sizeof(longLengths[0]); ++k) {
        size_t const n = longLengths[k];
        if (n > page) continue;
        BYTE* const x = a + page - n;
        BYTE* const y = b + page - n;
        for (size_t i = 0; i < n; ++i) x[i] = y[i] = (BYTE)(i * 17);
        check(ZSTD_count(x, y, x + n), n, "long equal", n, n);
        for (size_t i = 0; i < n; ++i) {
            y[i] ^= 0x80;
            check(ZSTD_count(x, y, x + n), i, "long mismatch", n, i);
            y[i] ^= 0x80;
        }
    }
    /* The external-dictionary path changes allocation at the exact seam. */
    for (size_t n = 0; n <= 96; ++n) {
        for (size_t first = 0; first <= n; ++first) {
            BYTE* const x = a + page - n;
            BYTE* const y = b + page - first;
            BYTE* const z = c + page - (n - first);
            for (size_t i = 0; i < n; ++i) {
                x[i] = (BYTE)(i * 19 + n);
                if (i < first) y[i] = x[i];
                else z[i - first] = x[i];
            }
            check(ZSTD_count_2segments(x, y, x + n, y + first, z), n,
                  "two segments equal", n, first);
            for (size_t i = 0; i < n; ++i) {
                BYTE* const changed = i < first ? y + i : z + i - first;
                *changed ^= 0x40;
                check(ZSTD_count_2segments(x, y, x + n, y + first, z), i,
                      "two segments mismatch", n, i);
                *changed ^= 0x40;
            }
        }
    }
    /* Read-only source/match overlap is allowed for repeat offsets. */
    for (size_t distance = 1; distance <= 32; ++distance) {
        for (size_t n = 0; n <= 260; ++n) {
            BYTE* const x = a + page - n;
            BYTE* const y = x - distance;
            for (size_t i = 0; i < n + distance; ++i) y[i] = (BYTE)(i % distance);
            check(ZSTD_count(x, y, x + n), scalar(x, y, n), "overlap", n, distance);
        }
    }
    printf("{\"status\":\"passed\",\"checks\":%llu,\"pageBytes\":%zu,"
           "\"boundary\":\"Native scalar/guard-page oracle of exact wasm32 branch; not WASM performance\"}\n",
           checks, page);
    munmap(a, page * 2);
    munmap(b, page * 2);
    munmap(c, page * 2);
    return 0;
}
