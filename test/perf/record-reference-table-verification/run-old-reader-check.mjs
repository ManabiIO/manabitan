/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {defaultEvidenceRoot, evidenceReceipt, fileIdentity, helperRoot, loadVerificationManifest, sourceReceipt} from './common.mjs';

const {values} = parseArgs({options: {
    'source-root': {type: 'string'},
    'source-id': {type: 'string'},
    'reader-root': {type: 'string'},
    'reader-id': {type: 'string'},
    'evidence-dir': {type: 'string'},
    'output': {type: 'string'},
    'node-sha256': {type: 'string'},
}});
for (const name of ['source-root', 'source-id', 'reader-root', 'reader-id', 'output']) {
    assert.equal(typeof values[name], 'string', `Missing --${name}`);
}
for (const name of ['source-id', 'reader-id']) { assert.match(values[name], /^[0-9a-f]{40}$/); }
const sourceRoot = path.resolve(values['source-root']);
const readerRoot = path.resolve(values['reader-root']);
const evidenceRoot = path.resolve(values['evidence-dir'] ?? defaultEvidenceRoot);
const output = path.resolve(values.output);
await mkdir(output); // Preserve every earlier failed or successful run.
const save = (name, data) => writeFile(path.join(output, name), `${JSON.stringify(data, null, 2)}\n`, {flag: 'wx'});
const {manifest, identity: manifestIdentity} = await loadVerificationManifest(evidenceRoot);
assert.equal(process.version, manifest.recordedNodeVersion);
const node = await fileIdentity(process.execPath);
if (values['node-sha256']) { assert.equal(node.sha256, values['node-sha256']); }
const candidate = await sourceReceipt(sourceRoot, values['source-id'], 'B', manifest);
const reader = await sourceReceipt(readerRoot, values['reader-id'], 'A', manifest);
const evidence = await evidenceReceipt(evidenceRoot, manifest);
const fixturePath = path.join(helperRoot, 'previous-reader.fixture.mjs');
const fixture = await readFile(fixturePath);
const testPath = path.join(sourceRoot, 'test', `record-reference-previous-reader-${randomUUID()}.test.js`);
const resultPath = path.join(output, 'result.json');
const configuration = {candidateCommit: values['source-id'],
    readerCommit: values['reader-id'],
    readerRoot,
    readerDatabaseSha256: manifest.sourceProfiles.A.canonicalIdentity['ext/js/dictionary/dictionary-database.js'],
    opfsAdapter: pathToFileURL(path.join(helperRoot, 'node-opfs-bounded.mjs')).href,
    resultPath};
await save('preflight.json', {schemaVersion: 1,
    timingEligible: false,
    candidate,
    reader,
    manifestIdentity,
    evidence,
    node,
    fixture: await fileIdentity(fixturePath),
    adapter: await fileIdentity(path.join(helperRoot, 'node-opfs-bounded.mjs')),
    boundary: 'Actual previous Database reader, real SQLite and candidate-written format4 OPFS files. No browser downgrade or whole-import timing claim.'});
try {
    await writeFile(testPath, fixture, {flag: 'wx'});
    const command = [path.join(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run', testPath, '--maxWorkers=1'];
    const result = spawnSync(process.execPath, command, {cwd: sourceRoot,
        env: {...process.env, MANABITAN_REFERENCE_OLD_READER_CONFIG: JSON.stringify(configuration)},
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024});
    await writeFile(path.join(output, 'stdout.log'), result.stdout ?? '', {flag: 'wx'});
    await writeFile(path.join(output, 'stderr.log'), result.stderr ?? '', {flag: 'wx'});
    await save('exit.json', {status: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
        command: [process.execPath, ...command],
        deadlineMs: 60_000});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'Inspect retained previous-reader logs');
    const outcome = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(outcome.success, true);
    assert.equal(outcome.actualFormat4Chunks, 1);
    assert.equal(outcome.userVersion, 13);
    assert.equal(outcome.beforeDatabaseSha256, outcome.afterDatabaseSha256);
    assert.deepEqual(outcome.beforeFiles, outcome.afterFiles);
    for (const key of ['recoveryCalls', 'contentPrepareCalls', 'contentActivateRootCalls', 'persistentPurgeCalls', 'recordPrepareCalls', 'schemaCalls', 'runtimePragmaCalls', 'healthRestoreCalls']) {
        assert.equal(outcome[key], 0, `Previous reader crossed early gate: ${key}`);
    }
    assert.deepEqual(await sourceReceipt(sourceRoot, values['source-id'], 'B', manifest), candidate);
    assert.deepEqual(await sourceReceipt(readerRoot, values['reader-id'], 'A', manifest), reader);
    await save('verified.json', {success: true,
        timingEligible: false,
        result: await fileIdentity(resultPath),
        unchangedCandidateAndPreviousReader: true,
        rejectedBeforeAnyRecoveryOrOpfsPreparation: true});
    console.log(JSON.stringify({success: true, output}));
} finally {
    await rm(testPath, {force: true});
}
