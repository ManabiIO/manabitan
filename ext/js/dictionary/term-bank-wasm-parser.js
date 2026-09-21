function decodeRawToken(source, start, length) {
    if (length <= 0) { return ''; }
    return decodeParserText(source.subarray(start, start + length));
}

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @returns {number}
 */
function decodeJsonNumberToken(source, start) {
    let end = start;
    while (end < source.length) {
        const value = source[end];
        if (value === U8_COMMA || value === 0x5d || value === 0x7d || isJsonWhitespace(value)) { break; }
        ++end;
    }
    const value = Number(decodeParserText(source.subarray(start, end)));
    if (!Number.isFinite(value)) {
        throw new RangeError('Term-bank number must be finite');
    }
    return value;
}
