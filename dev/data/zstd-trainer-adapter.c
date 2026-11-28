/* Private trainer-worker adapter; this ABI is not shared with the lookup codec. */
#define ZDICT_STATIC_LINKING_ONLY
#include <zdict.h>
#include <zstd.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* 0=success, 1=invalid input, 2=allocation failure, 3=trainer rejected corpus,
 * 4=invalid trained dictionary. Output length is zero on every failure.
 * The JS wrapper supplies valid WASM allocations for every pointer. */
int manabitan_train_dictionary(uint8_t *destination, uint32_t capacity,
    const uint8_t *samples, uint32_t sample_bytes, const uint8_t *lengths_le,
    uint32_t count, uint32_t strategy, int level, uint32_t *written) {
    if (!written) return 1;
    *written = 0;
    if (!destination || !samples || !lengths_le || capacity < 1024 ||
        capacity > 112640 || count < 8 || count > 50000 ||
        sample_bytes == 0 || sample_bytes > 32u * 1024u * 1024u ||
        strategy > 2 || level < -1 || level > 9) return 1;
    size_t *lengths = malloc((size_t)count * sizeof(*lengths));
    if (!lengths) return 2;
    uint64_t total = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const uint8_t *p = lengths_le + (size_t)i * 4;
        uint32_t n = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
            ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
        if (n == 0 || n > 256u * 1024u) { free(lengths); return 1; }
        total += n;
        if (total > sample_bytes) { free(lengths); return 1; }
        lengths[i] = n;
    }
    if (total != sample_bytes) { free(lengths); return 1; }
    size_t result;
    if (strategy == 0) {
        result = ZDICT_trainFromBuffer(destination, capacity, samples, lengths, count);
    } else {
        ZDICT_fastCover_params_t params;
        memset(&params, 0, sizeof(params));
        params.d = 8;
        params.steps = 4;
        params.f = strategy == 1 ? 20 : 18;
        params.accel = 1;
        params.nbThreads = 1;
        params.splitPoint = 0.75;
        params.zParams.compressionLevel = level;
        result = ZDICT_optimizeTrainFromBuffer_fastCover(destination, capacity,
            samples, lengths, count, &params);
    }
    free(lengths);
    if (ZDICT_isError(result)) {
        const ZSTD_ErrorCode error = ZSTD_getErrorCode(result);
        return error == ZSTD_error_memory_allocation || error == ZSTD_error_workSpace_tooSmall ? 5 : 3;
    }
    if (result < 8 || result > capacity ||
        ZDICT_getDictID(destination, result) == 0) return 4;
    *written = (uint32_t)result;
    return 0;
}
