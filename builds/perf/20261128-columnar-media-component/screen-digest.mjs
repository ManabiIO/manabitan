import {createHash} from 'node:crypto';

// This is a parity encoding, not a size estimate for structured clone.
// JSON quoting preserves literal lone surrogates in diagnostic strings.
export function appendValue(hash, value) {
    if (value === null) { hash.update('null;'); return; }
    if (typeof value !== 'object') {
        if (typeof value === 'function') { throw new Error('Unexpected function in parity payload'); }
        hash.update(`${typeof value}:${JSON.stringify(value) ?? 'undefined'};`);
        return;
    }
    if (ArrayBuffer.isView(value)) {
        hash.update(`view:${value.constructor.name}:${value.byteLength}:`);
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        return;
    }
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        hash.update(`buffer:${value.byteLength}:`);
        hash.update(new Uint8Array(value));
        return;
    }
    if (Array.isArray(value)) {
        hash.update(`array:${value.length}:`);
        for (const child of value) { appendValue(hash, child); }
        return;
    }
    if (value instanceof Map) {
        hash.update(`map:${value.size}:`);
        for (const [key, child] of value) { appendValue(hash, key); appendValue(hash, child); }
        return;
    }
    const keys = Object.keys(value).sort();
    hash.update(`object:${keys.length}:`);
    for (const key of keys) { appendValue(hash, key); appendValue(hash, value[key]); }
}

export function digestValue(value) {
    const hash = createHash('sha256');
    appendValue(hash, value);
    return hash.digest('hex');
}

export function columnFields(chunk, omitBorrowedContent = false) {
    const fields = {};
    for (const [key, value] of Object.entries(chunk)) {
        if (key === 'preparedLookupIndexEncodeMs' || key === 'releaseBorrowedContent') { continue; }
        if (omitBorrowedContent && key === 'contentBytesBuffer') { continue; }
        fields[key] = value;
    }
    return fields;
}
