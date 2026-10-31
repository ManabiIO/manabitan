import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {ProcessTreeTracker, createProcessTreeSampler, parseProcStat, readLinuxProcessMemory, readLinuxProcessSnapshot} from './process-tree-memory.mjs';

const processRecord = (pid, ppid, startTicks, state = 'S') => ({pid, ppid, startTicks: String(startTicks), state});
const snapshot = (...processes) => ({processes});
const ids = (selection) => selection.members.map(({pid, startTicks}) => `${pid}:${startTicks}`);
const gate = () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return {promise, release};
};

function stat(pid, ppid, startTicks, state = 'S') {
    const fields = new Array(22).fill('0');
    fields[0] = state;
    fields[1] = String(ppid);
    fields[19] = String(startTicks);
    return `${pid} (chrome (renderer)\nname with ) parentheses) ${fields.join(' ')}\n`;
}

test('stat parsing handles command parentheses/newlines and exact wide start ticks', () => {
    assert.deepEqual(parseProcStat(stat(42, 7, '18446744073709551614')), processRecord(42, 7, '18446744073709551614'));
    for (const bad of ['', '12 (broken) S 1', 'wrong (x) S 1']) {
        assert.throws(() => parseProcStat(bad));
    }
});

test('tree selection includes root, descendants and siblings, never unrelated processes', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    const result = tracker.select(snapshot(
        processRecord(13, 11, 103), processRecord(12, 10, 102),
        processRecord(30, 1, 10), processRecord(10, 1, 100), processRecord(11, 10, 101),
    ));
    assert.deepEqual(ids(result), ['10:100', '11:101', '12:102', '13:103']);
    assert.equal(result.rootState, 'alive');
});

test('observed descendants survive reparenting and discover their later children', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 10, 101)));
    const result = tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 1, 101), processRecord(12, 11, 102)));
    assert.deepEqual(ids(result), ['10:100', '11:101', '12:102']);
});

test('root death/reuse never attaches replacement root or its unrelated children', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 10, 101)));
    const result = tracker.select(snapshot(
        processRecord(10, 1, 500), processRecord(20, 10, 501),
        processRecord(11, 1, 101), processRecord(12, 11, 502),
    ));
    assert.equal(result.rootState, 'exited');
    assert.deepEqual(ids(result), ['11:101', '12:502']);
    assert.deepEqual(ids(tracker.select(snapshot(processRecord(10, 1, 100)))), []);
});

test('descendant PID reuse is excluded unless the new process is independently a child', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 10, 101)));
    assert.deepEqual(ids(tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 1, 200)))), ['10:100']);
    assert.deepEqual(ids(tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 10, 300)))), ['10:100', '11:300']);
});

test('torn snapshot PPID cannot attach a process older than its replacement parent', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    assert.deepEqual(ids(tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 10, 99)))), ['10:100']);
});

test('discovery rereads parents and removes old-parent/new-child PID-reuse edges', async () => {
    let parentReads = 0;
    const discovered = await readLinuxProcessSnapshot({
        readDirectory: async () => ['10', '20', 'not-a-pid'],
        readText: async (path) => path.includes('/10/') ? stat(10, 1, ++parentReads === 1 ? 100 : 500) : stat(20, 10, 501),
    });
    assert.deepEqual(discovered.unstablePids, [10]);
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    const result = tracker.select(discovered);
    assert.equal(result.rootState, 'exited');
    assert.equal(result.discoveryComplete, false);
    assert.deepEqual(ids(result), []);
});

test('parent permission races remove unverified edges without claiming root death', async () => {
    let parentReads = 0;
    const discovered = await readLinuxProcessSnapshot({
        readDirectory: async () => ['10', '20'],
        readText: async (path) => {
            if (path.includes('/10/')) {
                if (++parentReads > 1) { throw Object.assign(new Error('denied'), {code: 'EACCES'}); }
                return stat(10, 1, 100);
            }
            return stat(20, 10, 101);
        },
    });
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    const result = tracker.select(discovered);
    assert.equal(result.rootState, 'unreadable');
    assert.deepEqual(ids(result), []);
});

test('unreadable root is not declared dead; incomplete discovery stays explicit', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    const unreadable = tracker.select({processes: [], unreadablePids: [10]});
    assert.equal(unreadable.rootState, 'unreadable');
    assert.equal(unreadable.discoveryComplete, false);
    assert.equal(tracker.select(snapshot(processRecord(10, 1, 100))).rootState, 'alive');
});

test('zombie root is terminal while previously observed children remain owned', () => {
    const tracker = new ProcessTreeTracker({pid: 10, startTicks: '100'});
    tracker.select(snapshot(processRecord(10, 1, 100), processRecord(11, 10, 101)));
    const result = tracker.select(snapshot(processRecord(10, 1, 100, 'Z'), processRecord(11, 1, 101)));
    assert.equal(result.rootState, 'exited');
    assert.deepEqual(ids(result), ['11:101']);
});

test('identity is checked again after RSS/PSS reads to reject PID-reuse races', async () => {
    let statReads = 0;
    const result = await readLinuxProcessMemory({pid: 10, startTicks: '100'}, {
        includePss: true,
        readText: async (path) => {
            if (path.endsWith('/stat')) { return stat(10, 1, ++statReads === 1 ? 100 : 200); }
            return path.endsWith('/status') ? 'VmRSS:\t512 kB\n' : 'Pss: 123 kB\n';
        },
    });
    assert.equal(result.error, 'identity-changed');
    assert.equal(result.rssBytes, null);
    assert.equal(result.pssBytes, null);
});

test('RSS and PSS parse separately; Pss_Anon is never substituted for Pss', async () => {
    const result = await readLinuxProcessMemory({pid: 10, startTicks: '100'}, {
        includePss: true,
        readText: async (path) => path.endsWith('/stat') ? stat(10, 1, 100) :
            (path.endsWith('/status') ? 'VmRSS: 512 kB\n' : 'Pss_Anon: 900 kB\nPss: 123 kB\n'),
    });
    assert.equal(result.rssBytes, 512 * 1024);
    assert.equal(result.pssBytes, 123 * 1024);
});

test('optional PSS denial preserves RSS and exposes the missing coverage', async () => {
    const result = await readLinuxProcessMemory({pid: 10, startTicks: '100'}, {
        includePss: true,
        readText: async (path) => {
            if (path.endsWith('/stat')) { return stat(10, 1, 100); }
            if (path.endsWith('/status')) { return 'VmRSS: 512 kB\n'; }
            throw Object.assign(new Error('denied'), {code: 'EACCES'});
        },
    });
    assert.equal(result.rssBytes, 512 * 1024);
    assert.equal(result.pssBytes, null);
    assert.equal(result.pssError, 'EACCES');
});

test('sampler retains raw members and reports complete RSS versus partial PSS coverage', async () => {
    const sampler = createProcessTreeSampler({
        intervalMs: 60_000, includePss: true,
        readIdentity: async () => ({pid: 10, startTicks: '100'}),
        readSnapshot: async () => snapshot(processRecord(10, 1, 100), processRecord(11, 10, 101), processRecord(30, 1, 1)),
        readMemory: async ({pid}, {includePss}) => {
            assert.equal(includePss, true);
            return {rssBytes: pid === 10 ? 100 : 200, pssBytes: pid === 10 ? 50 : null};
        },
    });
    await sampler.start(10);
    const {samples, summary} = await sampler.stop();
    assert.equal(samples.length, 1);
    assert.equal(samples[0].rssBytes, 300);
    assert.equal(samples[0].pssBytes, 50);
    assert.equal(summary.peakSampledAggregateRssBytes, 300);
    assert.equal(summary.peakSampledAggregatePssBytes, null);
    assert.deepEqual(summary.pssCoverage, {measuredProcessSamples: 1, totalProcessSamples: 2});
    assert.match(summary.metric, /shared resident pages/);
});

test('unreadable discovery and missing RSS never become a complete aggregate', async () => {
    const sampler = createProcessTreeSampler({
        intervalMs: 60_000,
        readIdentity: async () => ({pid: 10, startTicks: '100'}),
        readSnapshot: async () => ({processes: [processRecord(10, 1, 100)], unreadablePids: [11]}),
        readMemory: async () => ({rssBytes: null, error: 'ENOENT'}),
    });
    await sampler.start(10);
    const {summary} = await sampler.stop();
    assert.equal(summary.completeRssSampleCount, 0);
    assert.equal(summary.peakSampledAggregateRssBytes, null);
    assert.equal(summary.incompleteDiscoverySampleCount, 1);
});

test('stop drains an in-flight sample, stays idempotent, and prevents later reads', async () => {
    const blocked = gate();
    let reads = 0;
    const sampler = createProcessTreeSampler({
        intervalMs: 60_000,
        readIdentity: async () => ({pid: 10, startTicks: '100'}),
        readSnapshot: async () => snapshot(processRecord(10, 1, 100)),
        readMemory: async () => { if (++reads === 2) { await blocked.promise; } return {rssBytes: reads, pssBytes: null}; },
    });
    await sampler.start(10);
    const pending = sampler.sampleNow();
    assert.equal(sampler.sampleNow(), pending);
    await nextTurn();
    let stopped = false;
    const stop = sampler.stop();
    assert.equal(sampler.stop(), stop);
    void stop.then(() => { stopped = true; });
    await nextTurn();
    assert.equal(stopped, false);
    blocked.release();
    const result = await stop;
    assert.equal(result.samples.length, 2);
    assert.equal(await sampler.sampleNow(), null);
    assert.equal(reads, 2);
});

test('stop during root identity acquisition joins startup and does not start a sample', async () => {
    const blocked = gate();
    let snapshots = 0;
    const sampler = createProcessTreeSampler({
        readIdentity: async () => { await blocked.promise; return {pid: 10, startTicks: '100'}; },
        readSnapshot: async () => { ++snapshots; return snapshot(); },
    });
    const start = sampler.start(10);
    const stop = sampler.stop();
    blocked.release();
    await start;
    assert.equal((await stop).samples.length, 0);
    assert.equal(snapshots, 0);
});

test('sample failures are recorded and startup failures remain safely stoppable', async () => {
    const sampler = createProcessTreeSampler({
        intervalMs: 60_000,
        readIdentity: async () => ({pid: 10, startTicks: '100'}),
        readSnapshot: async () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); },
    });
    await sampler.start(10);
    const result = await sampler.stop();
    assert.equal(result.samples[0].error, 'EACCES');
    assert.equal(result.summary.peakSampledAggregateRssBytes, null);
    const absent = createProcessTreeSampler({readIdentity: async () => { throw new Error('root absent'); }});
    await assert.rejects(absent.start(10), /root absent/);
    assert.match((await absent.stop()).summary.errors[0], /root absent/);
});
