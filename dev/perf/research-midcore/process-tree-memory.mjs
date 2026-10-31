import {readFile, readdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

const identityKey = ({pid, startTicks}) => `${pid}:${startTicks}`;

function validateIdentity(value) {
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.startTicks !== 'string' || !/^\d+$/.test(value.startTicks)) {
        throw new TypeError('Expected a positive PID and decimal startTicks string');
    }
    return {pid: value.pid, startTicks: BigInt(value.startTicks).toString()};
}

export function parseProcStat(text) {
    // comm may contain spaces, parentheses, and newlines. Numeric fields
    // follow its final closing parenthesis; splitting the whole line is unsafe.
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    const pidText = text.slice(0, open).trim();
    const fields = text.slice(close + 1).trim().split(/\s+/);
    if (open < 1 || close <= open || !/^\d+$/.test(pidText) || fields.length < 20 || !/^\d+$/.test(fields[1])) {
        throw new Error('Malformed /proc stat');
    }
    const identity = validateIdentity({pid: Number(pidText), startTicks: fields[19]});
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(ppid)) { throw new Error('Unsafe parent PID'); }
    return {...identity, ppid, state: fields[0]};
}

function kibField(text, name) {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, 'm').exec(text);
    if (match === null) { return null; }
    const bytes = Number(match[1]) * 1024;
    if (!Number.isSafeInteger(bytes)) { throw new Error(`Unsafe ${name} value`); }
    return bytes;
}

export async function readLinuxProcessIdentity(pid, {procRoot = '/proc'} = {}) {
    const record = parseProcStat(await readFile(`${procRoot}/${pid}/stat`, 'utf8'));
    if (record.pid !== pid) { throw new Error('PID does not match stat'); }
    return validateIdentity(record);
}

async function boundedMap(values, concurrency, callback) {
    const results = new Array(values.length);
    let cursor = 0;
    await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, async () => {
        while (cursor < values.length) {
            const index = cursor++;
            results[index] = await callback(values[index]);
        }
    }));
    return results;
}

export async function readLinuxProcessSnapshot({procRoot = '/proc', concurrency = 16, readDirectory = readdir, readText = readFile} = {}) {
    const pids = (await readDirectory(procRoot)).filter((name) => /^\d+$/.test(name)).map(Number);
    const records = await boundedMap(pids, concurrency, async (pid) => {
        try {
            const record = parseProcStat(await readText(`${procRoot}/${pid}/stat`, 'utf8'));
            if (record.pid !== pid) { throw new Error('PID does not match stat'); }
            return {record};
        } catch (error) {
            return {pid, error: error.code ?? error.message};
        }
    });
    const processes = records.flatMap((entry) => entry.record ? [entry.record] : []);
    const parentPids = new Set(processes.map((record) => record.ppid));
    // Child PPIDs contain no parent start time. Verify every observed parent
    // again after discovery: an old parent record followed by a replacement
    // parent's new child must not form a false ownership edge.
    const parentChecks = await boundedMap(processes.filter((record) => parentPids.has(record.pid)), concurrency, async (record) => {
        try {
            const after = parseProcStat(await readText(`${procRoot}/${record.pid}/stat`, 'utf8'));
            return identityKey(after) === identityKey(record) ? null : {pid: record.pid, error: 'identity-changed'};
        } catch (error) {
            return {pid: record.pid, error: error.code ?? error.message};
        }
    });
    const failedParents = parentChecks.filter((entry) => entry !== null);
    const unstablePids = new Set(failedParents.map((entry) => entry.pid));
    return {
        processes: processes.filter((record) => !unstablePids.has(record.pid)),
        unstablePids: [...unstablePids],
        // A permission/transient read failure is not proof of process death.
        unreadablePids: [...new Set([...records, ...failedParents].filter((entry) => entry.error && entry.error !== 'ENOENT' && entry.error !== 'ESRCH' && entry.error !== 'identity-changed').map((entry) => entry.pid))],
    };
}

export async function readLinuxProcessMemory(identity, {procRoot = '/proc', includePss = false, readText = readFile} = {}) {
    const expected = validateIdentity(identity);
    const statPath = `${procRoot}/${expected.pid}/stat`;
    try {
        const before = parseProcStat(await readText(statPath, 'utf8'));
        if (identityKey(before) !== identityKey(expected)) { return {rssBytes: null, pssBytes: null, error: 'identity-changed'}; }
        const status = await readText(`${procRoot}/${expected.pid}/status`, 'utf8');
        const rssBytes = kibField(status, 'VmRSS') ?? (before.state === 'Z' || before.state === 'X' ? 0 : null);
        let pssBytes = null;
        let pssError = null;
        if (includePss) {
            try {
                pssBytes = kibField(await readText(`${procRoot}/${expected.pid}/smaps_rollup`, 'utf8'), 'Pss');
                if (pssBytes === null) { pssError = 'missing-Pss'; }
            } catch (error) {
                pssError = error.code ?? error.message;
            }
        }
        const after = parseProcStat(await readText(statPath, 'utf8'));
        if (identityKey(after) !== identityKey(expected)) { return {rssBytes: null, pssBytes: null, error: 'identity-changed'}; }
        return {rssBytes, pssBytes, ...(rssBytes === null ? {error: 'missing-VmRSS'} : {}), ...(pssError === null ? {} : {pssError})};
    } catch (error) {
        return {rssBytes: null, pssBytes: null, error: error.code ?? error.message};
    }
}

export class ProcessTreeTracker {
    constructor(rootIdentity) {
        this.root = validateIdentity(rootIdentity);
        this.known = new Map([[identityKey(this.root), this.root]]);
        this.rootExited = false;
    }

    select({processes, unreadablePids = [], unstablePids = []}) {
        const byPid = new Map();
        for (const process of processes) {
            const record = {...process, ...validateIdentity(process)};
            if (!Number.isSafeInteger(record.ppid) || record.ppid < 0 || byPid.has(record.pid)) {
                throw new Error('Invalid or duplicate process snapshot PID');
            }
            byPid.set(record.pid, record);
        }
        const rootRecord = byPid.get(this.root.pid);
        const rootUnreadable = unreadablePids.includes(this.root.pid);
        if ((rootRecord && (identityKey(rootRecord) !== identityKey(this.root) || rootRecord.state === 'Z' || rootRecord.state === 'X')) || (!rootRecord && !rootUnreadable)) {
            this.rootExited = true;
        }
        const selected = new Map();
        for (const record of byPid.values()) {
            const key = identityKey(record);
            if (this.known.has(key) && !(key === identityKey(this.root) && this.rootExited)) {
                selected.set(key, record);
            }
        }
        // Previously observed descendants remain owned after root death or
        // reparenting. New children of those survivors can still be discovered.
        const children = new Map();
        for (const record of byPid.values()) {
            const entries = children.get(record.ppid) ?? [];
            entries.push(record);
            children.set(record.ppid, entries);
        }
        const queue = [...selected.values()];
        for (let index = 0; index < queue.length; ++index) {
            const parent = queue[index];
            for (const child of children.get(parent.pid) ?? []) {
                const key = identityKey(child);
                // A stale PPID cannot make an older process a child of a
                // replacement parent whose PID was recycled during discovery.
                if (selected.has(key) || BigInt(child.startTicks) < BigInt(parent.startTicks)) { continue; }
                selected.set(key, child);
                this.known.set(key, validateIdentity(child));
                queue.push(child);
            }
        }
        return {
            rootState: this.rootExited ? 'exited' : (rootRecord ? 'alive' : 'unreadable'),
            discoveryComplete: unreadablePids.length === 0 && unstablePids.length === 0,
            unreadableProcessCount: unreadablePids.length,
            unstableProcessCount: unstablePids.length,
            members: [...selected.values()].sort((a, b) => a.pid - b.pid),
        };
    }
}

export function summarizeSamples(samples, {root, includePss, intervalMs, elapsedMs, errors}) {
    const measured = samples.filter((sample) => !sample.error);
    const completeRss = measured.filter((sample) => sample.rssComplete);
    const completePss = measured.filter((sample) => sample.pssComplete);
    const members = measured.flatMap((sample) => sample.members);
    const peak = (values, field) => values.reduce((result, sample) => result === null ? sample[field] : Math.max(result, sample[field]), null);
    return {
        root,
        metric: 'sampled aggregate process-tree RSS; shared resident pages are counted once per process',
        intervalMs,
        elapsedMs,
        sampleCount: samples.length,
        completeRssSampleCount: completeRss.length,
        rssCoverage: {measuredProcessSamples: members.filter((member) => Number.isSafeInteger(member.rssBytes)).length, totalProcessSamples: members.length},
        peakSampledAggregateRssBytes: peak(completeRss, 'rssBytes'),
        peakObservedPartialOrCompleteRssBytes: peak(measured, 'rssBytes'),
        maxObservedProcessCount: peak(measured, 'processCount'),
        maxSampleDurationMs: peak(samples, 'durationMs'),
        incompleteDiscoverySampleCount: measured.filter((sample) => !sample.discoveryComplete).length,
        rootExitObserved: measured.some((sample) => sample.rootState === 'exited'),
        ...(includePss ? {
            pssMetric: 'sampled aggregate PSS from smaps_rollup; shared pages apportioned by the kernel at each process read',
            completePssSampleCount: completePss.length,
            pssCoverage: {measuredProcessSamples: members.filter((member) => Number.isSafeInteger(member.pssBytes)).length, totalProcessSamples: members.length},
            peakSampledAggregatePssBytes: peak(completePss, 'pssBytes'),
        } : {}),
        errors,
    };
}

export function createProcessTreeSampler({
    intervalMs = 100,
    includePss = false,
    concurrency = 8,
    readIdentity = readLinuxProcessIdentity,
    readSnapshot = readLinuxProcessSnapshot,
    readMemory = readLinuxProcessMemory,
    now = () => performance.now(),
} = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isInteger(concurrency) || concurrency <= 0) {
        throw new TypeError('Expected positive intervalMs and concurrency');
    }
    const samples = [];
    const errors = [];
    let state = 'idle';
    let tracker = null;
    let startedAt = null;
    let timer = null;
    let inFlight = null;
    let startPromise = null;
    let stopPromise = null;
    let stopping = false;

    const takeSample = () => {
        if (inFlight !== null) { return inFlight; }
        if (tracker === null || stopping) { return Promise.resolve(null); }
        inFlight = (async () => {
            const begin = now();
            let sample;
            try {
                const tree = tracker.select(await readSnapshot());
                const members = await boundedMap(tree.members, concurrency, async (member) => {
                    try {
                        return {...member, ...await readMemory(member, {includePss})};
                    } catch (error) {
                        return {...member, rssBytes: null, pssBytes: null, error: error.code ?? error.message};
                    }
                });
                sample = {
                    offsetMs: begin - startedAt,
                    rootState: tree.rootState,
                    discoveryComplete: tree.discoveryComplete,
                    unreadableProcessCount: tree.unreadableProcessCount,
                    unstableProcessCount: tree.unstableProcessCount,
                    processCount: members.length,
                    rssBytes: members.reduce((sum, member) => sum + (member.rssBytes ?? 0), 0),
                    rssComplete: tree.discoveryComplete && members.every((member) => Number.isSafeInteger(member.rssBytes) && member.rssBytes >= 0),
                    ...(includePss ? {
                        pssBytes: members.reduce((sum, member) => sum + (member.pssBytes ?? 0), 0),
                        pssComplete: tree.discoveryComplete && members.every((member) => Number.isSafeInteger(member.pssBytes) && member.pssBytes >= 0),
                    } : {}),
                    members,
                };
            } catch (error) {
                const message = error.code ?? error.message;
                errors.push(message);
                sample = {offsetMs: begin - startedAt, error: message};
            }
            sample.durationMs = now() - begin;
            samples.push(sample);
            return sample;
        })().finally(() => { inFlight = null; });
        return inFlight;
    };
    const schedule = () => {
        if (stopping) { return; }
        timer = setTimeout(() => {
            timer = null;
            void takeSample().then(schedule);
        }, intervalMs);
    };
    return {
        start(pid) {
            if (state !== 'idle') { throw new Error('Sampler can only be started once'); }
            if (!Number.isSafeInteger(pid) || pid <= 0) { throw new TypeError('Expected a positive PID'); }
            state = 'starting';
            startedAt = now();
            startPromise = (async () => {
                try {
                    tracker = new ProcessTreeTracker(await readIdentity(pid));
                    if (tracker.root.pid !== pid) { throw new Error('Root identity PID mismatch'); }
                    state = 'running';
                    if (!stopping) {
                        await takeSample();
                        schedule();
                    }
                    return tracker.root;
                } catch (error) {
                    errors.push(`start: ${error.code ?? error.message}`);
                    throw error;
                }
            })();
            return startPromise;
        },
        sampleNow: takeSample,
        stop() {
            if (stopPromise !== null) { return stopPromise; }
            stopping = true;
            if (timer !== null) { clearTimeout(timer); timer = null; }
            stopPromise = (async () => {
                if (startPromise !== null) { await startPromise.catch(() => {}); }
                if (inFlight !== null) { await inFlight; }
                state = 'stopped';
                return {
                    summary: summarizeSamples(samples, {
                        root: tracker?.root ?? null, includePss, intervalMs,
                        elapsedMs: startedAt === null ? 0 : now() - startedAt, errors: [...errors],
                    }),
                    samples: [...samples],
                };
            })();
            return stopPromise;
        },
    };
}
