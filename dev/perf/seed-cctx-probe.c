/* Measurement-only probe. Compile with the exact pinned zstd.c in the include path.
 * One owned seed context per working context; no parameter-keyed cache.
 * The dictionary passed by this harness is immutable for the full context lifetime.
 */
#include "zstd.c"

typedef struct {
    ZSTD_CCtx* work;
    ZSTD_CCtx* seed;
    ZSTD_parameters params;
    const void* dictionary;
    size_t dictionarySize;
    int level;
    int ready;
    size_t seedBuilds;
    size_t directFallbacks;
} MB_SeededContext;

MB_SeededContext* mb_create(void) {
    MB_SeededContext* s = (MB_SeededContext*)calloc(1, sizeof(*s));
    if (!s) return NULL;
    s->work = ZSTD_createCCtx();
    s->seed = ZSTD_createCCtx();
    if (!s->work || !s->seed) {
        ZSTD_freeCCtx(s->work);
        ZSTD_freeCCtx(s->seed);
        free(s);
        return NULL;
    }
    return s;
}

void mb_free(MB_SeededContext* s) {
    if (!s) return;
    ZSTD_freeCCtx(s->work);
    ZSTD_freeCCtx(s->seed);
    free(s);
}

size_t mb_context_bytes(const MB_SeededContext* s) {
    return sizeof(*s) + ZSTD_sizeof_CCtx(s->work) + ZSTD_sizeof_CCtx(s->seed);
}

size_t mb_seed_builds(const MB_SeededContext* s) { return s->seedBuilds; }
size_t mb_direct_fallbacks(const MB_SeededContext* s) { return s->directFallbacks; }

size_t mb_compress(MB_SeededContext* s, void* dst, size_t dstCapacity,
                   const void* src, size_t srcSize,
                   const void* dict, size_t dictSize, int level) {
    size_t result;
    ZSTD_parameters params;
    /* copyCCtx treats zero as unknown size, unlike the ordinary one-shot API. */
    if (srcSize == 0) {
        ++s->directFallbacks;
        return ZSTD_compress_usingDict(s->work, dst, dstCapacity, src, srcSize, dict, dictSize, level);
    }
    /* Exactly the parameters selected by ZSTD_compress_usingDict, including
     * its noAttachDict mode. The public getParams() uses a different mode. */
    params = ZSTD_getParams_internal(level, srcSize, dict ? dictSize : 0, ZSTD_cpm_noAttachDict);
    if (!s->ready || s->dictionary != dict || s->dictionarySize != dictSize ||
        s->level != level || memcmp(&s->params, &params, sizeof(params)) != 0) {
        s->ready = 0;
        ZSTD_CCtxParams_init_internal(&s->seed->simpleApiParams, &params,
            level == 0 ? ZSTD_CLEVEL_DEFAULT : level);
        /* This is the initialization used by compress_advanced_internal().
         * Retain the untouched init-stage seed, then copy it for each block. */
        result = ZSTD_compressBegin_internal(s->seed, dict, dictSize,
            ZSTD_dct_auto, ZSTD_dtlm_fast, NULL, &s->seed->simpleApiParams,
            srcSize, ZSTDb_not_buffered);
        if (ZSTD_isError(result)) return result;
        s->params = params;
        s->dictionary = dict;
        s->dictionarySize = dictSize;
        s->level = level;
        s->ready = 1;
        ++s->seedBuilds;
    }
    result = ZSTD_copyCCtx(s->work, s->seed, srcSize);
    if (ZSTD_isError(result)) return result;
    return ZSTD_compressEnd_public(s->work, dst, dstCapacity, src, srcSize);
}
