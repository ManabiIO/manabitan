import assert from 'node:assert/strict';

// Independent decoding of the representation merged in f28c2801. These helpers
// never invoke a product getter or materializer and never change source views.
function recordIdView(database) {
    const state = database._termEntryContentMetaStateTable;
    const table = database._termEntryContentMetaIdTable;
    assert(state instanceof Uint8Array, 'Record-ID capacity requires the state column');
    assert(table instanceof Float64Array, 'Record IDs require a Float64Array, including the empty sentinel');
    assert(table.length === 0 || table.length === state.length, 'Physical record IDs must cover the complete capacity');
    return {table, capacity: state.length};
}

export function recordIdAllocation(database) {
    const {table, capacity} = recordIdView(database);
    return {capacity,
        physicalLength: table.length,
        byteOffset: table.byteOffset,
        viewBytes: table.byteLength,
        backingBytes: table.buffer.byteLength,
        backingKind: table.buffer.constructor.name,
        implicitAllPositiveZero: table.length === 0};
}

export function logicalRecordIds(database) {
    const {table, capacity} = recordIdView(database);
    // A newly allocated Float64Array has positive zero in every slot, including
    // free entries and the unused capacity tail. A physical view is returned
    // unchanged so signed zero and every original byte remain observable.
    return table.length === 0 ? new Float64Array(capacity) : table;
}
