import {expect, test} from 'vitest';
import {ContentStorageSnapshots} from '../ext/js/dictionary/term-content-storage-snapshots.js';
function root(epoch = 1, layoutId = 'a') {
    return {epoch, logicalHighWater: 20, regions: [{regionId: 'r0', layoutId, logicalStart: 0, logicalLength: 20}]};
}

test('cutover preserves the old root until every request and loader lease settles', async () => {
    const snapshots = new ContentStorageSnapshots(root());
    const request = snapshots.acquire();
    const loader = request.fork();
    const old = request.root;
    snapshots.publish(snapshots.current, root(2, 'b'));
    const next = snapshots.acquire();
    expect(request.root).toBe(old);
    expect(loader.root.regions[0].layoutId).toBe('a');
    expect(next.root.regions[0].layoutId).toBe('b');
    request.release();
    expect(snapshots.isLayoutPinned('a')).toBe(true);
    await Promise.resolve(); // A shared loader can outlive its initiating request.
    loader.release();
    expect(snapshots.isLayoutPinned('a')).toBe(false);
    expect(snapshots.isLayoutPinned('b')).toBe(true);
    next.release();
    expect(snapshots.isLayoutPinned('b')).toBe(true); // Current durable root is always rooted.
});

test('release is idempotent and cannot resurrect a retired snapshot', () => {
    const snapshots = new ContentStorageSnapshots(root());
    const first = snapshots.acquire(),
        sibling = first.fork();
    snapshots.publish(snapshots.current, root(2, 'b'));
    first.release(); first.release();
    expect(snapshots.isLayoutPinned('a')).toBe(true);
    expect(() => first.fork()).toThrow(/released/);
    sibling.release(); sibling.release();
    expect(snapshots.isLayoutPinned('a')).toBe(false);
});

test('publishing a different region preserves shared layout ownership across leased roots', () => {
    const snapshots = new ContentStorageSnapshots({epoch: 1,
        logicalHighWater: 40,
        regions: [
            {regionId: 'r0', layoutId: 'a', logicalStart: 0, logicalLength: 20},
            {regionId: 'r1', layoutId: 'b', logicalStart: 20, logicalLength: 20},
        ]});
    const read = snapshots.acquire();
    snapshots.publish(snapshots.current, {epoch: 2,
        logicalHighWater: 40,
        regions: [
            {regionId: 'r0', layoutId: 'c', logicalStart: 0, logicalLength: 20},
            {regionId: 'r1', layoutId: 'b', logicalStart: 20, logicalLength: 20},
        ]});
    read.release();
    expect(snapshots.isLayoutPinned('a')).toBe(false);
    expect(snapshots.isLayoutPinned('b')).toBe(true);
    expect(snapshots.isLayoutPinned('c')).toBe(true);
});

test('stale publication and failed validation cannot replace the current root', () => {
    const snapshots = new ContentStorageSnapshots(root());
    const first = snapshots.current;
    snapshots.publish(first, root(2, 'b'));
    const current = snapshots.current;
    expect(() => snapshots.publish(first, root(3, 'c'))).toThrow(/Stale/);
    expect(() => snapshots.publish(current, root(2, 'c'))).toThrow(/advance/);
    expect(() => snapshots.publish(current, {epoch: 3, logicalHighWater: 0, regions: []})).toThrow(/shrink/);
    expect(snapshots.current).toBe(current);
});

test('owns root metadata so caller mutations cannot redirect an active read', () => {
    const input = root();
    const snapshots = new ContentStorageSnapshots(input);
    const read = snapshots.acquire();
    input.regions[0].layoutId = 'evil';
    input.logicalHighWater = 0;
    input.regions.length = 0;
    expect(read.root.logicalHighWater).toBe(20);
    expect(read.root.regions[0].layoutId).toBe('a');
    expect(Object.isFrozen(read.root)).toBe(true);
    expect(Object.isFrozen(read.root.regions)).toBe(true);
    expect(Object.isFrozen(read.root.regions[0])).toBe(true);
    expect(() => { Object.defineProperty(read.root.regions[0], 'layoutId', {value: 'evil'}); }).toThrow();
    read.release();
});

for (const invalid of [
    {epoch: -1, logicalHighWater: 0, regions: []},
    {epoch: 1, logicalHighWater: 1, regions: []},
    {epoch: 1, logicalHighWater: 20, regions: [{regionId: 'r', layoutId: 'a', logicalStart: 1, logicalLength: 20}]},
    {epoch: 1, logicalHighWater: 0, regions: [{regionId: 'r', layoutId: 'a', logicalStart: 0, logicalLength: 0}]},
    {epoch: 1, logicalHighWater: 134217729, regions: [{regionId: 'r', layoutId: 'a', logicalStart: 0, logicalLength: 134217729}]},
    {epoch: 1, logicalHighWater: 2, regions: [{regionId: 'r', layoutId: 'a', logicalStart: 0, logicalLength: 1}, {regionId: 'r2', layoutId: 'a', logicalStart: 1, logicalLength: 1}]},
]) {
    test('invalid root cannot enter snapshot ownership: ' + JSON.stringify(invalid), () => {
        expect(() => new ContentStorageSnapshots(invalid)).toThrow(TypeError);
    });
}
