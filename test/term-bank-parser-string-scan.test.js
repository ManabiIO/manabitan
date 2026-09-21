function readSpan(result, offset) {
    const start = result.spans[offset]
    return JSON.parse(decoder.decode(result.bytes.subarray(start, start + result.spans[offset + 1])))
}

/**
 * Score metadata is a source offset, unlike the int32 sequence field. Use the
 * platform parser independently rather than copying the production decoder.
 * @param {ReturnType<typeof parse>} result
 * @returns {unknown}
 */
function readScore(result) {
    const start = result.spans[8]
    let end = start
    while (end < result.bytes.length && result.bytes[end] !== 0x2c) { ++end }
    return JSON.parse(decoder.decode(result.bytes.subarray(start, end)))
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
        readScore(result),
        readSpan(result, 9),
        result.spans[11] | 0,
        readSpan(result, 12),
    ]
}
