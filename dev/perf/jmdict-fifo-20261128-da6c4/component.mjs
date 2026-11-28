// Scheduling component only. Production pool, worker and codec are imported unchanged.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, rename, mkdir, open, statfs} from 'node:fs/promises';
import {Worker as NodeWorker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ns = () => process.hrtime.bigint().toString();
const ms = (end, start) => Number(BigInt(end) - BigInt(start)) / 1e6;
const bytesOf = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

class LogicalWorker {
    constructor(dispatcher, index) {
        this.dispatcher = dispatcher;
        this.index = index;
        this.listeners = new Map();
    }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) { this.listeners.set(type, new Set()); }
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    postMessage(message, transfer) { this.dispatcher.submit(this.index, message, transfer); }
    dispatch(type, event) {
        for (const listener of this.listeners.get(type) ?? []) { listener(event); }
    }
    terminate() { /* The component owns and awaits every physical worker. */ }
}

class Dispatcher {
    constructor(config, getActiveGroup) {
        this.getActiveGroup = getActiveGroup;
        this.logical = Array.from({length: 4}, (_, index) => new LogicalWorker(this, index));
        this.physical = [];
        this.failure = null;
        this.closing = false;
        this.mode = 'A-rotation';
        this.jobs = [];
        this.pending = new Map();
        this.queue = [];
        this.queueEvents = [];
        this.maxQueueDepth = 0;
        this.holdFinalReplies = false;
        this.heldReplies = [];
        this.config = config;
    }
    async start() {
        const config = this.config;
        for (let index = 0; index < 4; ++index) {
            const ready = Promise.withResolvers();
            void ready.promise.catch(() => {});
            const worker = new NodeWorker(pathToFileURL(config.bridgePath), {
                workerData: {
                    entry: pathToFileURL(path.join(config.root, 'ext/js/dictionary/zstd-term-content-compression-worker.js')).href,
                },
                execArgv: [],
            });
            const physical = {worker, index, ready, posted: 0, maximumPosted: 0};
            this.physical.push(physical);
            worker.on('message', (data) => {
                try { this.onMessage(physical, data); } catch (error) { this.fail(error); }
            });
            worker.on('error', (error) => { this.fail(error); });
            worker.on('exit', (code) => {
                if (!this.closing) { this.fail(new Error('Compression worker exited unexpectedly: ' + code)); }
            });
        }
        await Promise.all(this.physical.map(({ready}) => ready.promise));
    }
    fail(error) {
        if (this.failure !== null) { return; }
        this.failure = error;
        for (const physical of this.physical) { physical.ready.reject(error); }
        for (const logical of this.logical) { logical.dispatch('error', {message: String(error), error}); }
    }
    onMessage(physical, data) {
        if (this.closing || this.failure !== null) { return; }
        if (data.type === 'ready') { physical.ready.resolve(); return; }
        if (data.type === 'initialization-error') { throw new Error(data.error); }
        const pending = this.pending.get(data.id);
        assert(pending, 'Unexpected reply ' + data.id);
        const {job, logicalIndex} = pending;
        assert.equal(job.physicalWorker, physical.index);
        if (data.type === 'source-consumed') {
            assert.equal(job.sourceConsumedReceivedNs, undefined);
            job.sourceConsumedReceivedNs = ns();
            this.logical[logicalIndex].dispatch('message', {data});
            return;
        }
        assert(data.__componentMetrics, 'Missing worker service timestamps');
        Object.assign(job, data.__componentMetrics, {
            receivedNs: ns(),
            outputBytes: data.compressed?.byteLength ?? 0,
        });
        if (data.error) { job.error = data.error; }
        --physical.posted;
        assert(physical.posted >= 0);
        this.pending.delete(data.id);
        this.queueEvents.push({
            event: 'complete', id: data.id, group: job.group, physicalWorker: physical.index,
            atNs: job.receivedNs, queueDepth: this.queue.length,
        });
        if (this.holdFinalReplies) {
            this.heldReplies.push({logicalIndex, data});
        } else {
            this.logical[logicalIndex].dispatch('message', {data});
        }
        if (this.mode === 'B-first-free-fifo') { this.drain(); }
    }
    submit(logicalIndex, message, transfer = []) {
        if (this.failure !== null) { throw this.failure; }
        assert.equal(transfer.length, 0, 'Only immutable shared-span messages belong to this screen');
        assert(message.source instanceof Uint8Array && message.source.buffer instanceof SharedArrayBuffer);
        assert(message.sourceOffsets.buffer instanceof SharedArrayBuffer);
        assert(message.sourceLengths.buffer instanceof SharedArrayBuffer);
        assert(!this.pending.has(message.id));
        const job = {
            id: message.id, logicalWorker: logicalIndex, group: this.getActiveGroup(),
            enqueuedNs: ns(), inputBytes: message.contentBytes, spans: message.sourceOffsets.length,
        };
        const pending = {logicalIndex, message, transfer, job};
        this.jobs.push(job);
        this.pending.set(message.id, pending);
        if (this.mode === 'B-first-free-fifo') {
            this.queue.push(pending);
            this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length);
            this.queueEvents.push({
                event: 'enqueue', id: job.id, group: job.group,
                atNs: job.enqueuedNs, queueDepth: this.queue.length,
            });
            this.drain();
        } else {
            this.post(this.physical[logicalIndex], pending);
        }
    }
    post(physical, pending) {
        const {job, message, transfer} = pending;
        job.physicalWorker = physical.index;
        job.dispatchedNs = ns();
        ++physical.posted;
        physical.maximumPosted = Math.max(physical.maximumPosted, physical.posted);
        this.queueEvents.push({
            event: 'dispatch', id: job.id, group: job.group, physicalWorker: physical.index,
            atNs: job.dispatchedNs, queueDepth: this.queue.length, physicalPending: physical.posted,
        });
        try {
            physical.worker.postMessage(message, transfer);
        } catch (error) {
            this.fail(error);
            throw error;
        }
    }
    drain() {
        if (this.failure !== null) { return; }
        for (const physical of this.physical) {
            if (this.queue.length === 0) { break; }
            if (physical.posted === 0) { this.post(physical, this.queue.shift()); }
        }
    }
    releaseHeldReplies() {
        this.holdFinalReplies = false;
        const replies = this.heldReplies;
        this.heldReplies = [];
        for (const {logicalIndex, data} of replies) {
            this.logical[logicalIndex].dispatch('message', {data});
        }
    }
    reset(mode) {
        assert.equal(this.failure, null);
        assert.equal(this.pending.size, 0);
        assert.equal(this.queue.length, 0);
        assert.equal(this.heldReplies.length, 0);
        assert(!this.holdFinalReplies);
        assert(this.physical.every((value) => value.posted === 0));
        this.mode = mode;
        this.jobs = [];
        this.queueEvents = [];
        this.maxQueueDepth = 0;
        for (const physical of this.physical) { physical.maximumPosted = 0; }
    }
    snapshot() {
        return {
            jobs: this.jobs, queueEvents: this.queueEvents, maxQueueDepth: this.maxQueueDepth,
            maxPostedByPhysicalWorker: this.physical.map((value) => value.maximumPosted),
            pending: this.pending.size, queued: this.queue.length, heldReplies: this.heldReplies.length,
        };
    }
    async close() {
        this.closing = true;
        const results = await Promise.allSettled(this.physical.map(({worker}) => worker.terminate()));
        for (const result of results) {
            if (result.status === 'rejected') { throw result.reason; }
        }
    }
}

async function main() {
    assert.equal(process.argv.length, 3);
    const configBytes = await readFile(process.argv[2]);
    const config = JSON.parse(configBytes);
    const {plan} = config;
    const report = {
        schemaVersion: 1, complete: false, plan, planSha256: config.planSha256,
        configSha256: sha(configBytes), scriptSha256: config.scriptSha256,
        node: process.version,
        host: {
            cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
            parallelism: os.availableParallelism(), totalMemory: os.totalmem(), loadavg: os.loadavg(),
        },
        scope: plan.scope,
        runtimeSourceHashes: config.runtimeSourceHashes,
        sourceCaptureCommit: plan.captureCommit,
        startupMemory: [], warmups: [], observations: [], sourceOwnershipChecks: [],
        exhaustiveDecodeVerification: [], failures: [], inFlight: null, analysis: null,
    };
    const save = async () => {
        const temporary = config.outputPath + '.checkpoint.tmp';
        await writeFile(temporary, JSON.stringify(report, null, 2));
        await rename(temporary, config.outputPath);
    };
    await writeFile(config.outputPath, JSON.stringify(report, null, 2), {flag: 'wx'});
    let dispatcher = null;
    let pool = null;
    let workersTerminated = false;
    const groupData = [];
    try {
        assert.equal(process.version, plan.nodeVersion);
        assert.equal(sha(await readFile(new URL(import.meta.url))), config.scriptSha256);
        assert.equal(plan.rounds, 12);
        assert.equal(plan.orders.length, 12);
        assert.equal(plan.workerCount, 4);
        assert.equal(plan.maximumAdmittedGroups, 2);
        assert.deepEqual(plan.modes, ['A-rotation', 'C-rotation-control', 'B-first-free-fifo']);
        const orderCounts = new Map();
        for (const order of plan.orders) {
            assert.deepEqual([...order].sort(), [...plan.modes].sort());
            const key = order.join('/');
            orderCounts.set(key, (orderCounts.get(key) ?? 0) + 1);
        }
        assert.equal(orderCounts.size, 6);
        assert([...orderCounts.values()].every((value) => value === 2));
        for (const [relative, expected] of Object.entries(config.runtimeSourceHashes)) {
            assert.equal(sha(await readFile(path.join(config.root, relative))), expected, relative);
        }
        const manifestBytes = await readFile(config.manifestPath);
        assert.equal(sha(manifestBytes), config.manifestSha256);
        const manifest = JSON.parse(manifestBytes);
        assert(manifest.complete);
        assert.equal(manifest.blockTargetBytes, 1048576);
        assert.equal(manifest.gitSha, plan.captureCommit);
        assert.equal(manifest.totalRows, 528299);
        const oracleBytes = await readFile(config.oraclePath);
        assert.equal(sha(oracleBytes), config.oracleSha256);
        const oracle = JSON.parse(oracleBytes);
        assert(oracle.complete);
        assert.equal(oracle.blockCount, 103);
        const reference = oracle.observations.find((value) => value.mode === 'serial');
        assert(reference);
        assert.equal(reference.outputBytes, plan.expected.outputBytes);
        assert.equal(reference.outputSha256, plan.expected.outputSha256);
        assert.deepEqual(reference.outputBlockSha256.map((value) => value.length), plan.expected.blocksPerGroup);
        assert.equal(sha(await readFile(config.bridgePath)), config.bridgeSha256);
        const space = await statfs(path.dirname(config.compressedOutputDirectory));
        assert(space.bavail * space.bsize > config.minimumFreeOutputBytes, 'Insufficient free output space');
        await mkdir(config.compressedOutputDirectory);

        for (const group of manifest.groups) {
            const inputDirectory = path.dirname(config.manifestPath);
            const raw = await readFile(path.join(inputDirectory, group.sourceFile));
            const offsetBytes = await readFile(path.join(inputDirectory, group.offsetsFile));
            const lengthBytes = await readFile(path.join(inputDirectory, group.lengthsFile));
            assert.equal(sha(raw), group.sourceSha256);
            assert.equal(sha(offsetBytes), group.offsetsSha256);
            assert.equal(sha(lengthBytes), group.lengthsSha256);
            const source = new Uint8Array(new SharedArrayBuffer(raw.byteLength));
            source.set(raw);
            const sourceOffsets = Uint32Array.from(new Uint32Array(
                offsetBytes.buffer, offsetBytes.byteOffset, offsetBytes.byteLength / 4,
            ));
            const sourceLengths = Uint32Array.from(new Uint32Array(
                lengthBytes.buffer, lengthBytes.byteOffset, lengthBytes.byteLength / 4,
            ));
            for (let block = 0; block < group.blockLengths.length; ++block) {
                const digest = createHash('sha256');
                let length = 0;
                for (let index = group.blockStartIndexes[block]; index < group.blockStartIndexes[block + 1]; ++index) {
                    assert(sourceOffsets[index] + sourceLengths[index] <= source.byteLength);
                    digest.update(source.subarray(sourceOffsets[index], sourceOffsets[index] + sourceLengths[index]));
                    length += sourceLengths[index];
                }
                assert.equal(length, group.blockLengths[block]);
                assert.equal(digest.digest('hex'), group.inputBlockSha256[block]);
            }
            groupData.push({
                ...group, source, sourceOffsets, sourceLengths,
                blockStartIndexes: Uint32Array.from(group.blockStartIndexes),
                blockLengths: Uint32Array.from(group.blockLengths),
            });
        }
        assert.equal(groupData.length, 12);
        assert.equal(groupData.reduce((sum, group) => sum + group.blockLengths.length, 0), 103);
        assert.equal(groupData.reduce((sum, group) => sum + group.uniqueContentBytes, 0), 100300626);
        report.preTimingInputProof = {
            complete: true, groups: 12, rows: 528299, blocks: 103, inputBytes: 100300626,
            manifestSha256: config.manifestSha256, oracleSha256: config.oracleSha256,
            sourceHashes: manifest.sourceHashes,
        };
        report.startupMemory.push({phase: 'sources-loaded', usage: process.memoryUsage()});
        await save();

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, options) => {
            const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
            if (url.protocol !== 'file:') { return originalFetch(input, options); }
            return new Response(await readFile(url), {
                headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'},
            });
        };
        const codec = await import(pathToFileURL(path.join(config.root, 'ext/js/dictionary/zstd-term-content.js')));
        let activeGroup = -1;
        dispatcher = new Dispatcher(config, () => activeGroup);
        pool = new codec.TermContentCompressionPool(dispatcher.logical);
        await dispatcher.start();
        report.startupMemory.push({phase: 'four-workers-ready-without-main-decoder', usage: process.memoryUsage()});
        await save();

        function verifyOutputs(outputs, indexes) {
            const digest = createHash('sha256');
            let outputBytes = 0;
            let expectedDecodedBytes = 0;
            const outputBlockSha256 = [];
            const blocks = [];
            for (let outputIndex = 0; outputIndex < indexes.length; ++outputIndex) {
                const group = indexes[outputIndex];
                const chunks = outputs[outputIndex].chunks;
                assert.equal(chunks.length, manifest.groups[group].blockLengths.length);
                const hashes = [];
                for (let block = 0; block < chunks.length; ++block) {
                    const bytes = chunks[block];
                    const hash = sha(bytes);
                    assert.equal(hash, reference.outputBlockSha256[group][block]);
                    hashes.push(hash);
                    digest.update(bytes);
                    blocks.push({group, block, offset: outputBytes, length: bytes.byteLength});
                    outputBytes += bytes.byteLength;
                    expectedDecodedBytes += manifest.groups[group].blockLengths[block];
                }
                outputBlockSha256.push(hashes);
            }
            const outputSha256 = digest.digest('hex');
            if (indexes.length === 12) {
                assert.equal(outputBytes, reference.outputBytes);
                assert.equal(outputSha256, reference.outputSha256);
                assert.equal(expectedDecodedBytes, 100300626);
                assert.equal(blocks.length, 103);
            }
            return {
                outputSha256, outputBlockSha256, outputBytes, blocks,
                hashedBlocks: blocks.length, expectedDecodedBytes, indexes,
            };
        }

        async function persistOutputs(record, outputs) {
            const filename = record.label + '-' + record.mode + '.bin';
            const filePath = path.join(config.compressedOutputDirectory, filename);
            record.file = filename;
            const handle = await open(filePath, 'wx');
            let position = 0;
            try {
                for (const {chunks} of outputs) {
                    for (const bytes of chunks) {
                        let written = 0;
                        while (written < bytes.byteLength) {
                            const result = await handle.write(bytes, written, bytes.byteLength - written, position);
                            assert(result.bytesWritten > 0);
                            written += result.bytesWritten;
                            position += result.bytesWritten;
                        }
                    }
                }
                assert.equal(position, record.outputBytes);
            } finally {
                await handle.close();
            }
        }

        function serviceReceipt(snapshot, startedNs, endedNs) {
            const workerBusyMs = [0, 0, 0, 0];
            const workerQueueWaitMs = [0, 0, 0, 0];
            for (const job of snapshot.jobs) {
                assert.equal(typeof job.startedNs, 'string');
                assert.equal(typeof job.endedNs, 'string');
                assert.equal(typeof job.sourceConsumedReceivedNs, 'string');
                assert(BigInt(job.endedNs) >= BigInt(job.startedNs));
                assert(BigInt(job.receivedNs) >= BigInt(job.sourceConsumedReceivedNs));
                workerBusyMs[job.physicalWorker] += ms(job.endedNs, job.startedNs);
                workerQueueWaitMs[job.physicalWorker] += ms(job.dispatchedNs, job.enqueuedNs);
            }
            return {
                ...snapshot, startedNs, endedNs, elapsedMs: ms(endedNs, startedNs),
                workerBusyMs, workerQueueWaitMs,
            };
        }

        async function observe(mode, label, round, order) {
            globalThis.gc?.();
            dispatcher.reset(mode);
            pool._nextSpanWorkerIndex = 0;
            report.inFlight = {mode, label, round, order, state: 'planned', setupMemory: process.memoryUsage()};
            await save();
            console.log(JSON.stringify({event: 'start', mode, label, round, order}));
            const outputs = new Array(groupData.length);
            const pending = [];
            const sourceConsumed = [];
            let maxPendingGroups = 0;
            const startedNs = ns();
            for (let group = 0; group < groupData.length; ++group) {
                activeGroup = group;
                const data = groupData[group];
                const operation = pool.beginCompressWrappedSpans(
                    data.source, data.sourceOffsets, data.sourceLengths,
                    data.blockStartIndexes, data.blockLengths, 'jmdict',
                );
                sourceConsumed.push(operation.sourceConsumed);
                const completion = operation.completion.then((value) => { outputs[group] = value; });
                void completion.catch(() => {});
                pending.push(completion);
                maxPendingGroups = Math.max(maxPendingGroups, pending.length);
                if (pending.length === 2) { await pending.shift(); }
            }
            await Promise.all(pending);
            await Promise.all(sourceConsumed);
            const endedNs = ns();
            const receipt = serviceReceipt(dispatcher.snapshot(), startedNs, endedNs);
            assert.equal(receipt.pending, 0);
            assert.equal(receipt.queued, 0);
            assert.equal(receipt.jobs.length, 103);
            assert.equal(maxPendingGroups, 2);
            if (mode === 'B-first-free-fifo') {
                assert(receipt.maxPostedByPhysicalWorker.every((value) => value === 1));
            }
            const record = {mode, label, round, order, ...receipt, maxPendingGroups};
            report.inFlight = {...record, state: 'timing-complete-unverified'};
            await save();
            Object.assign(record, verifyOutputs(outputs, groupData.map((_, index) => index)));
            report.inFlight = {...record, state: 'hash-verified-persisting'};
            await save();
            await persistOutputs(record, outputs);
            record.afterMemory = process.memoryUsage();
            (round === undefined ? report.warmups : report.observations).push(record);
            report.inFlight = null;
            await save();
            console.log(JSON.stringify({
                event: 'complete', mode, label, elapsedMs: record.elapsedMs,
                workerBusyMs: record.workerBusyMs, maxPendingGroups,
                maxQueueDepth: record.maxQueueDepth, outputBytes: record.outputBytes,
                hashedBlocks: record.hashedBlocks, expectedDecodedBytes: record.expectedDecodedBytes,
            }));
        }

        for (const mode of plan.warmupOrder) { await observe(mode, 'warmup-' + mode); }
        for (let round = 0; round < plan.orders.length; ++round) {
            const order = plan.orders[round];
            for (const mode of order) { await observe(mode, 'round-' + round, round, order); }
        }
        assert.equal(report.warmups.length, 3);
        assert.equal(report.observations.length, 36);

        const largestGroup = groupData.reduce((best, group, index) => (
            group.source.byteLength > groupData[best].source.byteLength ? index : best
        ), 0);
        for (const mode of plan.modes) {
            globalThis.gc?.();
            dispatcher.reset(mode);
            pool._nextSpanWorkerIndex = 0;
            const data = groupData[largestGroup];
            const source = new Uint8Array(new SharedArrayBuffer(data.source.byteLength));
            source.set(data.source);
            const offsets = Uint32Array.from(data.sourceOffsets);
            const lengths = Uint32Array.from(data.sourceLengths);
            const label = 'ownership';
            report.inFlight = {mode, label, group: largestGroup, state: 'before-snapshot-poison'};
            await save();
            activeGroup = largestGroup;
            dispatcher.holdFinalReplies = true;
            const operation = pool.beginCompressWrappedSpans(
                source, offsets, lengths, data.blockStartIndexes, data.blockLengths, 'jmdict',
            );
            offsets.fill(0xffffffff);
            lengths.fill(0xffffffff);
            await operation.sourceConsumed;
            const heldBeforePoison = dispatcher.heldReplies.length;
            assert(heldBeforePoison > 0, 'Ownership proof must hold at least one final reply');
            source.fill(0);
            dispatcher.releaseHeldReplies();
            const output = await operation.completion;
            const record = {
                mode, label, group: largestGroup, heldBeforePoison,
                callerColumnsPoisonedBeforeSourceConsumed: true,
                sourcePoisonedAfterSourceConsumedBeforeCompletionDelivery: true,
                ...verifyOutputs([output], [largestGroup]), ...dispatcher.snapshot(),
            };
            assert.equal(record.pending, 0);
            assert.equal(record.queued, 0);
            report.inFlight = {...record, state: 'ownership-hash-verified-persisting'};
            await save();
            await persistOutputs(record, [output]);
            report.sourceOwnershipChecks.push(record);
            report.inFlight = null;
            await save();
        }

        pool.close();
        await dispatcher.close();
        workersTerminated = true;
        report.compressionWorkersFinalState = {
            workerCount: dispatcher.physical.length, allTerminated: true,
            failure: dispatcher.failure === null ? null : {
                name: dispatcher.failure?.name ?? typeof dispatcher.failure,
                message: String(dispatcher.failure),
            },
        };
        assert.equal(dispatcher.failure, null, 'Compression worker failed before final acceptance');
        report.startupMemory.push({phase: 'all-four-workers-terminated', usage: process.memoryUsage()});
        for (const data of groupData) {
            assert.equal(sha(data.source), data.sourceSha256);
            assert.equal(sha(bytesOf(data.sourceOffsets)), data.offsetsSha256);
            assert.equal(sha(bytesOf(data.sourceLengths)), data.lengthsSha256);
        }
        groupData.length = 0;
        globalThis.gc?.();
        report.inFlight = {state: 'initializing-decoder-after-worker-termination'};
        await save();
        await codec.initializeTermContentZstd();
        const {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, TERM_CONTENT_BLOCK_ENVELOPE_MAGIC} = await import(
            pathToFileURL(path.join(config.root, 'ext/js/dictionary/term-content-block-envelope.js'))
        );
        const {hashTermEntryContentBytesPair} = await import(
            pathToFileURL(path.join(config.root, 'ext/js/dictionary/term-entry-content-hash.js'))
        );
        const records = [...report.warmups, ...report.observations, ...report.sourceOwnershipChecks];
        for (const record of records) {
            report.inFlight = {state: 'exhaustive-decode', mode: record.mode, label: record.label, file: record.file};
            await save();
            const raw = await readFile(path.join(config.compressedOutputDirectory, record.file));
            assert.equal(raw.byteLength, record.outputBytes);
            assert.equal(sha(raw), record.outputSha256);
            let decodedBytes = 0;
            let position = 0;
            for (const block of record.blocks) {
                assert.equal(block.offset, position);
                const wrapped = raw.subarray(block.offset, block.offset + block.length);
                assert.equal(wrapped.byteLength, block.length);
                assert.equal(sha(wrapped), reference.outputBlockSha256[block.group][block.block]);
                assert(wrapped.byteLength > TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
                assert(TERM_CONTENT_BLOCK_ENVELOPE_MAGIC.every((value, index) => wrapped[index] === value));
                const compressed = wrapped.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
                const [hash1, hash2] = hashTermEntryContentBytesPair(compressed);
                const view = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
                assert.equal(view.getUint32(4, true), hash1);
                assert.equal(view.getUint32(8, true), hash2);
                const expectedLength = manifest.groups[block.group].blockLengths[block.block];
                const decoded = codec.decompressTermContentZstd(compressed, 'jmdict', {maxOutputSize: expectedLength});
                assert.equal(decoded.byteLength, expectedLength);
                assert.equal(sha(decoded), manifest.groups[block.group].inputBlockSha256[block.block]);
                decodedBytes += decoded.byteLength;
                position += block.length;
            }
            assert.equal(position, raw.byteLength);
            assert.equal(decodedBytes, record.expectedDecodedBytes);
            report.exhaustiveDecodeVerification.push({
                mode: record.mode, label: record.label, file: record.file,
                blocks: record.blocks.length, decodedBytes, outputSha256: record.outputSha256,
            });
            await save();
        }
        assert.equal(report.exhaustiveDecodeVerification.length, 42);
        for (const [relative, expected] of Object.entries(config.runtimeSourceHashes)) {
            assert.equal(sha(await readFile(path.join(config.root, relative))), expected, relative);
        }
        const comparisons = {};
        for (const [candidate, control] of [
            ['B-first-free-fifo', 'A-rotation'],
            ['B-first-free-fifo', 'C-rotation-control'],
            ['C-rotation-control', 'A-rotation'],
        ]) {
            const pairs = plan.orders.map((order, round) => {
                const a = report.observations.find((value) => value.round === round && value.mode === control);
                const b = report.observations.find((value) => value.round === round && value.mode === candidate);
                assert(a && b);
                return {round, order, candidateMs: b.elapsedMs, controlMs: a.elapsedMs, changePercent: (b.elapsedMs / a.elapsedMs - 1) * 100};
            });
            comparisons[candidate + '/' + control] = {
                pairs, pairedMedianPercent: median(pairs.map((value) => value.changePercent)),
                equalWorkPercent: (pairs.reduce((sum, value) => sum + value.candidateMs, 0) /
                    pairs.reduce((sum, value) => sum + value.controlMs, 0) - 1) * 100,
                fasterPairs: pairs.filter((value) => value.candidateMs < value.controlMs).length,
            };
        }
        report.analysis = {
            scope: plan.scope, observations: 36, warmups: 3, ownershipChecks: 3,
            exhaustiveDecodeOutputs: 42,
            exhaustiveDecodedBlocks: report.exhaustiveDecodeVerification.reduce((sum, value) => sum + value.blocks, 0),
            exhaustiveDecodedBytes: report.exhaustiveDecodeVerification.reduce((sum, value) => sum + value.decodedBytes, 0),
            medianMs: Object.fromEntries(plan.modes.map((mode) => [
                mode, median(report.observations.filter((value) => value.mode === mode).map((value) => value.elapsedMs)),
            ])),
            comparisons,
            limitations: [
                'A Node transport scheduling component, not a production implementation or browser import benchmark.',
                'Worker service intervals are event-loop wall times and can include host scheduling delays.',
                'FIFO dispatch returns through the main event loop; its transport cost is included.',
                'Per-group production envelope metrics still describe logical pool assignments, so physical-worker receipts are separate.',
                'Two failed local process attempts are retained separately and are never pooled into this hosted cohort.',
            ],
        };
        report.inFlight = null;
        report.complete = true;
        await save();
        console.log('FIFO_COMPLETE ' + JSON.stringify(report.analysis));
    } catch (error) {
        report.failures.push({
            name: error?.name ?? typeof error, message: String(error), stack: error?.stack ?? null,
            dispatcher: dispatcher?.snapshot() ?? null,
        });
        await save();
        throw error;
    } finally {
        if (!workersTerminated && dispatcher !== null) {
            pool?.close();
            await dispatcher.close();
        }
    }
}

await main();
