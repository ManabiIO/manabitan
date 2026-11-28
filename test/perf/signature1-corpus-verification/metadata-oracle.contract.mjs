import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allocationReceipt, dictionaryNameAllocation, metadataDigest} from './metadata-oracle.mjs';

function fixture(candidate) {
    const memory = {buffer: new ArrayBuffer(candidate ? 24 : 32)};
    const signature1 = candidate ? null : new Uint32Array(memory.buffer, 0, 4);
    signature1?.set([0x3652424d, 0x3652424d, 0, 0]);
    const state = Uint8Array.of(1, 1, 0, 0);
    const database = {
        _termContentMetadataArena: {memory, signature1, state, slots: new Uint32Array(8)},
        _termEntryContentMetaDenseCount: 2,
        _termEntryContentMetaStateTable: state,
        _termEntryContentMetaHashPairTable: new Uint32Array(8),
        _termEntryContentMetaSignature1Table: signature1,
        _termEntryContentMetaSignature2Table: Uint32Array.of(22, 44, 0, 0),
        _termEntryContentMetaSignature3Table: Uint32Array.of(33, 55, 0, 0),
        _termEntryContentMetaSignaturePresentTable: Uint8Array.of(candidate ? 2 : 1, candidate ? 2 : 1, 0, 0),
        _termEntryContentMetaDictNameIdTable: candidate ? null : Uint32Array.of(1, 1, 0, 0),
        _termEntryContentMetaCollisionsByHashPair: new Map(),
        _termEntryContentMetaFreeIndexes: [],
        _readTermContentSignature1() { throw new Error('Product getter must not participate'); },
        _readTermEntryContentMetaDictNameId() { throw new Error('Product getter must not participate'); },
    };
    if (candidate) {
        database._termEntryContentMetaDictNameIdPrefixValue = 1;
        database._termEntryContentMetaDictNameIdPrefixEnd = 2;
    }
    return database;
}

function keys(database) {
    return Object.keys(database).filter((name) => name.startsWith('_termEntryContentMeta'));
}

test('both implicit columns decode to exact independent baseline bytes including the zero tail', () => {
    const parent = fixture(false);
    const candidate = fixture(true);
    assert.deepEqual(metadataDigest(candidate, 'B', keys(parent)), metadataDigest(parent, 'A', keys(parent)));
    assert.equal(candidate._termEntryContentMetaSignature1Table, null);
    assert.equal(candidate._termEntryContentMetaDictNameIdTable, null);
    assert.deepEqual(dictionaryNameAllocation(candidate), {
        physicalIsNull: true,
        backingBytes: 0,
        representation: {_termEntryContentMetaDictNameIdPrefixValue: 1, _termEntryContentMetaDictNameIdPrefixEnd: 2},
    });
});

test('a physical nonuniform dictionary-name column is hashed exactly while historical prefix scalars remain recorded', () => {
    const parent = fixture(false);
    const candidate = fixture(true);
    parent._termEntryContentMetaDictNameIdTable = Uint32Array.of(2, 1, 0, 3);
    candidate._termEntryContentMetaDictNameIdTable = Uint32Array.of(2, 1, 0, 3);
    assert.deepEqual(metadataDigest(candidate, 'B', keys(parent)), metadataDigest(parent, 'A', keys(parent)));
    const receipt = dictionaryNameAllocation(candidate);
    assert.equal(receipt.physicalIsNull, false);
    assert.equal(receipt.backingBytes, 16);
    assert.equal(receipt.representation._termEntryContentMetaDictNameIdPrefixEnd, 2);
});

test('native S1 backing is counted once and the external dictionary-name backing is included', () => {
    const parent = allocationReceipt(fixture(false));
    const candidate = allocationReceipt(fixture(true));
    assert.equal(parent.externalSignature1Bytes, 0);
    assert.equal(parent.ownedArenaAndSignature1Bytes, 32);
    assert.equal(parent.dictionaryNameIds.backingBytes, 16);
    assert.equal(parent.ownedArenaAndOptionalColumnsBytes, 48);
    assert.equal(candidate.ownedArenaAndOptionalColumnsBytes, 24);
    assert.equal(parent.ownedArenaAndOptionalColumnsBytes - candidate.ownedArenaAndOptionalColumnsBytes, 24);
});

test('an external materialized first-signature column is also counted exactly once', () => {
    const database = fixture(true);
    const signature1 = Uint32Array.of(0x3652424d, 0x3652424d, 0, 0);
    database._termContentMetadataArena.signature1 = signature1;
    database._termEntryContentMetaSignature1Table = signature1;
    const receipt = allocationReceipt(database);
    assert.equal(receipt.externalSignature1Bytes, 16);
    assert.equal(receipt.ownedArenaAndOptionalColumnsBytes, 40);
});

test('an unrecognized logical metadata property cannot disappear from the oracle', () => {
    const parent = fixture(false);
    const candidate = fixture(true);
    candidate._termEntryContentMetaUnexpected = 7;
    assert.throws(() => metadataDigest(candidate, 'B', keys(parent)), /Every metadata property must be accounted for/);
});

test('the explicit current profile independently expands implicit IDs in both parent and candidate', () => {
    const legacy = fixture(false);
    legacy._termEntryContentMetaIdTable = new Float64Array(4);
    const parent = fixture(false);
    parent._termEntryContentMetaIdTable = new Float64Array(0);
    const candidate = fixture(true);
    candidate._termEntryContentMetaIdTable = new Float64Array(0);
    const expected = metadataDigest(legacy, 'A', keys(legacy));
    const mode = 'implicit-positive-zero-or-full-float64';
    assert.deepEqual(metadataDigest(parent, 'A', keys(legacy), mode), expected);
    assert.deepEqual(metadataDigest(candidate, 'B', keys(legacy), mode), expected);
    assert.notDeepEqual(metadataDigest(parent, 'A', keys(legacy)), expected, 'The old profile must not silently accept a new representation');
    assert.equal(parent._termEntryContentMetaIdTable.length, 0);
    assert.equal(candidate._termEntryContentMetaIdTable.length, 0);
    assert.deepEqual(allocationReceipt(parent, mode).upstreamRecordIds, allocationReceipt(candidate, mode).upstreamRecordIds);
    assert.equal(allocationReceipt(candidate, mode).upstreamRecordIds.backingBytes, 0);
});

test('current ID normalization does not admit unrecognized metadata properties', () => {
    const legacy = fixture(false);
    legacy._termEntryContentMetaIdTable = new Float64Array(4);
    const current = fixture(true);
    current._termEntryContentMetaIdTable = new Float64Array(0);
    current._termEntryContentMetaUnexpectedIdMode = 1;
    assert.throws(() => metadataDigest(current, 'B', keys(legacy), 'implicit-positive-zero-or-full-float64'), /Every metadata property must be accounted for/);
});

test('unknown record-ID representation modes fail closed', () => {
    const parent = fixture(false);
    assert.throws(() => metadataDigest(parent, 'A', keys(parent), 'unknown'));
    assert.throws(() => allocationReceipt(parent, 'unknown'));
});

for (const [property, value] of [
    ['_termEntryContentMetaDictNameIdPrefixValue', -1],
    ['_termEntryContentMetaDictNameIdPrefixValue', 0.5],
    ['_termEntryContentMetaDictNameIdPrefixValue', 0x100000000],
    ['_termEntryContentMetaDictNameIdPrefixEnd', -1],
    ['_termEntryContentMetaDictNameIdPrefixEnd', 0.5],
    ['_termEntryContentMetaDictNameIdPrefixEnd', 5],
]) {
    test(`invalid representation property ${property}=${value} is rejected even after materialization`, () => {
        const database = fixture(true);
        database._termEntryContentMetaDictNameIdTable = new Uint32Array(4);
        database[property] = value;
        assert.throws(() => dictionaryNameAllocation(database), /Invalid dictionary-name prefix/);
    });
}
