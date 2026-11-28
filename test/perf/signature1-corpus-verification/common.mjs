import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, statfs} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const helperRoot = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(helperRoot, '../../..');
export const defaultEvidenceRoot = path.join(repositoryRoot, 'builds/perf/20261128-4d9f-signature1');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseRunArguments(args = process.argv.slice(2)) {
    const {values} = parseArgs({args,
        options: {
            'source-root': {type: 'string'},
            'source-id': {type: 'string'},
            'corpus': {type: 'string'},
            'arm': {type: 'string'},
            'cache-dir': {type: 'string'},
            'output': {type: 'string'},
            'evidence-dir': {type: 'string'},
            'node-sha256': {type: 'string'},
            'help': {type: 'boolean'},
        }});
    if (values.help) {
        console.log('Usage: node run.mjs --source-root CHECKOUT --source-id COMMIT --corpus jmdict|jitendex|vndb --arm A|B --cache-dir ARCHIVES --output NEW_DIRECTORY [--evidence-dir DATA] [--node-sha256 SHA256]');
        return null;
    }
    for (const name of ['source-root', 'source-id', 'corpus', 'arm', 'cache-dir', 'output']) {
        assert.equal(typeof values[name], 'string', `Missing --${name}`);
    }
    assert(['jmdict', 'jitendex', 'vndb'].includes(values.corpus));
    assert(['A', 'B'].includes(values.arm));
    assert.match(values['source-id'], /^[0-9a-f]{40}$/, '--source-id must be an exact commit SHA');
    if (values['node-sha256']) { assert.match(values['node-sha256'], /^[0-9a-f]{64}$/); }
    return {
        sourceRoot: path.resolve(values['source-root']),
        sourceCommit: values['source-id'],
        corpus: values.corpus,
        arm: values.arm,
        cacheRoot: path.resolve(values['cache-dir']),
        output: path.resolve(values.output),
        evidenceRoot: path.resolve(values['evidence-dir'] ?? defaultEvidenceRoot),
        expectedNodeSha256: values['node-sha256'] ?? null,
    };
}

export async function fileIdentity(file) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
        bytes += chunk.byteLength;
        hash.update(chunk);
    }
    return {bytes, sha256: hash.digest('hex')};
}

export async function fileHashes(root, files) {
    return Object.fromEntries(await Promise.all([...new Set(files)].map(async (file) => [file, (await fileIdentity(path.join(root, file))).sha256])));
}

export async function loadVerificationManifest(evidenceRoot) {
    const filename = path.join(evidenceRoot, 'verification-manifest.json');
    const bytes = await readFile(filename);
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.schemaVersion, 1);
    const historical = manifest.historicalSource.canonicalIdentity;
    const parent = manifest.sourceProfiles.A.canonicalIdentity;
    const candidate = manifest.sourceProfiles.B.canonicalIdentity;
    assert(['physical-float64', 'implicit-positive-zero-or-full-float64'].includes(manifest.logicalRecordIdRepresentation ?? 'physical-float64'));
    const parentChanges = new Set([...manifest.mergedParserChanges, ...(manifest.upstreamIntegrationChanges ?? [])]);
    assert.deepEqual(Object.keys(parent), Object.keys(historical));
    assert.deepEqual(Object.keys(candidate), Object.keys(parent));
    for (const [file, hash] of Object.entries(historical)) {
        if (!parentChanges.has(file)) { assert.equal(parent[file], hash, `Unexpected recorded parent delta: ${file}`); }
        if (!manifest.signatureChanges.includes(file)) { assert.equal(candidate[file], parent[file], `Unexpected recorded S1 delta: ${file}`); }
    }
    return {manifest, identity: {bytes: bytes.byteLength, sha256: sha256(bytes)}};
}

export async function readPinnedOracle(evidenceRoot, manifest, name) {
    const expected = manifest.oracles[name];
    assert(expected, `Missing oracle ${name}`);
    const filename = path.resolve(evidenceRoot, expected.path);
    assert(filename.startsWith(`${path.resolve(evidenceRoot)}${path.sep}`));
    const bytes = await readFile(filename);
    const identity = {bytes: bytes.byteLength, sha256: sha256(bytes)};
    assert.deepEqual(identity, {bytes: expected.bytes, sha256: expected.sha256}, `Oracle identity ${name}`);
    return {filename, bytes, identity};
}

export async function evidenceReceipt(evidenceRoot, manifest) {
    const oracles = {};
    for (const name of Object.keys(manifest.oracles)) {
        const {identity} = await readPinnedOracle(evidenceRoot, manifest, name);
        oracles[name] = identity;
    }
    return {
        manifest: await fileIdentity(path.join(evidenceRoot, 'verification-manifest.json')),
        protocol: await fileIdentity(path.join(evidenceRoot, 'protocol.json')),
        oracles,
    };
}

export async function sourceReceipt(root, commit, arm, manifest) {
    const profile = manifest.sourceProfiles[arm];
    assert(profile);
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), commit);
    const trees = {};
    for (const [name, expected] of Object.entries(profile.trees)) {
        trees[name] = execFileSync('git', ['-C', root, 'rev-parse', `${commit}:${name}`], {encoding: 'utf8'}).trim();
        assert.equal(trees[name], expected, `Frozen runtime source tree ${name}`);
    }
    // Later helper/evidence-only commits are valid. Runtime working-tree edits are not.
    const diff = execFileSync('git', ['-C',
        root,
        'diff',
        'HEAD',
        '--binary',
        '--',
        'ext',
        'dev/lib',
        'dev/data/dictionary-wasm',
        'package-lock.json',
        'test/perf/dictionaries.lock.json']);
    assert.equal(diff.byteLength, 0, 'Runtime source must remain unchanged');
    const identity = await fileHashes(root, Object.keys(profile.canonicalIdentity));
    const canonicalIdentity = {...identity};
    const zipBytes = await readFile(path.join(root, 'ext/lib/zip.js'));
    const zipText = zipBytes.toString('utf8');
    assert(Buffer.from(zipText).equals(zipBytes), 'ZIP bundle must be valid UTF-8');
    const zipCommentPattern = /^\/\/ (?:[^\r\n]*\/)?node_modules\/@zip\.js\/zip\.js\//gm;
    const commentLines = [...zipText.matchAll(zipCommentPattern)].length;
    assert.equal(commentLines, manifest.zipSourceCommentNormalization.commentLines);
    canonicalIdentity['ext/lib/zip.js'] = sha256(zipText.replace(zipCommentPattern, '// node_modules/@zip.js/zip.js/'));
    assert.equal(canonicalIdentity['ext/lib/zip.js'], manifest.zipSourceCommentNormalization.canonicalSha256);
    assert.deepEqual(canonicalIdentity, profile.canonicalIdentity, 'Every frozen runtime source/asset identity');
    const nativeManifest = JSON.parse(await readFile(path.join(root, 'dev/data/dictionary-wasm/manifest.json'), 'utf8'));
    assert.equal(nativeManifest.toolchain.compilerVersion, '21.1.8');
    assert.equal(nativeManifest.toolchain.linkerVersion, '21.1.8');
    for (const target of nativeManifest.targets) {
        assert.equal(identity[`ext/lib/${target.name}`], target.sha256);
        assert.equal(identity[`dev/data/dictionary-wasm/${target.name}`], target.sha256);
    }
    return {root,
        commit,
        runtimeProfileCommit: profile.runtimeCommit,
        trees,
        runtimeDiffSha256: sha256(diff),
        identity,
        canonicalIdentity,
        generatedZipComments: {commentLines, rawSha256: identity['ext/lib/zip.js'], canonicalSha256: canonicalIdentity['ext/lib/zip.js']}};
}

export function assertHistoricalOracleIdentity(referenceIdentity, actualIdentity, manifest, arm) {
    for (const [file, hash] of Object.entries(referenceIdentity)) {
        assert.equal(manifest.historicalSource.canonicalIdentity[file], hash, `Historical oracle source ${file}`);
        if (actualIdentity[file] !== hash) {
            assert(
                manifest.mergedParserChanges.includes(file) ||
                (manifest.upstreamIntegrationChanges ?? []).includes(file) ||
                (arm === 'B' && manifest.signatureChanges.includes(file)),
                `Unexpected historical oracle runtime delta: ${file}`,
            );
        }
    }
}

export async function resources(outputRoot) {
    const free = async (location) => {
        const info = await statfs(location);
        return {location, availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize};
    };
    const optional = async (file) => {
        try {
            return (await readFile(file, 'utf8')).trim();
        } catch (error) {
            return {unavailable: error.code};
        }
    };
    return {
        utc: new Date().toISOString(),
        node: process.version,
        versions: process.versions,
        execArgv: process.execArgv,
        platform: process.platform,
        arch: process.arch,
        cpus: os.availableParallelism(),
        loadAverage: os.loadavg(),
        freeMemoryBytes: os.freemem(),
        processMemory: process.memoryUsage(),
        processUsage: process.resourceUsage(),
        temp: await free(os.tmpdir()),
        reports: await free(outputRoot),
        cgroup: Object.fromEntries(await Promise.all(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'].map(async (file) => [file, await optional(file)]))),
    };
}
