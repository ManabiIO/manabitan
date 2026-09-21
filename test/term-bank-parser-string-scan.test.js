function readSpan(result, offset) {
    const start = result.spans[offset]
    return JSON.parse(decoder.decode(result.bytes.subarray(start, start + result.spans[offset + 1])))
}

/**
 * @param {ReturnType<typeof parse>} result
 * @returns {unknown[]}
 */
function readRow(result) {
    return [
        readSpan(result, 0),
        readSpan(result, 2),
        readSpan(result, 4),
        readSpan(result, 6),
        result.spans[8] | 0,
        readSpan(result, 9),
        result.spans[11] | 0,
        readSpan(result, 12),
    ]
}
