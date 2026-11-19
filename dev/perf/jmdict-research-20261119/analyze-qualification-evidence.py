#!/usr/bin/env python3
"""Read archived research evidence. Does not run or alter any benchmark."""
import collections
import hashlib
import json
import statistics
import sys
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def metric_row(path):
    report = read(path)
    payload = next(p['data'] for p in report['phases'] if isinstance(p.get('data'), dict) and 'importDebug' in p['data'])
    phases = {p['phase']: p for p in payload['importDebug']['importerPhaseTimings']}
    fast = next(v for k, v in phases.items() if k.startswith('term-file-fast-path'))
    f = fast['details']
    final = phases['bulk-finalization']['details']
    timing = payload['browserTiming']
    row = {
        'observation': path.parent.name,
        'arm': path.parent.name[-1],
        'browserImportMs': timing['completedAtMs'] - timing['startedAtMs'],
        'archiveAndIndexMs': phases['archive-and-index']['elapsedMs'],
        'importDataBanksMs': phases['import-data-banks']['elapsedMs'],
        'termFileFastPathMs': fast['elapsedMs'],
        'bulkFinalizationMs': phases['bulk-finalization']['elapsedMs'],
    }
    keys = [
        'parserParseBankMs', 'parserParallelWorkerWallMs', 'parserSourceInflateMs',
        'dedupRecentSourceCacheMs', 'dedupRecentSourceCacheBytes',
        'importerChunkSinkMs', 'bulkAddTermsMs', 'parserOrderedSinkWaitMs',
        'parserResultDeliveryMs', 'parserResultCopyMs', 'parserLookupIndexEncodeMs',
        'sourceArchiveReadMs', 'contentAppendMs', 'contentCompressMs',
        'contentMetadataMs', 'contentMetadataPublishMs', 'contentMetadataIndexPublishMs',
        'dedupCanonicalScanMs', 'dedupScanMs', 'dedupExactCompareMs',
        'dedupNativeCallCount', 'dedupNativeFallbackCount',
        'dedupNativeCopiedInputBytes', 'dedupNativeCopiedOutputBytes',
        'parserMaxWasmHeapBytes', 'parserNativeLookupScratchReusedBytes',
        'parserMetaAllocatedBytes', 'parserEncodedContentBytes',
        'parserSourceCompressedBytes', 'parserSourceUncompressedBytes',
        'parserBorrowedContentResultCount', 'parserFusedAttempts', 'parserFusedFallbacks',
    ]
    row.update({k: f.get(k) for k in keys})
    # Publication contains recent-source caching; subtract per observation, not
    # independently aggregated medians, to retain the exclusive loop boundary.
    if isinstance(row['contentMetadataIndexPublishMs'], (int, float)) and isinstance(row['dedupRecentSourceCacheMs'], (int, float)):
        row['contentMetadataIndexPublishExclusiveMs'] = row['contentMetadataIndexPublishMs'] - row['dedupRecentSourceCacheMs']
    keys = [
        'termRecordEndImportSessionMs', 'termRecordEndImportSessionCloseWritableMs',
        'termRecordEndImportSessionFlushPendingWritesMs',
        'termRecordEndImportSessionAwaitQueuedWritesMs',
        'termContentEndImportSessionMs', 'termContentEndImportSessionCloseWritableMs',
        'termContentTotalWriteBytes', 'termContentWriteCallCount',
        'termRecordLookupIndexWriteBytes', 'termRecordLookupIndexWriteCallCount',
    ]
    row.update({k: final.get(k) for k in keys})
    row['step4TermParseResidualMs'] = phases['import-data-banks']['details']['step4TermParseMs']
    return row


def describe(rows):
    output = {}
    for key in rows[0]:
        values = [r[key] for r in rows]
        if all(isinstance(v, (int, float)) for v in values):
            output[key] = {'median': statistics.median(values), 'minimum': min(values), 'maximum': max(values)}
    return output


def analyze_trace(path):
    events = read(path)['traceEvents']
    profiles = {}
    for e in events:
        if e.get('name') == 'Profile':
            profiles[(e['pid'], e['id'])] = {'pid': e['pid'], 'tid': e['tid'], 'id': e['id'], 'time': e['args']['data']['startTime'], 'nodes': {}, 'samples': []}
    for e in events:
        if e.get('name') != 'ProfileChunk':
            continue
        p = profiles[(e['pid'], e['id'])]
        data = e['args']['data']
        cpu = data.get('cpuProfile', {})
        p['nodes'].update((n['id'], n) for n in cpu.get('nodes', []))
        lines = data.get('lines', [])
        for i, (node, dt) in enumerate(zip(cpu.get('samples', []), data.get('timeDeltas', []))):
            p['time'] += dt
            p['samples'].append((p['time'], dt, node, lines[i] if i < len(lines) else None))

    output = []
    importer = None
    for p in profiles.values():
        nodes = p['nodes']
        urls = {n['callFrame'].get('url', '').split('/')[-1] for n in nodes.values()}
        if 'dictionary-database.js' in urls:
            role = 'dictionary-import-worker'
            importer = p
        elif 'term-bank-wasm-parser-worker.js' in urls:
            role = 'term-parser-worker'
        elif 'zstd-term-content-compression-worker.js' in urls:
            role = 'zstd-worker'
        elif 'sqlite3-opfs-async-proxy.js' in urls:
            role = 'sqlite-opfs-proxy-blocking-loop'
        elif 'dictionary-import-controller.js' in urls:
            role = 'settings-page'
        else:
            role = 'background-service-worker'
        count = collections.Counter()
        intervals = collections.Counter()
        cache_lines = collections.Counter()
        cache_line_intervals = collections.Counter()
        focused_lines = collections.defaultdict(collections.Counter)
        focused_intervals = collections.defaultdict(collections.Counter)
        native_post_counts = collections.Counter()
        native_post_intervals = collections.Counter()
        for timestamp, dt, node, line in p['samples']:
            frame = nodes[node]['callFrame']
            key = (frame.get('functionName', ''), frame.get('url', ''), frame.get('lineNumber', -1) + 1)
            count[key] += 1
            intervals[key] += dt / 1000
            if frame.get('functionName') == 'postMessage':
                parent = nodes.get(nodes[node].get('parent'), {}).get('callFrame', {})
                caller = (parent.get('functionName', ''), parent.get('url', ''), parent.get('lineNumber', -1) + 1, line)
                native_post_counts[caller] += 1
                native_post_intervals[caller] += dt / 1000
            if key[0] == '_cacheRecentPublishedTermContentSources':
                cache_lines[line] += 1
                cache_line_intervals[line] += dt / 1000
            if key[0] in [
                'copyRecentTermContentSource', '_registerInFlightTermContentSources',
                '_publishArtifactTermContentMetadata', '_resolveStagedArtifactTermContentIndex',
                '_tryPublishContiguousArtifactTermContentMetadata',
            ] or key[1].endswith('zstd-term-content.js') or (key[0] == '_scan' and key[1].endswith('term-content-canonical-scan.js')):
                focused_lines[key[0]][line] += 1
                focused_intervals[key[0]][line] += dt / 1000
        entry = {'pid': p['pid'], 'tid': p['tid'], 'profileId': p['id'], 'role': role, 'sampleCount': len(p['samples'])}
        negative_deltas = [dt for timestamp, dt, node, line in p['samples'] if dt < 0]
        entry['negativeSampleDeltaCount'] = len(negative_deltas)
        entry['negativeSampleDeltaTotalUs'] = sum(negative_deltas)
        entry['topSelfStackIntervals'] = [
            {'function': key[0], 'url': key[1], 'functionStartLine': key[2], 'samples': count[key], 'intervalMs': duration}
            for key, duration in intervals.most_common(40)
        ]
        if cache_lines:
            entry['cacheTopSampleLines'] = [
                {'line': line, 'samples': count, 'intervalMs': cache_line_intervals[line]}
                for line, count in cache_lines.most_common()
            ]
        if focused_lines:
            entry['focusedFunctionSampleLines'] = {
                name: [
                    {'line': line, 'samples': count, 'intervalMs': focused_intervals[name][line]}
                    for line, count in counts.most_common()
                ]
                for name, counts in focused_lines.items()
            }
        if native_post_counts:
            entry['nativePostMessageByCaller'] = [
                {'callerFunction': caller[0], 'callerUrl': caller[1], 'callerFunctionStartLine': caller[2], 'callSiteLine': caller[3], 'samples': native_post_counts[caller], 'intervalMs': duration}
                for caller, duration in native_post_intervals.most_common()
            ]
        output.append(entry)

    tail_evidence = None
    writer_timers = []
    if importer:
        events_on_thread = [e for e in events if (e.get('pid'), e.get('tid')) == (importer['pid'], importer['tid'])]
        installs = {e['args']['data']['timerId']: e for e in events_on_thread if e.get('name') == 'TimerInstall'}
        for e in events_on_thread:
            if e.get('name') != 'TimerFire':
                continue
            install = installs.get(e['args']['data']['timerId'])
            if not install:
                continue
            stack = install['args']['data'].get('stackTrace', [])
            if any(s.get('url', '').endswith('term-record-import-index-writer.js') for s in stack):
                writer_timers.append({'id': e['args']['data']['timerId'], 'installedTraceUs': install['ts'], 'firedTraceUs': e['ts'], 'installationToFireMs': (e['ts'] - install['ts']) / 1000, 'callbackTaskWallMs': e.get('dur', 0) / 1000, 'callbackTaskThreadMs': e.get('tdur', 0) / 1000})
        nodes = importer['nodes']
        matches = []
        for timestamp, dt, node, line in importer['samples']:
            n = nodes[node]
            frame = n['callFrame']
            parent = nodes.get(n.get('parent'), {}).get('callFrame', {})
            if frame.get('functionName') == 'flush' and parent.get('url', '').endswith('term-record-import-index-writer.js'):
                containing = [e for e in events_on_thread if e.get('name') == 'RunTask' and e['ts'] <= timestamp < e['ts'] + e.get('dur', 0)]
                matches.append({'sampleAtTraceUs': timestamp, 'sampleIntervalMs': dt / 1000, 'callSiteLine': line, 'parentFunctionStartLine': parent.get('lineNumber', -1) + 1, 'containingTask': [{'startTraceUs': e['ts'], 'wallMs': e['dur'] / 1000, 'threadCpuMs': e.get('tdur', 0) / 1000} for e in containing]})
        tail_evidence = matches
    return {'traceSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'profiles': output, 'writerYieldTimers': writer_timers, 'writerNativeFlushSamples': tail_evidence}


def main(root):
    root = Path(root)
    results = read(root / 'results.json')
    manifest = read(root / 'manifest.json')
    rows = [metric_row(p) for p in sorted(root.glob('pair-*/run-1.json'))]
    arms = {a: [r for r in rows if r['arm'] == a] for a in ['A', 'B']}
    paired = {}
    for key in describe(rows):
        pairs = [(a[key], b[key]) for a, b in zip(arms['A'], arms['B'])]
        paired[key] = {
            'medianDifference': statistics.median(b - a for a, b in pairs),
            'medianChangePercent': statistics.median((b / a - 1) * 100 for a, b in pairs if a) if any(a for a, b in pairs) else None,
            'equalWorkChangePercent': (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1) * 100 if sum(a for a, b in pairs) else None,
            'fasterPairs': sum(b < a for a, b in pairs),
            'pairCount': len(pairs),
        }
    output = {
        'sourceDirectory': str(root.resolve()),
        'complete': results['complete'],
        'sameProductControl': manifest['sameProductControl'],
        'changedPackageEntries': manifest['changedPackageEntries'],
        'sourceCommits': {k: v['gitSha'] for k, v in manifest['sources'].items()},
        'reportedSummary': results['summary'],
        'measuredObservations': rows,
        'allMeasured': describe(rows),
        'byArm': {a: describe(v) for a, v in arms.items()},
        'pairedMetrics': paired,
        'traces': {a: analyze_trace(root / f'trace-{a}' / 'run-1.trace.json') for a in ['A', 'B']},
        'interpretationLimits': [
            f'Ordinary effect estimates use the predetermined {len(arms["A"])} adjacent pairs only; warmup, controls, and traces are excluded.',
            'Phase details overlap and worker sums span parallel workers. Do not add them as independent wall-time contributions.',
            'Chrome ProfileChunk samples belong to Profile by (pid, profile id); ProfileChunk tid is the sampler thread, not the sampled worker.',
            'Self-stack sample intervals are elapsed sampling intervals, not CPU time. Blocking native calls, Atomics.wait, preemption, and profiler perturbation can dominate them.',
            'Native postMessage frames are attributed to their parent call sites separately; JavaScript self samples alone omit that work. Raw negative sample deltas are retained and counted, not silently repaired.',
            'RunTask tdur is per-thread CPU time; worker activities overlap in wall time.',
            'maxWasmHeapBytes describes a single maximum parser heap, not whole-process or whole-browser peak memory.',
            'Trace runs are diagnostic and not authoritative speed evidence.',
        ],
    }
    (root / 'analysis.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps({'analysis': str((root / 'analysis.json').resolve()), 'complete': output['complete'], 'summary': output['reportedSummary']}, indent=2))


if __name__ == '__main__':
    for argument in sys.argv[1:]:
        main(argument)
