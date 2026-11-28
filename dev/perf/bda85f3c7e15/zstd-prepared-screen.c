/* Diagnostic only. Original GPL-3.0-or-later code for Manabitan. */
#define ZSTD_STATIC_LINKING_ONLY
#define ZSTD_DISABLE_DEPRECATE_WARNINGS
#include "zstd.h"
#include <stdlib.h>

typedef struct {
    ZSTD_CCtx *context;
    ZSTD_compressionParameters parameters;
    const void *dictionary;
    size_t dictionary_size;
} PreparedDictionary;

static int same_parameters(ZSTD_compressionParameters a, ZSTD_compressionParameters b) {
    return a.windowLog == b.windowLog && a.chainLog == b.chainLog &&
        a.hashLog == b.hashLog && a.searchLog == b.searchLog &&
        a.minMatch == b.minMatch && a.targetLength == b.targetLength &&
        a.strategy == b.strategy;
}

/* The benchmark owns immutable dictionary bytes for this object's lifetime. */
void *manabitan_screen_prepare(const void *dictionary, size_t dictionary_size) {
    PreparedDictionary *prepared = calloc(1, sizeof(*prepared));
    if (prepared == NULL) return NULL;
    prepared->context = ZSTD_createCCtx();
    if (prepared->context == NULL) {
        free(prepared);
        return NULL;
    }
    prepared->dictionary = dictionary;
    prepared->dictionary_size = dictionary_size;
    prepared->parameters = ZSTD_getCParams(-1, 1048576, dictionary_size);
    ZSTD_parameters parameters = {prepared->parameters, {1, 0, 0}};
    size_t result = ZSTD_compressBegin_advanced(
        prepared->context, dictionary, dictionary_size, parameters, 1048576
    );
    if (ZSTD_isError(result)) {
        ZSTD_freeCCtx(prepared->context);
        free(prepared);
        return NULL;
    }
    return prepared;
}

int manabitan_screen_eligible(const void *opaque, size_t source_size) {
    const PreparedDictionary *prepared = opaque;
    return source_size != 0 && same_parameters(
        prepared->parameters,
        ZSTD_getCParams(-1, source_size, prepared->dictionary_size)
    );
}

size_t manabitan_screen_compress(
    ZSTD_CCtx *context, const void *opaque, void *destination,
    size_t destination_capacity, const void *source, size_t source_size
) {
    const PreparedDictionary *prepared = opaque;
    if (!manabitan_screen_eligible(prepared, source_size)) {
        return ZSTD_compress_usingDict(context, destination, destination_capacity,
            source, source_size, prepared->dictionary, prepared->dictionary_size, -1);
    }
    size_t result = ZSTD_copyCCtx(context, prepared->context, source_size);
    if (ZSTD_isError(result)) return result;
    return ZSTD_compressEnd(context, destination, destination_capacity, source, source_size);
}

size_t manabitan_screen_size(const void *opaque) {
    const PreparedDictionary *prepared = opaque;
    return sizeof(*prepared) + ZSTD_sizeof_CCtx(prepared->context);
}

void manabitan_screen_free(void *opaque) {
    PreparedDictionary *prepared = opaque;
    if (prepared == NULL) return;
    ZSTD_freeCCtx(prepared->context);
    free(prepared);
}
