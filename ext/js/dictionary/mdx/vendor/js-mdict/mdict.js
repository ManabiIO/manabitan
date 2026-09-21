// @ts-nocheck
import MdictBase from './mdict-base.js';
import common from './utils.js';
import lzo1x from './lzo1x-wrapper.js';
import {inflateSync} from '../pako.js';
import {bytesToHex} from '../../browser-util.js';

const DEFAULT_MAX_DECOMPRESSED_BLOCK_BYTES = 256 * 1024 * 1024;

export class Mdict extends MdictBase {
    constructor(fname, source, options) {
        var _a, _b, _c, _d, _e, _f;
        options = options || {};
        const isStripKeyOverride = typeof options.isStripKey === 'boolean' ? options.isStripKey : null;
        const isCaseSensitiveOverride = typeof options.isCaseSensitive === 'boolean' ? options.isCaseSensitive : null;
        const recordBlockCacheBytes = options.recordBlockCacheBytes ?? 0;
        if (!Number.isSafeInteger(recordBlockCacheBytes) || recordBlockCacheBytes < 0) {
            throw new RangeError('Invalid MDict record block cache budget');
        }
        const maxDecompressedBlockBytes = options.maxDecompressedBlockBytes ?? DEFAULT_MAX_DECOMPRESSED_BLOCK_BYTES;
        if (!Number.isSafeInteger(maxDecompressedBlockBytes) || maxDecompressedBlockBytes < 0) {
            throw new RangeError('Invalid MDict decompressed block limit');
        }
        // default options
        options = {
            passcode: (_a = options.passcode) !== null && _a !== void 0 ? _a : '',
            debug: (_b = options.debug) !== null && _b !== void 0 ? _b : false,
            resort: (_c = options.resort) !== null && _c !== void 0 ? _c : true,
            isStripKey: (_d = options.isStripKey) !== null && _d !== void 0 ? _d : true,
            isCaseSensitive: (_e = options.isCaseSensitive) !== null && _e !== void 0 ? _e : true,
            encryptType: (_f = options.encryptType) !== null && _f !== void 0 ? _f : -1,
            recordBlockCacheBytes,
            maxDecompressedBlockBytes,
        };
        const passcode = options.passcode || undefined;
        super(fname, source, passcode, options);
        this._isStripKeyOverride = isStripKeyOverride;
        this._isCaseSensitiveOverride = isCaseSensitiveOverride;
        this._lookupKeywordList = null;
        this._recordBlockCache = new Map();
        this._recordBlockCacheSize = 0;
    }
    /**
     * lookupKeyInfoItem lookup the `keyInfoItem`
     * the `keyInfoItem` contains key-word record block location: recordStartOffset
     * the `recordStartOffset` should indicate the unpacked record data relative offset
     * @param word the target word phrase
     */
    _getLookupKeywordList() {
        if (this._lookupKeywordList !== null) { return this._lookupKeywordList; }
        const list = [...this.keywordList];
        list.sort((item1, item2) => {
            const result = this.comp(this.strip(item1.keyText), this.strip(item2.keyText));
            return result !== 0 ? result : this.comp(item1.keyText, item2.keyText);
        });
        this._lookupKeywordList = list;
        return list;
    }
    lookupKeyBlockByWord(word, isAssociate = false) {
        // Direct lookup must use the dictionary's StripKey/KeyCaseSensitive
        // rules rather than the source spelling used by the import iterator.
        const list = this._getLookupKeywordList();
        if (list.length === 0) {
            return undefined;
        }
        const normalizedWord = this.strip(word);
        // binary search
        let left = 0;
        let right = list.length - 1;
        let mid = 0;
        while (left <= right) {
            mid = left + ((right - left) >> 1);
            const compRes = this.comp(normalizedWord, this.strip(list[mid].keyText));
            if (compRes > 0) {
                left = mid + 1;
            }
            else if (compRes == 0) {
                break;
            }
            else {
                right = mid - 1;
            }
        }
        if (this.comp(normalizedWord, this.strip(list[mid].keyText)) != 0) {
            if (!isAssociate) {
                return undefined;
            }
        }
        return list[mid];
    }
    /**
     * locate the record meaning buffer by `keyListItem`
     * the `KeyBlockItem.recordStartOffset` should indicate the record block info location
     * use the record block info, we can get the `recordBuffer`, then we need decrypt and decompress
     * use decompressed `recordBuffer` we can get the total block which contains meanings
     * then, use:
     *  const start = item.recordStartOffset - recordBlockInfo.unpackAccumulatorOffset;
     *  const end = item.recordEndOffset - recordBlockInfo.unpackAccumulatorOffset;
     *  the finally meaning's buffer is `unpackRecordBlockBuff[start, end]`
     * @param item
     */
    lookupRecordByKeyBlock(item) {
        if (!item || this.recordInfoList.length === 0) { return null; }
        const start = item.recordStartOffset;
        const end = item.recordEndOffset;
        const lastBlock = this.recordInfoList.at(-1);
        const totalSize = typeof lastBlock === 'undefined' ? 0 : lastBlock.unpackAccumulatorOffset + lastBlock.unpackSize;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            !Number.isSafeInteger(totalSize) || start < 0 || end < start || end > totalSize) {
            throw new RangeError('Invalid MDict record range');
        }
        if (start === end) { return new Uint8Array(0); }

        let blockIndex = this.reduceRecordBlockInfo(start);
        let position = start;
        let output = null;
        while (position < end) {
            const info = this.recordInfoList[blockIndex];
            if (typeof info === 'undefined' || !Number.isSafeInteger(info.unpackAccumulatorOffset) ||
                !Number.isSafeInteger(info.unpackSize) || info.unpackSize < 0) {
                throw new RangeError('Invalid MDict record block metadata');
            }
            const blockStart = info.unpackAccumulatorOffset;
            const blockEnd = blockStart + info.unpackSize;
            if (!Number.isSafeInteger(blockEnd) || blockStart > position ||
                (position !== start && blockStart !== position) || blockEnd < position) {
                throw new RangeError('Non-contiguous MDict record blocks');
            }
            if (blockEnd === position) {
                blockIndex += 1;
                continue;
            }
            const bytes = this._readRecordBlock(blockIndex);
            const nextPosition = Math.min(end, blockEnd);
            const from = position - blockStart;
            const to = nextPosition - blockStart;
            if (position === start && nextPosition === end) {
                return new Uint8Array(bytes.subarray(from, to));
            }
            if (output === null) { output = new Uint8Array(end - start); }
            output.set(bytes.subarray(from, to), position - start);
            position = nextPosition;
            blockIndex += 1;
        }
        return output;
    }

    _readRecordBlock(blockIndex) {
        const cached = this._recordBlockCache.get(blockIndex);
        if (typeof cached !== 'undefined') {
            this._recordBlockCache.delete(blockIndex);
            this._recordBlockCache.set(blockIndex, cached);
            return cached;
        }
        const info = this.recordInfoList[blockIndex];
        const packed = this.scanner.readBuffer(
            this._recordBlockStartOffset + info.packAccumulateOffset,
            info.packSize,
        );
        const bytes = this.decompressBuff(packed, info.unpackSize);
        const budget = this.options.recordBlockCacheBytes;
        if (budget > 0 && bytes.byteLength > 0 && bytes.byteLength <= budget) {
            const owned = new Uint8Array(bytes);
            while (this._recordBlockCache.size >= 64 || this._recordBlockCacheSize + owned.byteLength > budget) {
                const oldest = this._recordBlockCache.keys().next().value;
                const evicted = this._recordBlockCache.get(oldest);
                this._recordBlockCache.delete(oldest);
                this._recordBlockCacheSize -= evicted.byteLength;
            }
            this._recordBlockCache.set(blockIndex, owned);
            this._recordBlockCacheSize += owned.byteLength;
            return owned;
        }
        return bytes;
    }
    /**
     * lookupPartialKeyInfoListById
     * decode key block by key block id, and we can get the partial key list
     * the key list just contains the partial key list
     * @param {number} keyInfoId key block id
     * @return {KeyWordItem[]}
     */
    lookupPartialKeyBlockListByKeyInfoId(keyInfoId) {
        const packSize = this.keyInfoList[keyInfoId].keyBlockPackSize;
        const unpackSize = this.keyInfoList[keyInfoId].keyBlockUnpackSize;
        const startOffset = this.keyInfoList[keyInfoId].keyBlockPackAccumulator + this._keyBlockStartOffset;
        const keyBlockPackedBuff = this.scanner.readBuffer(startOffset, packSize);
        const keyBlock = this.unpackKeyBlock(keyBlockPackedBuff, unpackSize);
        return this.splitKeyBlock(keyBlock, keyInfoId);
    }
    /**
     * lookupInfoBlock reduce word find the nearest key block
     * @param {string} word searching phrase
     * @param keyInfoList
     */
    lookupKeyInfoByWord(word, keyInfoList) {
        const list = keyInfoList ? keyInfoList : this.keyInfoList;
        let left = 0;
        let right = list.length - 1;
        let mid = 0;
        // when compare the word, the uppercase words are less than lowercase words
        // so we compare with the greater symbol is wrong, we need to use the `common.wordCompare` function
        while (left <= right) {
            mid = left + ((right - left) >> 1);
            if (this.comp(word, list[mid].firstKey) >= 0 &&
                this.comp(word, list[mid].lastKey) <= 0) {
                return mid;
            }
            else if (this.comp(word, list[mid].lastKey) >= 0) {
                left = mid + 1;
            }
            else {
                right = mid - 1;
            }
        }
        return -1;
    }
    decompressBuff(recordBuffer, unpackSize) {
        if (!(recordBuffer instanceof Uint8Array) || recordBuffer.byteLength < 8 ||
            !Number.isSafeInteger(unpackSize) || unpackSize < 0 ||
            unpackSize > this.options.maxDecompressedBlockBytes) {
            throw new RangeError('Invalid or oversized MDict compressed block');
        }
        // decompress
        // 4 bytes: compression type
        const rbCompType = bytesToHex(recordBuffer.subarray(0, 4));
        // record_block stores the final record data
        let unpackRecordBlockBuff = new Uint8Array(recordBuffer.length);
        const recordBlockChecksum = common.b2n(recordBuffer.subarray(4, 8));
        if (rbCompType === '00000000') {
            unpackRecordBlockBuff = recordBuffer.slice(8);
        }
        else {
            // decrypt
            let blockBufDecrypted = null;
            // if encrypt type == 1, the record block was encrypted
            if (this.meta.encrypt === 1 /* || (this.meta.ext == "mdd" && this.meta.encrypt === 2 ) */) {
                // const passkey = new Uint8Array(8);
                // record_block_compressed.copy(passkey, 0, 4, 8);
                // passkey.set([0x95, 0x36, 0x00, 0x00], 4); // key part 2: fixed data
                blockBufDecrypted = common.mdxDecrypt(recordBuffer);
            }
            else {
                blockBufDecrypted = recordBuffer.subarray(8, recordBuffer.length);
            }
            // decompress
            if (rbCompType === '01000000') {
                unpackRecordBlockBuff = lzo1x.decompress(blockBufDecrypted, unpackSize);
            } else if (rbCompType === '02000000') {
                // zlib decompress
                unpackRecordBlockBuff = inflateSync(blockBufDecrypted, unpackSize);
            } else {
                throw new Error(`cannot determine the record compression type: ${rbCompType}`);
            }
        }
        if (unpackRecordBlockBuff.length !== unpackSize) {
            throw new Error('MDict decompressed block size mismatch');
        }
        if (common.adler32(unpackRecordBlockBuff) !== recordBlockChecksum) {
            throw new Error('MDict record block checksum mismatch');
        }
        return unpackRecordBlockBuff;
    }
    /**
     * find record which record start locate
     * @param {number} recordStart record start offset
     */
    reduceRecordBlockInfo(recordStart) {
        let left = 0;
        let right = this.recordInfoList.length - 1;
        let mid = 0;
        while (left <= right) {
            mid = left + ((right - left) >> 1);
            if (recordStart >= this.recordInfoList[mid].unpackAccumulatorOffset) {
                left = mid + 1;
            }
            else {
                right = mid - 1;
            }
        }
        return left - 1;
    }
    close() {
        this.scanner.close();
        this.keywordList = [];
        this.keyInfoList = [];
        this.recordInfoList = [];
        this._recordBlockCache.clear();
        this._recordBlockCacheSize = 0;
    }
}
/**
 * 经过一系列测试, 发现mdx格式的文件存在较大的词语排序问题，存在如下情况：
 * 1. 大小写的问题 比如 a-zA-Z 和 aA-zZ 这种并存的情况
 * 2. 多语言的情况，存在英文和汉字比较大小的情况一般情况下 英文应当排在汉字前面
 * 3. 小语种的情况
 * 上述的这些情况都有可能出现，无法通过字典头中的设置实现排序，所以无法通过内部的keyInfoList进行快速索引，
 * 在现代计算机的性能条件下，直接遍历全部词条也可得到较好的效果，因此目前采用的策略是全部读取词条，内部排序
 *
 */
export default Mdict;
//# sourceMappingURL=mdict.js.map
