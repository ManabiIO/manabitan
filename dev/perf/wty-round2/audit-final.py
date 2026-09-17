from pathlib import Path
import json, math, statistics, sys

root = Path(sys.argv[1])
s = json.loads((root / 'summary.json').read_text())
assert s['status'] == 'success'
assert s['blocks'] == 6
assert s['flags'] == {'experimentalSkipFusedProbe': True}
assert len(s['plan']) == len(s['observations']) == 38
assert s['fixture']['sha256'] == 'b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5'
rows, invariants = [], []
for planned, observed in zip(s['plan'], s['observations']):
    for key in ['id', 'kind', 'block', 'arm', 'flags']:
        assert observed[key] == planned[key]
    report = json.loads((root / observed['report']).read_text())
    assert report['status'] == 'success' and report['skippedVerification'] is False
    bench = report['benchmark']
    assert bench['dictionary'] == 'wty-en-en'
    assert bench['pinnedDictionaries'] and bench['productionImportDefaults'] and bench['authoritativeTiming']
    assert bench['importFlags'] == planned['flags']
    for key in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling']:
        assert bench[key] is False
    validation = bench['validation']
    assert validation['termRows'] == 1643040 and validation['revision'] == '2026.08.29'
    assert validation['title'] == 'wty-en-en' and validation['contentReadable'] and validation['probeCount'] == 12
    phases = [p for p in report['phases'] if p['name'] == 'wty-en-en: total import']
    assert len(phases) == 1
    data = phases[0]['data']
    timing, debug = data['browserTiming'], data['importDebug']
    assert timing['trigger'] == 'file-input-change' and timing['errorCount'] == 0
    assert timing['sequence'] == timing['sequenceBefore'] + 1
    ms = timing['completedAtMs'] - timing['startedAtMs']
    assert ms > 0 and math.isclose(ms, observed['totalImportMs'], abs_tol=1e-7)
    assert debug['errorCount'] == debug['addSettingsErrorCount'] == 0
    assert debug['usesFallbackStorage'] is False and debug['openStorageDiagnostics']['mode'] == 'opfs-sahpool'
    parser = next(p['details'] for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:'))
    expected = {key: planned['flags'].get(key) is True for key in parser['parserExperiments']}
    assert parser['parserExperiments'] == expected
    assert all(key in expected for key in planned['flags'])
    on = planned['flags'].get('experimentalSkipFusedProbe') is True
    assert parser['parserFusedAttempts'] == parser['parserFusedFallbacks'] == (0 if on else 12)
    assert parser['parserDiscardedFusedRows'] == (0 if on else 226900)
    final = next(p['details'] for p in debug['importerPhaseTimings'] if p['phase'] == 'bulk-finalization')
    work = {key: parser[key] for key in ['batchedFileCount', 'rows', 'chunkCount', 'sourceBatchMaxBytes', 'sourcePrefetchMaxBytes', 'sourceFirstBatchFileCount', 'sourceFirstBatchEstimatedBytes', 'parserSourceTransferredBytes', 'parserSourceCompressedBytes', 'parserSourceUncompressedBytes', 'parserParallelWorkerCount', 'parserParallelPipelineGroupsPerWorker', 'parserParallelGroupCount', 'dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount']}
    work.update({key: final[key] for key in ['termContentTotalWriteBytes', 'termRecordTotalWriteBytes', 'termRecordLookupIndexWriteBytes']})
    invariants.append(work)
    rows.append({**planned, 'ms': ms})
assert all(work == invariants[0] for work in invariants)
effects, controls, block_effects = [], [], []
for block in range(1, 7):
    group = [r for r in rows if r['kind'] == 'measured' and r['block'] == block]
    assert [r['arm'] for r in group] == ['B', 'A', 'A', 'B']
    for i in (0, 2):
        pair = group[i:i + 2]
        a = next(r['ms'] for r in pair if r['arm'] == 'A')
        b = next(r['ms'] for r in pair if r['arm'] == 'B')
        effects.append(100 * (b / a - 1))
    block_effects.append(100 * (sum(r['ms'] for r in group if r['arm'] == 'B') / sum(r['ms'] for r in group if r['arm'] == 'A') - 1))
    pair = [r for r in rows if r['kind'] == 'control' and r['block'] == block]
    controls.append(100 * (next(r['ms'] for r in pair if r['arm'] == 'B') / next(r['ms'] for r in pair if r['arm'] == 'A') - 1))
median = statistics.median(effects)
noise = statistics.median(map(abs, controls))
a = sum(r['ms'] for r in rows if r['kind'] == 'measured' and r['arm'] == 'A')
b = sum(r['ms'] for r in rows if r['kind'] == 'measured' and r['arm'] == 'B')
equal_work = 100 * (b / a - 1)
assert all(math.isclose(x, y, abs_tol=1e-7) for x, y in zip(effects, s['results']['pairedPercent']))
assert math.isclose(median, s['results']['pairedMedianPercent'], abs_tol=1e-7)
assert math.isclose(equal_work, s['results']['equalWorkPercent'], abs_tol=1e-7)
gate = median < -1 and equal_work < -1 and sum(p < 0 for p in effects) >= 10 and -median > noise
result = {'audit': 'success', 'confirmedWinner': gate, 'rule': 'median <-1%, equal work <-1%, at least 10/12 faster, effect larger than median absolute A/A', 'observations': len(rows), 'pairedMedianPercent': median, 'equalWorkPercent': equal_work, 'fasterPairs': sum(p < 0 for p in effects), 'controlAbsoluteMedian': noise, 'blockPercent': block_effects, 'fasterBlocks': sum(p < 0 for p in block_effects), 'workInvariants': invariants[0]}
(root / 'publication-gate.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
assert gate, 'Candidate did not satisfy the predeclared final-source publication gate'
