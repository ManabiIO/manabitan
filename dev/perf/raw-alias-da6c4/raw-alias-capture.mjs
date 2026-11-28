// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone experiment capture. This capability is not a production ownership proof.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const CAPTURE_GROUPS = [0, 1, 2, 87, 91, 92, 105, 123, 126, 139];
export const MIXED_GROUPS = [1, 87, 91, 92, 105, 123, 126, 139];
export const SEED = {
    file: 'manabitan-term-content.bin',
    bytes: 7533449,
    sha256: 'f50a48e23056054a13f90dfa7aad53ba3a80a6f6e7125289a5ad52dc2f9f686e',
};
export const ROUTE_SHA = '569d56dd9e4fb94ef3c33561f43439d61c2858ab360116d9657a1bcfe9a74a82';
const LIMIT_BYTES = 64 * 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TYPES = {Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array, Int16Array, Int8Array, Float32Array};
const FIELDS = [
    'dictionary', 'rowCount', 'dictionaryTotalRows',
    'expressionBytesList', 'readingBytesList', 'readingEqualsExpressionList',
    'scoreList', 'sequenceList', 'termRecordPreinternedPlan', 'preparedLookupIndexes',
];

function nameGeometry(names, count) {
    if (typeof names === 'string') { return {kind: 'string', value: names}; }
    assert(Array.isArray(names) && names.length >= count);
    const runs = [];
    for (let i = 0; i < count; ++i) {
        assert.equal(typeof names[i], 'string');
        if (i === 0 || runs.at(-1).value !== names[i]) { runs.push({start: i, count: 1, value: names[i]}); }
        else { ++runs.at(-1).count; }
    }
    return {kind: 'array', length: names.length, runs};
}

function routeProjection(group) {
    return {
        index: group.index, firstId: group.firstId, rows: group.rows,
        firstBank: group.firstBank, lastBank: group.lastBank,
        parserPlan: group.parserPlan, parserPrepared: group.parserPrepared,
        persistence: group.persistence, recordEntry: group.recordEntry,
        dispatches: group.dispatches,
    };
}

export async function createRawAliasCapture({directory, manifest, sourceManifestSha256, oraclePath}) {
    assert(path.isAbsolute(directory));
    await mkdir(directory, {recursive: false});
    const oracleBytes = await readFile(oraclePath);
    const oracle = JSON.parse(oracleBytes);
    assert(oracle.complete);
    assert.equal(oracle.routeWitnessSha256, ROUTE_SHA);
    assert.equal(oracle.groups.length, 170);
    const result = {
        schemaVersion: 1, complete: false,
        scope: 'New immutable record-entry capture for a standalone completed-content-tail alias component. No production ownership capability is asserted.',
        source: manifest.gitSha, sourceManifestSha256, fixture: manifest.fixture,
        rawTermBankSourceBytes: manifest.totalSourceBytes,
        sourceHashes: manifest.sourceHashes,
        originalRouteSha256: sha(oracleBytes), expectedRouteWitnessSha256: ROUTE_SHA,
        captureGroups: CAPTURE_GROUPS, mixedGroups: MIXED_GROUPS,
        maximumBytes: LIMIT_BYTES, binaryBytes: 0, groups: [], failures: [],
    };
    const entries = new Map();
    async function checkpoint() {
        const text = JSON.stringify(result, null, 2) + '\n';
        assert(result.binaryBytes + SEED.bytes + Buffer.byteLength(text, 'utf8') <= LIMIT_BYTES, 'Full retained capture including JSON exceeds fixed 64 MiB budget');
        await writeFile(path.join(directory, 'manifest.json'), text);
    }
    await checkpoint();

    async function entry({group, chunk, contentOffsets, contentLengths, contentDictNames}) {
        if (!CAPTURE_GROUPS.includes(group.index)) { return; }
        assert(!entries.has(group.index));
        assert(chunk.resolvedContentReferences);
        assert(chunk.preparedLookupIndexes instanceof Map);
        const references = chunk.resolvedContentReferences;
        assert(references.uniqueIndexList instanceof Uint32Array);
        assert(references.offsets instanceof Float64Array);
        assert(references.lengths instanceof Uint32Array);
        const selected = Object.fromEntries(FIELDS.map((key) => [key, chunk[key]]));
        const rootObject = {chunk: selected, references, contentOffsets, contentLengths};
        const ids = new Map();
        const nodes = [];
        const files = [];
        function encode(value) {
            if (value === undefined) { return {undefined: true}; }
            if (value === null || typeof value === 'string' || typeof value === 'boolean') { return {value}; }
            if (typeof value === 'number') { assert(Number.isFinite(value)); return {value}; }
            assert.equal(typeof value, 'object');
            const previous = ids.get(value);
            if (previous !== undefined) { return {ref: previous}; }
            const id = nodes.length;
            ids.set(value, id);
            nodes.push(null);
            if (value instanceof ArrayBuffer) {
                const filename = 'group-' + group.index + '-buffer-' + files.length + '.bin';
                const bytes = new Uint8Array(value);
                result.binaryBytes += bytes.byteLength;
                assert(result.binaryBytes + SEED.bytes <= LIMIT_BYTES, 'Capture exceeds fixed 64 MiB input budget');
                const description = {file: filename, bytes: bytes.byteLength, sha256: sha(bytes)};
                files.push({description, bytes});
                nodes[id] = {kind: 'buffer', ...description};
            } else if (ArrayBuffer.isView(value)) {
                assert(Object.hasOwn(TYPES, value.constructor.name));
                assert(value.buffer instanceof ArrayBuffer, 'Capture accepts only ordinary record-column buffers');
                nodes[id] = {kind: 'view', type: value.constructor.name, byteOffset: value.byteOffset, length: value.length, buffer: encode(value.buffer)};
            } else if (Array.isArray(value)) {
                nodes[id] = {kind: 'array', values: value.map(encode)};
            } else if (value instanceof Map) {
                nodes[id] = {kind: 'map', values: [...value].map(([key, item]) => [encode(key), encode(item)])};
            } else {
                assert.equal(Object.getPrototypeOf(value), Object.prototype);
                nodes[id] = {kind: 'object', values: Object.entries(value).map(([key, item]) => [key, encode(item)])};
            }
            return {ref: id};
        }
        const root = encode(rootObject);
        for (const {description, bytes} of files) {
            await writeFile(path.join(directory, description.file), bytes, {flag: 'wx'});
        }
        const captured = {
            index: group.index, firstId: group.firstId, rows: chunk.rowCount,
            names: nameGeometry(contentDictNames, chunk.rowCount),
            root, nodes, route: null,
        };
        result.groups.push(captured);
        entries.set(group.index, captured);
        await checkpoint();
    }

    async function route(group) {
        const expected = oracle.groups[group.index];
        assert.deepEqual(routeProjection(group), routeProjection(expected), 'Original source-bound route changed');
        const captured = entries.get(group.index);
        if (captured) { captured.route = routeProjection(group); await checkpoint(); }
    }

    async function finish(report, contentDirectory) {
        assert(report.complete);
        assert.equal(report.rows, 6648310);
        assert.equal(report.metadataUniqueCount, 157150);
        assert.equal(report.routeWitnessSha256, ROUTE_SHA);
        assert.deepEqual(result.groups.map(({index}) => index), CAPTURE_GROUPS);
        assert(result.groups.every(({route}) => route !== null));
        const filename = path.join(contentDirectory, SEED.file);
        assert.equal((await stat(filename)).size, SEED.bytes);
        assert.equal(sha(await readFile(filename)), SEED.sha256);
        await copyFile(filename, path.join(directory, SEED.file));
        result.seed = SEED;
        result.sourceHashes = report.sourceHashes;
        result.routeHarnessSha256 = report.harnessSha256;
        result.loaderSha256 = report.loaderSha256;
        result.captureHelperSha256 = sha(await readFile(new URL(import.meta.url)));
        result.complete = true;
        await checkpoint();
        const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
        return {manifestSha256: sha(manifestBytes), manifestBytes: manifestBytes.length, binaryBytes: result.binaryBytes, seed: SEED};
    }

    async function failure(error) {
        result.complete = false;
        result.failures.push({message: String(error), stack: error?.stack ?? null});
        await checkpoint();
    }
    return {entry, route, finish, failure};
}

export async function loadRawAliasCapture({directory, root}) {
    const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert(manifest.complete && manifest.failures.length === 0);
    assert.deepEqual(manifest.captureGroups, CAPTURE_GROUPS);
    assert.equal(manifest.expectedRouteWitnessSha256, ROUTE_SHA);
    assert.deepEqual(manifest.seed, SEED);
    assert.equal(sha(await readFile(path.join(directory, SEED.file))), SEED.sha256);
    const {createArtifactTermRecordChunkWithResolvedContent} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-record-opfs-store.js')));
    const groups = [];
    for (const stored of manifest.groups) {
        const values = new Array(stored.nodes.length);
        for (let id = 0; id < stored.nodes.length; ++id) {
            const node = stored.nodes[id];
            if (node.kind === 'buffer') {
                const bytes = await readFile(path.join(directory, node.file));
                assert.equal(bytes.byteLength, node.bytes);
                assert.equal(sha(bytes), node.sha256);
                const buffer = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buffer).set(bytes);
                values[id] = buffer;
            } else if (node.kind === 'array') { values[id] = []; }
            else if (node.kind === 'map') { values[id] = new Map(); }
            else if (node.kind === 'object') { values[id] = {}; }
        }
        function decode(token) {
            if (token.undefined === true) { return undefined; }
            if (Object.hasOwn(token, 'value')) { return token.value; }
            assert(Number.isInteger(token.ref) && token.ref >= 0 && token.ref < values.length);
            const node = stored.nodes[token.ref];
            if (node.kind === 'view' && values[token.ref] === undefined) {
                values[token.ref] = new TYPES[node.type](decode(node.buffer), node.byteOffset, node.length);
            }
            return values[token.ref];
        }
        for (let id = 0; id < stored.nodes.length; ++id) {
            const node = stored.nodes[id], value = values[id];
            if (node.kind === 'array') { value.push(...node.values.map(decode)); }
            else if (node.kind === 'map') { for (const [key, item] of node.values) { value.set(decode(key), decode(item)); } }
            else if (node.kind === 'object') { for (const [key, item] of node.values) { value[key] = decode(item); } }
        }
        const data = decode(stored.root);
        const {uniqueIndexList, offsets, lengths} = data.references;
        data.chunk = createArtifactTermRecordChunkWithResolvedContent(
            data.chunk, uniqueIndexList, offsets, lengths, data.chunk.preparedLookupIndexes,
        );
        let contentDictNames;
        if (stored.names.kind === 'string') { contentDictNames = stored.names.value; }
        else {
            contentDictNames = new Array(stored.names.length);
            let cursor = 0;
            for (const run of stored.names.runs) {
                assert.equal(run.start, cursor);
                contentDictNames.fill(run.value, cursor, cursor + run.count);
                cursor += run.count;
            }
            assert.equal(cursor, data.chunk.rowCount);
        }
        groups.push({...data, contentDictNames, index: stored.index, firstId: stored.firstId, expectedRoute: stored.route});
    }
    return {manifest, manifestSha256: sha(manifestBytes), groups};
}

export async function verifyCaptureFiles(directory, manifest) {
    for (const group of manifest.groups) {
        for (const node of group.nodes) {
            if (node.kind !== 'buffer') { continue; }
            const bytes = await readFile(path.join(directory, node.file));
            assert.equal(bytes.length, node.bytes);
            assert.equal(sha(bytes), node.sha256);
        }
    }
    assert.equal(sha(await readFile(path.join(directory, SEED.file))), SEED.sha256);
}
