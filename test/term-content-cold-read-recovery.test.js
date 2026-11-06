import {afterEach, expect, test, vi} from 'vitest';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';

const filename = 'manabitan-term-content.bin';

async function fixture() {
    const unreadable = new Error('Cold content is temporarily unreadable');
    unreadable.name = 'NotReadableError';
    const stop = new Error('Test safety stop: cold read exceeded its recovery budget');
    const file = new File(['term'], filename);
    let unavailable = false;
    let failedReads = 0;
    const getFile = vi.fn(async () => {
        if (unavailable) {
            // Make the old infinite loop fail deterministically without leaving
            // background promises or timers running after the assertion.
            if (++failedReads > 6) { throw stop; }
            throw unreadable;
        }
        return file;
    });
    const handle = {kind: 'file', name: filename, getFile};
    const root = {
        async getFileHandle() { return handle; },
        async *entries() { yield [filename, handle]; },
    };
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => root}});
    const store = new TermContentOpfsStore();
    await store.prepare();
    getFile.mockClear();
    return {store, getFile, unreadable, setUnavailable: (/** @type {boolean} */ value) => { unavailable = value; }};
}

afterEach(() => { vi.unstubAllGlobals(); });

test('a persistent cold getFile failure terminates within the bounded recovery attempts', async () => {
    const {store, getFile, unreadable, setUnavailable} = await fixture();
    setUnavailable(true);
    await expect(store.readSlice(0, 4)).rejects.toBe(unreadable);
    expect(getFile).toHaveBeenCalledTimes(3);
});

test('cold failure releases mutation admission and permits recovery in the same live store', async () => {
    const {store, getFile, unreadable, setUnavailable} = await fixture();
    setUnavailable(true);
    const results = await Promise.allSettled([store.readSlice(0, 4), store.createImportCheckpoint()]);
    expect(results).toEqual([
        {status: 'rejected', reason: unreadable},
        {status: 'rejected', reason: unreadable},
    ]);
    expect(getFile).toHaveBeenCalledTimes(4);
    setUnavailable(false);
    await expect(store.prepare()).resolves.toBeUndefined();
    await expect(store.readSlice(0, 4)).resolves.toEqual(new TextEncoder().encode('term'));
    await expect(store.createImportCheckpoint()).resolves.toEqual({segments: [{fileName: filename, fileLength: 4}]});
});

test.each([1, 2])('cold snapshot recovery succeeds after %i transient failures', async (failures) => {
    const {store, getFile, unreadable} = await fixture();
    for (let i = 0; i < failures; ++i) { getFile.mockRejectedValueOnce(unreadable); }
    await expect(store.readSlice(0, 4)).resolves.toEqual(new TextEncoder().encode('term'));
    expect(getFile.mock.calls.length).toBeLessThanOrEqual(4);
});

test('a cold outage is temporarily unavailable and a later lookup retries without reopening', async () => {
    const {store, getFile, setUnavailable} = await fixture();
    const blocks = new TermContentBlockStore(store);
    setUnavailable(true);
    await expect(blocks.readDetailed(0, 4, 'plain')).resolves.toMatchObject({status: 'temporarilyUnavailable'});
    expect(getFile).toHaveBeenCalledTimes(3);
    setUnavailable(false);
    await expect(blocks.readDetailed(0, 4, 'plain')).resolves.toEqual({status: 'ok', bytes: new TextEncoder().encode('term')});
});

test('a cold outage settles every batch entry and the next batch can recover', async () => {
    const {store, getFile, setUnavailable} = await fixture();
    const blocks = new TermContentBlockStore(store);
    const requests = [0, 2].map((contentOffset) => ({contentOffset, contentLength: 2, contentDictName: 'plain'}));
    setUnavailable(true);
    await expect(blocks.readDetailedBatch(requests)).resolves.toMatchObject([
        {status: 'temporarilyUnavailable'},
        {status: 'temporarilyUnavailable'},
    ]);
    expect(getFile).toHaveBeenCalledTimes(6);
    setUnavailable(false);
    await expect(blocks.readDetailedBatch(requests)).resolves.toEqual([
        {status: 'ok', bytes: new TextEncoder().encode('te')},
        {status: 'ok', bytes: new TextEncoder().encode('rm')},
    ]);
});
