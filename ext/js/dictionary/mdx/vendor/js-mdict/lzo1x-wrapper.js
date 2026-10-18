// @ts-nocheck
import lzo from './lzo1x.js';

const INITIAL_OUTPUT_BYTES = 16 * 1024;
const GROWTH_BLOCK_BYTES = 16 * 1024;

function decompress(buf, expectedSize) {
    if (!(buf instanceof Uint8Array) ||
        !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        throw new RangeError('Invalid MDict LZO decompression bounds');
    }
    const result = lzo.decompress({
        inputBuffer: buf,
        initSize: Math.min(expectedSize, INITIAL_OUTPUT_BYTES),
        blockSize: GROWTH_BLOCK_BYTES,
        maxOutputSize: expectedSize,
    });
    if (!(result instanceof Uint8Array)) {
        throw new Error(`MDict LZO decompression failed with status ${String(result)}`);
    }
    return result;
}
function compress(state) {
    return lzo.compress(state);
}
export { decompress, compress };
export default { decompress, compress };
//# sourceMappingURL=lzo1x-wrapper.js.map
