import assert from 'node:assert/strict';
import {sha256} from './common.mjs';

export function valueDigest(value) {
    if (ArrayBuffer.isView(value)) {
        return {type: value.constructor.name,
            length: value.length,
            bytes: value.byteLength,
            sha256: sha256(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))};
    }
    if (value instanceof Map) { return {type: 'Map', size: value.size, entries: [...value].map(([key, item]) => [valueDigest(key), valueDigest(item)])}; }
    if (Array.isArray(value)) { return value.map(valueDigest); }
    if (value !== null && typeof value === 'object') {
        assert.equal(Object.getPrototypeOf(value), Object.prototype, 'Unknown metadata object would escape full hashing');
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, valueDigest(item)]));
    }
    assert(['number', 'string', 'boolean', 'undefined'].includes(typeof value) || value === null);
    if (typeof value === 'number' && !Number.isFinite(value)) { return {number: String(value)}; }
    return value;
}

export function metadataDigest(database, arm) {
    const names = Object.keys(database).filter((name) => name.startsWith('_termEntryContentMeta')).sort();
    for (const required of ['_termEntryContentMetaSignature1Table',
        '_termEntryContentMetaSignaturePresentTable',
        '_termEntryContentMetaSignature3Table',
        '_termEntryContentMetaCollisionsByHashPair',
        '_termEntryContentMetaFreeIndexes']) {
        assert(names.includes(required));
    }
    let signature1 = database._termEntryContentMetaSignature1Table;
    let present = database._termEntryContentMetaSignaturePresentTable;
    if (arm === 'B') {
        // Independent representation decoding: never invoke a product getter.
        present = new Uint8Array(present);
        signature1 = signature1 === null ? new Uint32Array(present.length) : new Uint32Array(signature1);
        for (let index = 0; index < present.length; ++index) {
            assert(present[index] <= 2, 'Unknown signature-presence marker');
            if (present[index] === 2) {
                signature1[index] = 0x3652424d;
                present[index] = 1;
            }
        }
    } else {
        assert(signature1 instanceof Uint32Array);
        for (const marker of present) { assert(marker <= 1); }
    }
    assert.equal(signature1.length, present.length);
    return Object.fromEntries(names.map((name) => [name, valueDigest(
        name === '_termEntryContentMetaSignature1Table' ?
signature1 :
            (name === '_termEntryContentMetaSignaturePresentTable' ? present : database[name]),
    )]));
}

export function allocationReceipt(database) {
    const arena = database._termContentMetadataArena;
    if (arena === null) {
        assert.equal(database._termEntryContentMetaStateTable.length, 0);
        return {arenaWasAllocated: false,
            denseCount: database._termEntryContentMetaDenseCount,
            capacity: 0,
            hashSlots: database._termEntryContentMetaHashPairTable.length,
            nativeArenaBytes: 0,
            physicalSignature1IsNull: database._termEntryContentMetaSignature1Table === null,
            externalSignature1Bytes: 0,
            ownedArenaAndSignature1Bytes: 0};
    }
    const firstWord = arena.signature1;
    const externalBytes = firstWord !== null && firstWord.buffer !== arena.memory.buffer ? firstWord.byteLength : 0;
    return {arenaWasAllocated: true,
        denseCount: database._termEntryContentMetaDenseCount,
        capacity: arena.state.length,
        hashSlots: arena.slots.length,
        nativeArenaBytes: arena.memory.buffer.byteLength,
        physicalSignature1IsNull: firstWord === null,
        externalSignature1Bytes: externalBytes,
        ownedArenaAndSignature1Bytes: arena.memory.buffer.byteLength + externalBytes};
}

export function parserOutputDigest(chunk) {
    const names = ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList', 'contentUniqueIndexList'];
    const columns = Object.fromEntries(names.map((name) => [name, valueDigest(chunk[name])]));
    const base = chunk.contentBytesBaseOffset ?? 0;
    const length = chunk.contentBytesLength;
    assert(chunk.contentBytesBuffer instanceof Uint8Array);
    assert(Number.isSafeInteger(base) && base >= 0);
    assert(Number.isSafeInteger(length) && length >= 0);
    assert(
        base <= chunk.contentBytesBuffer.byteLength && length <= chunk.contentBytesBuffer.byteLength - base,
        'Complete parser content span must fit without subarray clipping',
    );
    columns.contentBytes = valueDigest(chunk.contentBytesBuffer.subarray(base, base + length));
    columns.uniqueRowIndexes = valueDigest(chunk.contentDedupPlan.uniqueRowIndexes);
    columns.uniqueSignatures = valueDigest(chunk.contentDedupPlan.uniqueSignatures);
    const plan = chunk.termRecordPreinternedPlan;
    for (const name of ['stringsBuffer', 'stringLengths', 'expressionIndexes', 'readingIndexes']) { columns[`plan.${name}`] = valueDigest(plan[name]); }
    const lookup = [...chunk.preparedLookupIndexes].map(([key, item]) => ({key, bytes: valueDigest(item.bytes), routeFilter: valueDigest(item.routeFilter)}));
    return {rowCount: chunk.rowCount,
        contentRowStart: chunk.contentRowStart,
        contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex === true,
        uniqueCount: chunk.contentDedupPlan.uniqueCount,
        columns,
        lookup};
}
