"""Verify copied bytes and receipt consistency without executing benchmarks."""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics


def sha(data):
    return hashlib.sha256(data).hexdigest()


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10), (actual, expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compare-originals', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    read = lambda name: json.loads((root / name).read_text())
    manifest = read('package-manifest.json')
    listed = {item['path'] for item in manifest['files']}
    actual = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()} - {'package-manifest.json'}
    assert listed == actual, {'missing': sorted(listed - actual), 'unlisted': sorted(actual - listed)}
    original_count = 0
    for item in manifest['files']:
        data = (root / item['path']).read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], item['path']
        if 'original' in item:
            original_count += 1
            preserved = gzip.decompress(data) if item.get('encoding') == 'gzip' else data
            assert len(preserved) == item['original']['bytes']
            assert sha(preserved) == item['original']['sha256']
            if args.compare_originals:
                assert preserved == Path(item['original']['path']).read_bytes(), item['path']

    validation_rows = 0
    for dictionary in ['jmdict', 'jitendex', 'vndb']:
        capture_path = f'validation/{dictionary}/manifest.json'
        capture = read(capture_path)
        receipt = read(f'validation/{dictionary}-comparison.json')
        assert receipt['inputManifestSha256'] == sha((root / capture_path).read_bytes())
        assert capture['runnerSha256'] == sha((root / 'validation/prepare-inputs.mjs').read_bytes())
        assert receipt['runnerSha256'] == sha((root / 'validation/compare-validation.mjs').read_bytes())
        assert receipt['oracles']['baseline'] == receipt['oracles']['candidate']
        assert receipt['rows'] == sum(g['rowCount'] for g in capture['groups']) == receipt['oracles']['baseline']['rows']
        assert receipt['contentRuns'] == sum(g['contentRuns'] for g in capture['groups'])
        assert receipt['repeatedValidationsRemoved'] == receipt['rows'] - receipt['contentRuns']
        assert len(receipt['observations']) == 24
        for metric, summary in receipt['summary'].items():
            a, b = [], []
            for pair in range(12):
                rows = [r for r in receipt['observations'] if r['pair'] == pair]
                assert [r['label'] for r in rows] == (['baseline', 'candidate'] if pair % 2 == 0 else ['candidate', 'baseline'])
                assert all(r['repetitions'] == 5 for r in rows)
                a.append(next(r[metric] for r in rows if r['label'] == 'baseline'))
                b.append(next(r[metric] for r in rows if r['label'] == 'candidate'))
            deltas = [(y / x - 1) * 100 for x, y in zip(a, b)]
            close(summary['baselineMedian'], statistics.median(a))
            close(summary['candidateMedian'], statistics.median(b))
            close(summary['pairMedianChangePercent'], statistics.median(deltas))
            assert summary['candidateFasterPairs'] == sum(d < 0 for d in deltas)
        validation_rows += receipt['rows']
    assert validation_rows == 7610700

    for prefix in ['', 'direct-buffer-']:
        observations = read(f'media/{prefix}observations.json')
        summary = read(f'media/{prefix}results.json')
        schedule = [('warmup', 0, arm) for arm in 'AB']
        schedule += [('control-before', pair, arm) for pair in range(2) for arm in 'AA']
        schedule += [('candidate', pair, arm) for pair in range(6) for arm in ('AB' if pair % 2 == 0 else 'BA')]
        schedule += [('control-after', pair, arm) for pair in range(2) for arm in 'AA']
        assert [(r['kind'], r['pair'], r['arm']) for r in observations] == schedule
        for key in ['referencesSha256', 'diagnosticSamples', 'references']:
            assert all(row[key] == observations[0][key] for row in observations)
        assert observations[0]['references'] == 146570 and summary['outputParity']
        for kind in ['candidate', 'control-before', 'control-after']:
            deltas = []
            for result in summary[kind]['pairs']:
                rows = [r for r in observations if r['kind'] == kind and r['pair'] == result['pair']]
                if kind == 'candidate':
                    a = next(r for r in rows if r['arm'] == 'A')
                    b = next(r for r in rows if r['arm'] == 'B')
                else:
                    a, b = rows
                assert result['baselineMs'] == a['elapsedMs'] and result['comparisonMs'] == b['elapsedMs']
                delta = (b['elapsedMs'] / a['elapsedMs'] - 1) * 100
                close(result['changePercent'], delta)
                deltas.append(delta)
            close(summary[kind]['medianChangePercent'], statistics.median(deltas))
    retention = read('media/retention.json')
    assert ''.join(r['arm'] for r in retention) == 'ABBAAB'
    assert [r['index'] for r in retention] == list(range(6))
    assert len({r['referencesSha256'] for r in retention}) == 1
    for row in retention:
        assert row['references'] == 146570
        if row['arm'] == 'B':
            assert row['retainedKeyBuffers'] == 340 and row['retainedDiagnosticArenas'] == 170
            assert row['retainedKeyBufferBytes'] == 4207278 and row['retainedSpanBufferBytes'] == 2347600

    media = read('media/full-media-parity/results.json')
    baseline = read('media/full-media-parity/baseline.json')
    candidate = read('media/full-media-parity/candidate.json')
    assert media['correctnessOnly'] and media['fullPayloadParity'] and media['missingAndCorruptErrorParity']
    for key in media['comparedKeys'] + ['fixture', 'capture', 'wasm']:
        assert baseline[key] == candidate[key], key
    assert media['images'] == baseline['records'] == 146570
    assert baseline['checkedIndexSlots'] == 163034 and baseline['blobBytes'] == 195649882
    provenance = read('media/provenance.json')
    for label, arm in [('baseline', baseline), ('candidate', candidate)]:
        for filename, digest in provenance[label]['files'].items():
            assert arm['sourceHashes'][filename] == digest
    assert read('media/identity.json')['patchSha256'] == sha((root / 'media/pooled-candidate.patch').read_bytes())

    inputs_path = root / 'crc/crc-words-screen/inputs.json'
    inputs = json.loads(inputs_path.read_text())
    status = read('crc/crc-words-screen/qualification-status.json')
    assert status['verdict'] == 'Unqualified local performance experiment; no production speed claim'
    assert inputs['candidatePatchSha256'] == sha((root / 'crc/crc-words-screen/candidate.patch').read_bytes())
    for filename in ['screen-1.json', 'screen-long-1.json']:
        screen = read(f'crc/crc-words-screen/{filename}')
        lines = [json.loads(line) for line in (root / f'crc/crc-words-screen/{filename}.jsonl').read_text().splitlines()]
        assert screen['status'] == 'success' and screen['inputs'] == inputs
        assert screen['plan']['inputsSha256'] == sha(inputs_path.read_bytes())
        assert lines == [{'plan': screen['plan']}] + screen['observations']
        assert len(screen['observations']) == 96
        if 'harnessSha256' in screen['plan']:
            assert screen['plan']['harnessSha256'] == sha((root / 'crc/crc-screen-long.mjs').read_bytes())
        schedule = [(comparison, corpus, pair, arm)
                    for comparison in ['AA', 'AB'] for corpus in inputs['corpora']
                    for pair in range(8) for arm in ('AB' if pair % 2 == 0 else 'BA')]
        assert [(r['comparison'], r['corpus'], r['pair'], r['arm']) for r in screen['observations']] == schedule
        for row in screen['observations']:
            assert row['crc32'] == [b['crc32'] for b in inputs['corpora'][row['corpus']]['banks']]
        for comparison, corpora in screen['summaries'].items():
            for corpus, summary in corpora.items():
                a, b, deltas, wall = [], [], [], []
                for pair in range(8):
                    rows = [r for r in screen['observations'] if r['comparison'] == comparison and r['corpus'] == corpus and r['pair'] == pair]
                    first = next(r for r in rows if r['arm'] == 'A')
                    second = next(r for r in rows if r['arm'] == 'B')
                    a.append(first['threadCpuMs']); b.append(second['threadCpuMs'])
                    deltas.append((second['threadCpuMs'] / first['threadCpuMs'] - 1) * 100)
                    wall.append((second['elapsedMs'] / first['elapsedMs'] - 1) * 100)
                close(summary['medianPairedCpuPercent'], statistics.median(deltas))
                close(summary['equalWorkCpuPercent'], (sum(b) / sum(a) - 1) * 100)
                close(summary['medianPairedWallPercent'], statistics.median(wall))
                assert summary['fasterCpuPairs'] == sum(d < 0 for d in deltas)
        assert status['artifacts'][filename]['plan'] == screen['plan']
        assert status['artifacts'][filename]['summaries'] == screen['summaries']

    integration = read('integration/integration-receipt.json')
    assert integration['validation']['passedTests'] == 782 and integration['validation']['buildExitCode'] == 0
    for filename, identity in integration['files'].items():
        data = (root / 'integration' / filename).read_bytes()
        assert len(data) == identity['bytes'] and sha(data) == identity['sha256']
    identity = read('integration/reserved-layout-witness-file-identity.json')
    compressed = (root / 'integration' / identity['storedFilename']).read_bytes()
    decoded = gzip.decompress(compressed)
    assert sha(compressed) == identity['storedSha256'] and sha(decoded) == identity['originalSha256']
    layout = json.loads(decoded)
    assert layout['status'] == 'success'
    assert layout['plan']['harnessSha256'] == sha((root / 'integration/reserved-layout-witness.mjs').read_bytes())
    assert layout['plan']['inputsSha256'] == sha(inputs_path.read_bytes())
    assert sum(g['rowCount'] for g in layout['groups']) == 5448
    assert sum(g['uniqueSpanCount'] for g in layout['groups']) == 4534
    for group in layout['groups']:
        assert group['fullDecodedBytesVerified'] and len(group['references']) == group['uniqueSpanCount']
        for reference in group['references']:
            a = {k: v for k, v in reference['ordinary'].items() if k != 'blockOffset'}
            b = {k: v for k, v in reference['reserved'].items() if k != 'blockOffset'}
            assert a == b and a['entryLength'] == reference['length']
            assert reference['reserved']['blockOffset'] - reference['ordinary']['blockOffset'] == group['referenceBytes']

    held = read('held-media-batch/results.json')
    observations = read('held-media-batch/observations.json')
    assert held['outputParity'] and held['crcErrorParity'] and len(observations) == 10
    deltas = []
    for pair in held['pairs']:
        rows = [r for r in observations if r['kind'] == 'candidate' and r['pair'] == pair['pair']]
        a = next(r for r in rows if r['arm'] == 'A')['elapsedMs']
        b = next(r for r in rows if r['arm'] == 'B')['elapsedMs']
        close(pair['changePercent'], (b / a - 1) * 100)
        deltas.append(pair['changePercent'])
    close(held['medianChangePercent'], statistics.median(deltas))
    errors = read('held-media-batch/errors.json')
    assert errors[0]['errorName'] == errors[1]['errorName'] and errors[0]['error'] == errors[1]['error']
    print(json.dumps({'verified': True, 'files': len(manifest['files']), 'originalFiles': original_count,
                      'payloadBytes': sum(f['bytes'] for f in manifest['files']), 'validationRows': validation_rows,
                      'crcObservations': 192, 'mediaTimingObservations': 44, 'retentionSnapshots': 6,
                      'fullMediaImages': 146570, 'integrationTests': 782, 'layoutSpans': 4534}, indent=2))


if __name__ == '__main__':
    main()
