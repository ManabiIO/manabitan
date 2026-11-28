// Exact loop and validation helpers from frozen 9e10d3b3fcf66d344ab31bc42c9b522fa5215da2.
// Extraction changes JavaScript function size, call shape, and possible JIT behavior.
const MAX_CONTENT_OFFSET_DELTA = 0xfffffffe
const U32_NULL = 0xffffffff
function validateContentOffset(value) {
    if (value !== -1 && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`Invalid term content offset: ${value}`);
    }
}
function validateContentLength(value) {
    if (value !== -1 && (!Number.isSafeInteger(value) || value < 0 || value >= U32_NULL)) {
        throw new RangeError(`Invalid term content length: ${value}`);
    }
}
export function baselineScan(references, runStart, runLimitEnd) {
    const chunk = null, contentOffsets = null, contentLengths = null, useFixedContentSpan = false
    let runEnd = runStart
    let minContentOffset = Number.POSITIVE_INFINITY
    let maxContentOffset = Number.NEGATIVE_INFINITY
            while (runEnd < runLimitEnd) {
                let uniqueIndex = -1;
                let contentOffset;
                let contentLength;
                if (references !== null) {
                    uniqueIndex = references.uniqueIndexList[runEnd];
                    if (uniqueIndex >= references.offsets.length) {
                        throw new RangeError(`Invalid resolved term content reference index: ${uniqueIndex}`);
                    }
                    contentOffset = references.offsets[uniqueIndex];
                    contentLength = references.lengths[uniqueIndex];
                } else {
                    contentOffset = getArtifactContentOffset(chunk, contentOffsets, runEnd, useFixedContentSpan);
                    contentLength = getArtifactContentLength(chunk, contentLengths, runEnd);
                }
                validateContentOffset(contentOffset);
                validateContentLength(contentLength);
                const nextMinContentOffset = contentOffset >= 0 ? Math.min(minContentOffset, contentOffset) : minContentOffset;
                const nextMaxContentOffset = contentOffset >= 0 ? Math.max(maxContentOffset, contentOffset) : maxContentOffset;
                if (
                    runEnd > runStart &&
                    nextMinContentOffset !== Number.POSITIVE_INFINITY &&
                    (nextMaxContentOffset - nextMinContentOffset) > MAX_CONTENT_OFFSET_DELTA
                ) {
                    break;
                }
                minContentOffset = nextMinContentOffset;
                maxContentOffset = nextMaxContentOffset;
                ++runEnd;
                if (references !== null) {
                    // Consecutive aliases have the same already-validated span
                    // and cannot change this run's minimum or maximum offset.
                    while (runEnd < runLimitEnd && references.uniqueIndexList[runEnd] === uniqueIndex) {
                        ++runEnd;
                    }
                }
            }
    return {runEnd, minimum: minContentOffset, maximum: maxContentOffset}
}
