/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {expect, test} from 'vitest';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

test('buffered content cursor uses the maintained queued byte count without rescanning queued chunks', () => {
    const store = new TermContentOpfsStore();
    const queuedChunks = new Proxy(
        [new Uint8Array(5), new Uint8Array(17)],
        {
            get(target, property, receiver) {
                if (property === Symbol.iterator) {
                    throw new Error('queued chunks must not be rescanned');
                }
                return Reflect.get(target, property, receiver);
            },
        },
    );
    Reflect.set(store, '_fileHandle', {});
    Reflect.set(store, '_segmentStates', [{
        index: 0,
        fileName: 'term-content.bin',
        fileHandle: {},
        fileLength: 11,
        startOffset: 0,
        readFile: null,
    }]);
    Reflect.set(store, '_pendingWriteBytes', 7);
    Reflect.set(store, '_inFlightWriteBytes', 13);
    Reflect.set(store, '_queuedWriteChunks', queuedChunks);
    Reflect.set(store, '_queuedWriteBytes', 22);

    const getBufferedLength = /** @type {() => number} */ (Reflect.get(store, '_getBufferedLength')).bind(store);
    expect(getBufferedLength()).toBe(53);
});
