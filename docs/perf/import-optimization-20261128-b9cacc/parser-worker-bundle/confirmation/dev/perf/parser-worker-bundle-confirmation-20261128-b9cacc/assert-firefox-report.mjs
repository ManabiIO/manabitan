#!/usr/bin/env node
// Post-run assertions for the frozen, unchanged Firefox focused harness.
// This is evidence validation, not a browser harness or performance estimator.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';

const CANDIDATE = '9da7dedd17535b4a0f8edb97e56756049bbad7a7';
const HARNESS_SHA256 = '67b19eb5555f00d592ff1e2223b46a9ba838ca3adabe17f11816c2273b8f6340';
const FIXTURE_LOCK_SHA256 = '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value, label) => {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: missing object`);
    return value;
};
const positiveInteger = (value, label) => assert(Number.isSafeInteger(value) && value > 0, `${label}: expected positive integer`);
const nonnegativeInteger = (value, label) => assert(Number.isSafeInteger(value) && value >= 0, `${label}: expected nonnegative integer`);

function uniquePhase(phases, name) {
    const matches = phases.map((phase, index) => ({phase, index})).filter(({phase}) => phase?.name === name);
    assert.equal(matches.length, 1, `${name}: missing or ambiguous phase`);
    const {phase, index} = matches[0];
    assert.equal(typeof phase.details, 'string', `${name}: missing details`);
    assert(Number.isFinite(phase.durationMs) && phase.durationMs >= 0, `${name}: invalid duration`);
    return {...phase, index};
}

function trailingJson(phase, prefix, exactPrefix = true) {
    let start = 0;
    if (exactPrefix) {
        assert(phase.details.startsWith(prefix), `${phase.name}: unexpected details prefix`);
    } else {
        start = phase.details.indexOf(prefix);
        assert(start >= 0 && phase.details.indexOf(prefix, start + prefix.length) < 0,
            `${phase.name}: missing or ambiguous JSON marker`);
    }
    return record(JSON.parse(phase.details.slice(start + prefix.length)), phase.name);
}

function assertOpenStorage(value, label) {
    const storage = record(value, label);
    assert.equal(storage.mode, 'opfs-sahpool', `${label}: wrong storage mode`);
    assert.equal(storage.forceFallback, false, `${label}: forced fallback`);
    assert.equal(storage.hasOpfsSahpoolVfs, true, `${label}: missing SAH-pool VFS`);
    assert(storage.opfsSahpoolInstallResult === null || storage.opfsSahpoolInstallResult === 'installed',
        `${label}: missing or failed SAH-pool installation result`);
    const context = record(storage.runtimeContext, `${label}.runtimeContext`);
    assert.equal(context.isDedicatedWorkerGlobalScope, true, `${label}: storage is not in a dedicated worker`);
    assert.equal(context.hasStorageGetDirectory, true, `${label}: missing storage directory API`);
    assert.equal(context.hasCreateSyncAccessHandle, true, `${label}: missing sync-access-handle API`);
    assert.equal(typeof context.href, 'string', `${label}: missing worker URL`);
    assert.equal(new URL(context.href).protocol, 'moz-extension:', `${label}: not a Firefox extension worker`);
    return storage;
}

function assertImport(phases, name, fixture) {
    const phase = uniquePhase(phases, `${name} import resource profile`);
    const debug = trailingJson(phase, ' importDebug=', false);
    assert.equal(debug.hasResult, true, `${name}: missing successful import result`);
    assert.equal(debug.errorCount, 0, `${name}: import errors`);
    assert.equal(debug.addSettingsErrorCount, 0, `${name}: settings errors`);
    assert.equal(debug.usesFallbackStorage, false, `${name}: fallback or missing storage evidence`);
    assert.equal(debug.fallbackDatabaseContentBase64Length, null, `${name}: fallback content present or evidence missing`);
    assert.equal(debug.sourceTitle, fixture.expectedTitle, `${name}: wrong locked source title`);
    assert(debug.resultTitle === fixture.expectedTitle || debug.resultTitle === name, `${name}: unexpected installed title/alias`);
    assertOpenStorage(debug.openStorageDiagnostics, `${name}.openStorageDiagnostics`);
    assert(Array.isArray(debug.importerPhaseTimings), `${name}: missing importer phases`);
    const fast = debug.importerPhaseTimings.filter((item) => typeof item?.phase === 'string' && item.phase.startsWith('term-file-fast-path:'));
    assert(fast.length > 0, `${name}: no native fast-path receipt`);
    const labels = new Set();
    let rows = 0;
    const parallel = fast.map((item) => {
        assert(!labels.has(item.phase), `${name}: duplicate fast-path receipt`);
        labels.add(item.phase);
        const details = record(item.details, `${name}.${item.phase}`);
        positiveInteger(details.rows, `${name}.rows`);
        positiveInteger(details.parserParallelWorkerCount, `${name}.parserParallelWorkerCount`);
        positiveInteger(details.parserParallelGroupCount, `${name}.parserParallelGroupCount`);
        assert.equal(details.parserParallelSkipReason, null, `${name}: parallel parser skipped or evidence missing`);
        nonnegativeInteger(details.parserFusedFallbacks, `${name}.parserFusedFallbacks`);
        // A supported fused-kernel fallback is distinct from skipping workers.
        // Record it without imposing a new parser-compatibility condition.
        rows += details.rows;
        return {phase: item.phase, rows: details.rows, workerCount: details.parserParallelWorkerCount,
            groupCount: details.parserParallelGroupCount, fusedFallbacks: details.parserFusedFallbacks};
    });
    assert.equal(rows, fixture.termRows, `${name}: fast-path rows differ from locked source`);
    const banks = debug.importerPhaseTimings.filter((item) => item?.phase === 'import-data-banks');
    assert.equal(banks.length, 1, `${name}: missing or ambiguous completed bank import`);
    const counts = record(banks[0].details, `${name}.import-data-banks`);
    assert.equal(counts.terms, fixture.termRows, `${name}: wrong term count`);
    assert.equal(counts.media, fixture.mediaFiles, `${name}: wrong media count`);
    return {phaseIndex: phase.index, sourceTitle: debug.sourceTitle, resultTitle: debug.resultTitle,
        termRows: counts.terms, mediaFiles: counts.media, parallel, debugSha256: hash(JSON.stringify(debug))};
}

function assertIntegrity(phases, name, imported) {
    const phase = uniquePhase(phases, `Verify ${name} backend content integrity after import`);
    const prefix = name === 'Jitendex' ?
        'Checked that imported Jitendex term-content spans are readable and in bounds before opening the concurrent search tab: ' :
        'Checked that imported JMdict term-content spans are readable and in bounds before later UI verification: ';
    const integrity = trailingJson(phase, prefix);
    assert.equal(integrity.ok, true, `${name}: content integrity failed`);
    assert(Array.isArray(integrity.probes) && integrity.probes.length > 0, `${name}: missing content-integrity probes`);
    for (const probe of integrity.probes) {
        record(probe, `${name}.probe`);
        assert.deepEqual(probe.requestedDictionaryNames, [name], `${name}: wrong probe target`);
        assert(Array.isArray(probe.dictionaryNames) && probe.dictionaryNames.includes(imported.resultTitle),
            `${name}: probe did not resolve the imported title`);
        nonnegativeInteger(probe.rowSampleCount, `${name}.rowSampleCount`);
        for (const key of ['inBoundsRowCount', 'outOfBoundsRowCount', 'glossaryReadyRowCount', 'readablePreviewRowCount']) {
            nonnegativeInteger(probe[key], `${name}.${key}`);
            assert(probe[key] <= probe.rowSampleCount, `${name}: inconsistent probe row count`);
        }
        assert.equal(probe.outOfBoundsRowCount, 0, `${name}: out-of-bounds content`);
    }
    const last = integrity.probes.at(-1);
    if (integrity.reason === 'lookup-results-visible-without-debug-row-sample') {
        const diagnostics = record(last.diagnostics, `${name}.probe.diagnostics`);
        positiveInteger(diagnostics.termResultCount, `${name}.probe.termResultCount`);
        assert(Array.isArray(diagnostics.termDictionaryNames) && diagnostics.termDictionaryNames.includes(imported.resultTitle),
            `${name}: fallback probe has no matching lookup result`);
    } else {
        assert.equal(integrity.reason, undefined, `${name}: unexpected content-integrity success reason`);
        assert(last.glossaryReadyRowCount > 0 || last.readablePreviewRowCount > 0, `${name}: no readable content witness`);
    }
    return {phaseIndex: phase.index, probes: integrity.probes.length, reason: integrity.reason ?? 'readable-content-witness'};
}

const {values} = parseArgs({options: {
    report: {type: 'string'}, 'fixture-lock': {type: 'string'}, harness: {type: 'string'}, output: {type: 'string'},
}, strict: true, allowPositionals: false});
for (const option of ['report', 'fixture-lock', 'harness', 'output']) assert(values[option], `Missing --${option}`);
const receipt = {schemaVersion: 1, status: 'started', candidate: CANDIDATE, authoritativeTiming: false,
    scope: 'Post-run Firefox focused-harness semantic and actual parallel-worker evidence. XPI, generated bundle and running-browser identity are separately bound by the enclosing workflow. No timing or exhaustive persisted-byte claim.'};
try {
    const [raw, fixtureBytes, harnessBytes] = await Promise.all([readFile(values.report), readFile(values['fixture-lock']), readFile(values.harness)]);
    Object.assign(receipt, {reportSha256: hash(raw), fixtureLockSha256: hash(fixtureBytes), harnessSha256: hash(harnessBytes)});
    assert.equal(receipt.fixtureLockSha256, FIXTURE_LOCK_SHA256, 'Fixture lock differs from frozen schema');
    assert.equal(receipt.harnessSha256, HARNESS_SHA256, 'Firefox harness differs from frozen schema');
    const fixtures = record(JSON.parse(fixtureBytes).dictionaries, 'fixtures');
    const report = record(JSON.parse(raw), 'report');
    assert.equal(report.status, 'success', 'Firefox report did not succeed');
    assert.equal(report.skippedVerification, false, 'Firefox report skipped verification');
    assert.equal(report.skipReason, '', 'Firefox report has a skip reason or missing evidence');
    assert.equal(report.failureReason, '', 'Firefox report has a failure reason or missing evidence');
    assert(Array.isArray(report.phases) && report.phases.length > 0, 'Missing report phases');
    assert.equal(report.phaseCount, report.phases.length, 'Phase count does not reconcile');
    const phases = report.phases;
    const runtime = record(report.runtimeDiagnostics, 'runtimeDiagnostics');
    assert.equal(runtime.hasStorageGetDirectory, true, 'Runtime has no storage directory API');
    assert.equal(runtime.hasOpfsSahpoolVfs, true, 'Runtime has no SAH-pool VFS');
    assert.equal(runtime.openStorageMode, 'opfs-sahpool', 'Runtime did not use OPFS SAH-pool');
    const storage = assertOpenStorage(runtime.openStorageDiagnostics, 'runtime.openStorageDiagnostics');
    assert.equal(runtime.opfsSahpoolInstallResult, storage.opfsSahpoolInstallResult, 'Runtime installation evidence disagrees');
    assert(runtime.hasCreateSyncAccessHandle === true || storage.runtimeContext.hasCreateSyncAccessHandle === true,
        'Runtime has no sync-access-handle API');
    const runtimePhase = uniquePhase(phases, 'Runtime diagnostics');
    assert.deepEqual(trailingJson(runtimePhase, 'Firefox sahpool diagnostics: '), runtime, 'Runtime phase and report disagree');
    const jitendex = assertImport(phases, 'Jitendex', fixtures.jitendex);
    const jmdict = assertImport(phases, 'JMdict', fixtures.jmdict);
    const jitendexIntegrity = assertIntegrity(phases, 'Jitendex', jitendex);
    const jmdictIntegrity = assertIntegrity(phases, 'JMdict', jmdict);
    const baselineSearch = uniquePhase(phases, 'Verify baseline Jitendex search before concurrent import');
    positiveInteger(trailingJson(baselineSearch, 'Dedicated search tab returned counts: ').Jitendex, 'Baseline Jitendex hits');
    const concurrentSearch = uniquePhase(phases, 'Verify Jitendex search during JMdict import');
    positiveInteger(trailingJson(concurrentSearch, 'While slow JMdict import was in progress, dedicated search tab returned counts: ').Jitendex, 'Concurrent Jitendex hits');
    const backend = uniquePhase(phases, 'Post-import backend diagnostics');
    const diagnostics = trailingJson(backend, 'After both imports, backend diagnostics: ');
    positiveInteger(diagnostics.termResultCount, 'Post-import backend results');
    assert(Array.isArray(diagnostics.dictionaryInfo) && diagnostics.dictionaryInfo.length === 2, 'Expected exactly two installed dictionary summaries');
    for (const [name, imported, fixture] of [['Jitendex', jitendex, fixtures.jitendex], ['JMdict', jmdict, fixtures.jmdict]]) {
        const entries = diagnostics.dictionaryInfo.filter((item) => item?.title === imported.resultTitle);
        assert.equal(entries.length, 1, `${name}: missing or ambiguous persisted dictionary summary`);
        const entry = entries[0];
        assert.equal(entry.importSuccess, true, `${name}: persisted import did not succeed`);
        assert.equal(entry.revision, fixture.revision, `${name}: wrong persisted revision`);
        assert.equal(entry.counts?.terms?.total, fixture.termRows, `${name}: wrong persisted term count`);
        assert.equal(entry.counts?.media?.total, fixture.mediaFiles, `${name}: wrong persisted media count`);
    }
    const installed = uniquePhase(phases, 'Verify installed dictionaries list');
    assert(installed.details.startsWith('Opened dictionaries modal via ') &&
        installed.details.endsWith(' and confirmed dictionary list text includes Jitendex + JMdict'), 'Installed-list success evidence changed');
    const complete = uniquePhase(phases, 'Focused baseline complete');
    assert.equal(complete.details, 'Focused Firefox baseline for Jitendex + JMdict completed, including concurrent lookup and content-integrity verification; skipping update, batch-import, and hover stress paths.', 'Wrong focused scenario');
    const order = [runtimePhase.index, jitendex.phaseIndex, jitendexIntegrity.phaseIndex, baselineSearch.index,
        concurrentSearch.index, jmdict.phaseIndex, backend.index, jmdictIntegrity.phaseIndex, installed.index, complete.index];
    assert(order.every((value, index) => index === 0 || value > order[index - 1]), 'Required phases are out of order');
    Object.assign(receipt, {status: 'passed', phaseCount: phases.length, jitendex, jmdict,
        contentIntegrity: {jitendex: jitendexIntegrity, jmdict: jmdictIntegrity},
        concurrentLookupPhase: concurrentSearch.index, installedListPhase: installed.index, completionPhase: complete.index});
} catch (error) {
    receipt.status = 'failed';
    receipt.error = {name: error?.name ?? 'Error', message: String(error?.message ?? error)};
    process.exitCode = 1;
} finally {
    await mkdir(path.dirname(values.output), {recursive: true});
    await writeFile(values.output, `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx'});
    console.log(JSON.stringify(receipt, null, 2));
}
