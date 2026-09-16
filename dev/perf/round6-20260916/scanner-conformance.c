#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <assert.h>
#include "scanner-under-test.h"

static int reference(const uint8_t *s, uint32_t n, uint32_t at, uint32_t *end) {
    if (at >= n || s[at] != '"') { return 0; }
    for (uint32_t i = at + 1; i < n; ++i) {
        unsigned c = s[i];
        if (c == '"') { *end = i + 1; return 1; }
        if (c < 32) { return 0; }
        if (c != '\\') { continue; }
        if (++i == n) { return 0; }
        if (s[i] == 'u') {
            for (int k = 0; k < 4; ++k) {
                if (++i == n) { return 0; }
                c = s[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) { return 0; }
            }
        } else if (!strchr("\"\\/bfnrt", s[i]) || s[i] == 0) { return 0; }
    }
    return 0;
}

static unsigned long long cases = 0;
static void check(const uint8_t *source, uint32_t size, uint32_t start) {
    uint8_t *buf = malloc(size ? size : 1);
    assert(buf);
    memcpy(buf, source, size);
    uint32_t a = 0xfeedface, b = a;
    int ra = parse_string_span(buf, size, start, &a), rb = reference(buf, size, start, &b);
    if (ra != rb || (ra && a != b)) {
        fprintf(stderr, "case %llu size %u start %u result %d/%u vs %d/%u\n", cases, size, start, ra, a, rb, b);
        abort();
    }
    free(buf);
    ++cases;
}

int main(void) {
    uint8_t s[512];
    for (unsigned pos = 0; pos < 16; ++pos) {
        for (unsigned a = 0; a < 256; ++a) {
            for (unsigned b = 0; b < 256; ++b) {
                memset(s, 'x', 32);
                s[0] = '"';
                s[pos + 1] = a;
                s[pos + 2] = b;
                s[31] = '"';
                check(s, 32, 0);
            }
        }
    }
    uint32_t state = 0x91e10da5;
    for (unsigned trial = 0; trial < 200000; ++trial) {
        state = state * 1664525u + 1013904223u;
        unsigned n = state % sizeof(s);
        for (unsigned i = 0; i < n; ++i) {
            state = state * 1664525u + 1013904223u;
            s[i] = (uint8_t)(state >> 24);
        }
        unsigned start = trial % 17;
        if (start < n) { s[start] = '"'; }
        check(s, n, start);
    }
    const char *valid[] = {"\"\"", "\"ordinary text\"", "\"\\u0000\\u65e5\\uD83D\\uDE42\\\\\\\"tail\"", "\"\\b\\f\\n\\r\\t\\/\""};
    for (unsigned i = 0; i < sizeof(valid) / sizeof(*valid); ++i) {
        for (unsigned pad = 0; pad < 32; ++pad) {
            memset(s, 'a', sizeof(s));
            unsigned n = (unsigned)strlen(valid[i]);
            memcpy(s + pad, valid[i], n);
            for (unsigned k = 0; k <= n; ++k) { check(s, pad + k, pad); }
        }
    }
    printf("{\"status\":\"success\",\"cases\":%llu}\n", cases);
}
