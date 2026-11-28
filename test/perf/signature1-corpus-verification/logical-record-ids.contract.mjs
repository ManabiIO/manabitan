import assert from 'node:assert/strict';
import {test} from 'node:test';
import {logicalRecordIds, recordIdAllocation} from './logical-record-ids.mjs';

function fixture(table, capacity = 4) {
    return {
        _termEntryContentMetaStateTable: Uint8Array.from({length: capacity}, (_, index) => (index < 2 ? 1 : 0)),
        _termEntryContentMetaIdTable: table,
        _readTermEntryContentMetaHashPairIndex() { throw new Error('Product getter must not participate'); },
    };
}

test('empty current ID storage expands to positive zero across live, free and unused capacity', () => {
    const database = fixture(new Float64Array(0));
    const before = database._termEntryContentMetaIdTable;
    const logical = logicalRecordIds(database);
    assert.equal(logical.length, 4);
    for (const value of logical) { assert(Object.is(value, 0)); }
    assert.deepEqual(new Uint8Array(logical.buffer), new Uint8Array(32));
    assert.equal(database._termEntryContentMetaIdTable, before);
    assert.deepEqual(recordIdAllocation(database), {
        capacity: 4,
        physicalLength: 0,
        byteOffset: 0,
        viewBytes: 0,
        backingBytes: 0,
        backingKind: 'ArrayBuffer',
        implicitAllPositiveZero: true,
    });
});

test('a physical full-capacity ID view preserves signed zero and exact source bytes', () => {
    const storage = new Float64Array([99, 0, -0, 42, Number.MAX_SAFE_INTEGER, 88]);
    const table = storage.subarray(1, 5);
    const database = fixture(table);
    const before = new Uint8Array(new Uint8Array(storage.buffer));
    assert.equal(logicalRecordIds(database), table);
    assert(Object.is(logicalRecordIds(database)[1], -0));
    assert.deepEqual(new Uint8Array(storage.buffer), before);
    assert.deepEqual(recordIdAllocation(database), {
        capacity: 4,
        physicalLength: 4,
        byteOffset: 8,
        viewBytes: 32,
        backingBytes: 48,
        backingKind: 'ArrayBuffer',
        implicitAllPositiveZero: false,
    });
});

test('an empty view over an owned backing retains its source allocation in the receipt', () => {
    const storage = new Float64Array([7, 8]);
    const database = fixture(storage.subarray(1, 1));
    assert.deepEqual([...logicalRecordIds(database)], [0, 0, 0, 0]);
    assert.equal(recordIdAllocation(database).backingBytes, 16);
    assert.equal(recordIdAllocation(database).byteOffset, 8);
    assert.deepEqual([...storage], [7, 8]);
});

test('zero capacity remains a zero-length positive-zero column', () => {
    const database = fixture(new Float64Array(0), 0);
    assert.equal(logicalRecordIds(database).byteLength, 0);
    assert.equal(recordIdAllocation(database).capacity, 0);
});

for (const table of [null, new Uint32Array(4), new Float64Array(3), new Float64Array(5)]) {
    test(`invalid ID representation ${table?.constructor.name ?? 'null'} length ${table?.length ?? 'null'} is rejected`, () => {
        assert.throws(() => logicalRecordIds(fixture(table)), /Record IDs require|Physical record IDs must cover/);
    });
}
