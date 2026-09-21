import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import common from '../../ext/js/dictionary/mdx/vendor/js-mdict/utils.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

/**
 * @returns {ReturnType<typeof makeMdictFixture>}
 */
function fixture() {
    return makeMdictFixture([
        {key: 'alpha', value: 'first definition'},
        {key: 'beta', value: 'second definition'},
    ], {recordBlockSize: 7, keysPerBlock: 1, compression: 'zlib'});
}

/**
 * @param {Uint8Array} bytes
 * @returns {{headerChecksum: number, keyHeaderChecksum: number, keyInfoChecksum: number, keyBlockChecksum: number}}
 */
function offsets(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(0, false);
    const headerChecksum = 4 + headerSize;
    const keyHeader = headerChecksum + 4;
    const keyHeaderChecksum = keyHeader + 40;
    const keyInfoSize = Number(view.getBigUint64(keyHeader + 24, false));
    const keyInfo = keyHeaderChecksum + 4;
    const keyBlock = keyInfo + keyInfoSize;
    return {
        headerChecksum,
        keyHeaderChecksum,
        keyInfoChecksum: keyInfo + 4,
        keyBlockChecksum: keyBlock + 4,
    };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {Uint8Array}
 */
function corrupt(bytes, offset) {
    const copy = new Uint8Array(bytes);
    copy[offset] ^= 1;
    return copy;
}

test('Adler-32 helper matches a standard independent vector', () => {
    assert.equal(common.adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398);
});

/** @type {Array<[string, 'headerChecksum'|'keyHeaderChecksum'|'keyInfoChecksum'|'keyBlockChecksum', RegExp]>} */
const checksumCases = [
    ['header', 'headerChecksum', /header checksum mismatch/u],
    ['key header', 'keyHeaderChecksum', /key header checksum mismatch/u],
    ['key info', 'keyInfoChecksum', /key info checksum mismatch/u],
    ['key block', 'keyBlockChecksum', /key block checksum mismatch/u],
];
for (const [name, key, pattern] of checksumCases) {
    test(`rejects ${name} checksum corruption before exposing dictionary data`, () => {
        const data = fixture();
        const position = offsets(data.bytes)[key];
        assert.throws(() => new MDX('checksum.mdx', corrupt(data.bytes, position)), pattern);
    });
}

test('rejects record block checksum corruption on lazy definition access', () => {
    const data = fixture();
    const mdx = new MDX('checksum.mdx', corrupt(data.bytes, data.recordDataOffset + 4));
    try {
        assert.throws(() => mdx.fetch(mdx.keywordList[0]), /record block checksum mismatch/u);
    } finally {
        mdx.close();
    }
});
