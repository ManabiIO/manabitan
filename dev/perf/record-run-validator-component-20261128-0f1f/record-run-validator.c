/* Experimental component, bound to the 9e10 record-run validation loop. */
#include <stdint.h>

typedef struct {
    uint32_t run_end;
    uint32_t error_row;
    double minimum;
    double maximum;
} RunResult;

static int span_valid(uint32_t pointer, uint32_t count, uint32_t width, uint64_t heap) {
    return (uint64_t)pointer + (uint64_t)count * width <= heap;
}

/* Inputs have already passed the same finite/safe-integer validation as JS.
 * These forms preserve Math.min/Math.max's signed-zero behavior. */
static double minimum(double a, double b) {
    if (a < b) { return a; }
    if (a > b) { return b; }
    return __builtin_signbit(a) ? a : b;
}

static double maximum(double a, double b) {
    if (a > b) { return a; }
    if (a < b) { return b; }
    return __builtin_signbit(a) ? b : a;
}

/* Status: 0 success, 1 bad unique index, 2 bad offset, 3 bad length,
 * -1 invalid component ABI. The adapter retains JS error formatting.
 * IDs cover exactly one requested run window; returned row indexes are local.
 * No input is modified. The sole output is written after all relevant reads.
 */
__attribute__((export_name("validate_record_run")))
int32_t validate_record_run(
    uint32_t ids_pointer, uint32_t row_count,
    uint32_t offsets_pointer, uint32_t lengths_pointer, uint32_t unique_count,
    uint32_t result_pointer
) {
    uint64_t heap = (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
    if (result_pointer == 0u ||
        (row_count != 0u && ids_pointer == 0u) ||
        (unique_count != 0u && (offsets_pointer == 0u || lengths_pointer == 0u)) ||
        (ids_pointer & 3u) != 0u || (offsets_pointer & 7u) != 0u ||
        (lengths_pointer & 3u) != 0u || (result_pointer & 7u) != 0u ||
        !span_valid(ids_pointer, row_count, 4u, heap) ||
        !span_valid(offsets_pointer, unique_count, 8u, heap) ||
        !span_valid(lengths_pointer, unique_count, 4u, heap) ||
        !span_valid(result_pointer, 1u, sizeof(RunResult), heap)) {
        return -1;
    }
    const uint32_t *ids = (const uint32_t *)(uintptr_t)ids_pointer;
    const double *offsets = (const double *)(uintptr_t)offsets_pointer;
    const uint32_t *lengths = (const uint32_t *)(uintptr_t)lengths_pointer;
    RunResult *result = (RunResult *)(uintptr_t)result_pointer;
    uint32_t row = 0u;
    int32_t status = 0;
    double low = __builtin_inf();
    double high = -__builtin_inf();
    while (row < row_count) {
        uint32_t unique = ids[row];
        if (unique >= unique_count) { status = 1; break; }
        double offset = offsets[unique];
        uint32_t length = lengths[unique];
        if (offset != -1.0 &&
            !(offset >= 0.0 && offset <= 9007199254740991.0 && offset == __builtin_trunc(offset))) {
            status = 2;
            break;
        }
        if (length == 0xffffffffu) { status = 3; break; }
        double next_low = offset >= 0.0 ? minimum(low, offset) : low;
        double next_high = offset >= 0.0 ? maximum(high, offset) : high;
        /* Validate this row before deciding whether its span starts a new run. */
        if (row > 0u && next_low != __builtin_inf() && next_high - next_low > 4294967294.0) {
            break;
        }
        low = next_low;
        high = next_high;
        ++row;
        while (row < row_count && ids[row] == unique) { ++row; }
    }
    result->run_end = row;
    result->error_row = row;
    result->minimum = low;
    result->maximum = high;
    return status;
}
