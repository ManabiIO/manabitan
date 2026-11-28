#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify frozen diagnostic evidence; never acquire a browser observation."""
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import zipfile

HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(name):
    return json.loads((HERE / name).read_text())


def same_number(a, b):
    assert abs(a - b) <= 0.000001, (a, b)


def audit_ordinary(raw):
    report = json.loads(raw)
    found = []
    for phase in report['phases']:
        details = phase.get('details')
        if not isinstance(details, str) or 'debug=' not in details:
            continue
        debug, _ = json.JSONDecoder().raw_decode(details.split('debug=', 1)[1])
        found.extend(item for item in debug.get('importerPhaseTimings', []) if item['phase'].startswith('term-file-fast-path:'))
    unique = {json.dumps(item, sort_keys=True): item for item in found}
    assert len(unique) == 1
    phase = next(iter(unique.values()))
    details = phase['details']
    assert details['parserValidatedGlossaryReuseCount'] == 54641
    assert details['parserRecentContentDedupHitCount'] == 154416
    assert details['parserParallelWorkerCount'] == 3 and details['parserParallelGroupCount'] == 12
    assert details['parserBorrowedContentResultCount'] == 0
    critical = read('trace/jmdict-critical-path-audit.json')['ordinary']
    same_number(critical['fastTermMs'], phase['elapsedMs'])
    fields = {'serialSinkCallbackMs': 'importerChunkSinkMs', 'parallelWorkerWallMs': 'parserParallelWorkerWallMs',
              'aggregateParseBankMs': 'parserParseBankMs', 'aggregateOrderedSinkWaitMs': 'parserOrderedSinkWaitMs',
              'aggregateResultDeliveryMs': 'parserResultDeliveryMs', 'sourceReadWallMs': 'parserParallelSourceReadWallMs',
              'contentCompressMs': 'contentCompressMs', 'contentMetadataPublishMs': 'contentMetadataPublishMs',
              'metadataIndexPublishMs': 'contentMetadataIndexPublishMs', 'recentCacheMs': 'dedupRecentSourceCacheMs',
              'recordFieldEncodeMs': 'termRecordFieldEncodeMs'}
    for target, source in fields.items():
        same_number(critical[target], details[source])
    same_number(critical['outsideSerialSinkCallbackMs'], phase['elapsedMs'] - details['importerChunkSinkMs'])


def audit_points(events, origin):
    start = next(event for event in events if event['name'] == 'Profile' and event.get('tid') == 3714)
    chunks = sorted((event for event in events if event['name'] == 'ProfileChunk' and
                     (event['pid'], event.get('id')) == (start['pid'], start['id'])), key=lambda event: event['ts'])
    nodes, parents = {}, {}
    for event in chunks:
        for node in event['args']['data'].get('cpuProfile', {}).get('nodes', []):
            nodes[node['id']] = node
            if 'parent' in node:
                parents[node['id']] = node['parent']
            for child in node.get('children', []):
                parents[child] = node['id']
    cursor = start['args']['data']['startTime']
    points = []
    for event in chunks:
        data = event['args']['data']
        samples = data.get('cpuProfile', {}).get('samples', [])
        assert len(samples) == len(data.get('timeDeltas', []))
        for index, (identity, delta) in enumerate(zip(samples, data.get('timeDeltas', []))):
            cursor += delta
            frame = nodes[identity].get('callFrame', {})
            ancestors, seen = set(), set()
            current = identity
            while current in nodes and current not in seen:
                seen.add(current)
                ancestors.add(nodes[current].get('callFrame', {}).get('functionName', ''))
                current = parents.get(current)
            points.append({'ms': (cursor - origin) / 1000, 'delta': delta, 'name': frame.get('functionName', ''),
                           'url': frame.get('url', '').rsplit('/', 1)[-1], 'line': data.get('lines', [None] * len(samples))[index],
                           'ancestors': ancestors})
    assert len(points) == 4795
    assert sum(point['delta'] < 0 for point in points) == 131
    assert sum(point['delta'] for point in points if point['delta'] < 0) == -34595
    saved = read('trace/coordinator-message-gap-points.json')
    assert saved['originTs'] == origin and saved['profileId'] == start['id']
    for window in saved['windows']:
        selected = [point for point in points if window['startMs'] <= point['ms'] < window['endMs']]
        assert len(selected) == window['sampleCount']
        assert sum(point['delta'] < 0 for point in selected) == window['negativeDeltaSamples']
        own = Counter((point['name'], point['url'], point['line']) for point in selected)
        ancestors = Counter(name for point in selected for name in point['ancestors'])
        for item in window['self']:
            assert item['samples'] == own[item['name'], item['url'], item['line']]
        for item in window['ancestors']:
            assert item['samples'] == ancestors[item['name']]


def audit_census():
    report = read('census/jmdict-suffix-production-groups.json')
    assert report['complete'] and report['node'] == 'v22.22.0'
    assert report['source']['baselineCommit'] == '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
    assert report['source']['candidateCommit'] == '38031a752b26c9b630e5f2f1d45e780786656c74'
    assert report['provenance']['runnerSha256'] == sha((HERE / 'census/suffix-production-groups.mjs').read_bytes())
    assert report['provenance']['upstreamCensusSha256'] == sha((HERE / 'census/suffix-window4.mjs').read_bytes())
    assert report['provenance']['corpusReplaySha256'] == sha((HERE / 'census/corpus-replay.mjs').read_bytes())
    assert report['provenance']['archiveSha256'] == '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f'
    assert report['policy'] == {'parserWorkers': 3, 'groupsPerWorker': 4, 'targetBytes': 25165824,
                                'window': 4, 'previousGlossaryMinBytes': 512, 'admissionMatches': 4,
                                'probeBudget': 4, 'resetAtGroupBoundary': True, 'retainAcrossBankBoundary': True}
    assert [group['groupIndex'] for group in report['groups']] == list(range(12))
    banks = []
    for group in report['groups']:
        assert group['banks'] == len(group['bankInputs'])
        assert group['rows'] == sum(bank['rows'] for bank in group['bankInputs'])
        assert group['sourceBytes'] == sum(bank['sourceBytes'] for bank in group['bankInputs'])
        assert group['baselineReuseRows'] + group['suffixReuseRows'] == group['candidateReuseRows']
        assert group['baselineSkippedGlossaryBytes'] + group['suffixSkippedGlossaryBytes'] == group['candidateSkippedGlossaryBytes']
        assert sum(group['admittedLookbackRows']) == group['rows']
        for kind, successes in [('baselineProbes', 'baselineReuseRows'), ('suffixProbes', 'suffixReuseRows')]:
            probes = group[kind]
            assert probes['candidates'] == group[successes] + sum(probes[field] for field in (
                'boundsRejects', 'firstByteRejects', 'glossaryTailRejects', 'glossaryMiddleRejects',
                'suffixTailRejects', 'fullEqualityRejects'))
            assert probes['fullEqualityCalls'] == group[successes] + probes['fullEqualityRejects']
        banks.extend(group['bankInputs'])
    assert [bank['filename'] for bank in banks] == [f'term_bank_{index}.json' for index in range(1, 54)]
    totals = report['totals']
    for key, value in totals.items():
        assert value == sum(group[key] for group in report['groups']), key
    assert (totals['rows'], totals['sourceBytes'], totals['baselineReuseRows'], totals['rawContentMatches']) == (528299, 171617523, 54641, 154416)
    assert (totals['suffixReuseRows'], totals['suffixSkippedGlossaryBytes'], totals['suffixSkippedGrammarTailBytes']) == (106651, 25012079, 1296867)
    analysis = read('census/analysis.json')
    assert analysis['sourceReportSha256'] == sha((HERE / 'census/jmdict-suffix-production-groups.json').read_bytes())
    for kind in ('baselineProbes', 'suffixProbes'):
        assert analysis['probeTotals'][kind] == {key: sum(group[kind][key] for group in report['groups']) for key in report['groups'][0][kind]}
    receipt = read('census/suffix-production-groups-20261128-receipt.json')
    assert receipt['exitCode'] == 0 and receipt['signal'] is None and receipt['noTimingClaim']
    return totals


def audit_trace(raw):
    trace = json.loads(raw)
    events = trace.get('traceEvents', trace) if isinstance(trace, dict) else trace
    sends = {}
    receives = {}
    for event in events:
        identity = event.get('args', {}).get('data', {}).get('traceId')
        if not identity:
            continue
        if event['name'] == 'SchedulePostMessage':
            assert identity not in sends
            sends[identity] = event
        elif event['name'] == 'HandlePostMessage':
            assert identity not in receives
            receives[identity] = event
    urls = {'term-bank-wasm-parser.js', 'term-bank-wasm-parser-worker.js',
            'zstd-term-content.js', 'zstd-term-content-compression-worker.js'}
    messages = []
    for identity, send in sends.items():
        if identity not in receives:
            continue
        stack = send.get('args', {}).get('data', {}).get('stackTrace', [])
        frame = stack[0] if stack else {}
        url = frame.get('url', '').rsplit('/', 1)[-1]
        if url not in urls:
            continue
        receive = receives[identity]
        messages.append({'url': url, 'fn': frame.get('functionName', ''), 'line': frame.get('lineNumber'),
                         'sent': send['ts'], 'sender': send['tid'], 'received': receive['ts'],
                         'receiver': receive['tid'], 'handlerDurationUs': receive.get('dur', 0), 'traceId': identity})
    messages.sort(key=lambda message: message['sent'])
    assert messages == read('trace/jmdict-trace-message-events.json')['messages']
    parse_jobs = [message for message in messages if message['url'] == 'term-bank-wasm-parser.js' and message['line'] == 3797]
    replies = [message for message in messages if message['url'] == 'term-bank-wasm-parser-worker.js' and message['line'] == 230]
    initial = [message for message in messages if message['url'] == 'term-bank-wasm-parser.js' and message['line'] == 3635]
    assert len(parse_jobs) == len(replies) == 12 and len(initial) == 3
    origin = min(message['sent'] for message in parse_jobs)
    assert origin == 74762565
    jobs = []
    queues = defaultdict(list)
    for message in parse_jobs:
        matching = [reply for reply in replies if reply['sender'] == message['receiver'] and
                    message['received'] <= reply['sent'] <= message['received'] + message['handlerDurationUs'] + 2000]
        assert len(matching) == 1
        job = {'request': message, 'reply': matching[0]}
        jobs.append(job)
        queues[message['receiver']].append(job)
    for index, message in enumerate(initial):
        queues[message['receiver']][0]['group'] = index
    next_group = 3
    for job in sorted(jobs, key=lambda item: item['reply']['received']):
        assert 'group' in job
        queue = queues[job['request']['receiver']]
        ordinal = queue.index(job)
        if ordinal + 1 < len(queue):
            queue[ordinal + 1]['group'] = next_group
            next_group += 1
    assert next_group == 12
    critical = read('trace/jmdict-critical-path-audit.json')
    assert critical['rawTraceSha256'] == sha(raw)
    for job, group in zip(sorted(jobs, key=lambda item: item['group']), critical['sourceInferredGroups']):
        request, reply = job['request'], job['reply']
        assert group['sourceGroupIndex'] == job['group']
        assert group['workerTid'] == request['receiver']
        assert group['dispatchTraceId'] == request['traceId'] and group['replyTraceId'] == reply['traceId']
        same_number(group['dispatchMs'], (request['sent'] - origin) / 1000)
        same_number(group['replyPostedMs'], (reply['sent'] - origin) / 1000)
        same_number(group['replyHandledMs'], (reply['received'] - origin) / 1000)
    compression = read('trace/jmdict-compression-batch-timeline.json')
    pending = [message.copy() for message in messages if message['url'] == 'zstd-term-content.js' and message['line'] == 386]
    assert len(pending) == 103
    for tid in {message['receiver'] for message in pending}:
        requests = [message for message in pending if message['receiver'] == tid]
        results = [message for message in messages if message['sender'] == tid and message['url'] == 'zstd-term-content-compression-worker.js' and message['line'] == 86]
        consumed = [message for message in messages if message['sender'] == tid and message['url'] == 'zstd-term-content-compression-worker.js' and message['line'] == 68]
        assert len(requests) == len(results) == len(consumed)
        for request, result, source_consumed in zip(requests, results, consumed):
            request.update(reply=result, sourceConsumed=source_consumed)
    assert pending == compression['jobs']
    batches = []
    for job in pending:
        if not batches or job['sent'] - batches[-1][-1]['sent'] > 5000:
            batches.append([])
        batches[-1].append(job)
    assert len(batches) == 12
    for index, (jobs_in_batch, stored) in enumerate(zip(batches, compression['batches'])):
        assert stored['batch'] == index + 1 and stored['jobs'] == len(jobs_in_batch)
        expected = {'dispatchFirstMs': min(job['sent'] for job in jobs_in_batch),
                    'dispatchLastMs': max(job['sent'] for job in jobs_in_batch),
                    'lastResultPostedMs': max(job['reply']['sent'] for job in jobs_in_batch),
                    'lastResultReceivedMs': max(job['reply']['received'] for job in jobs_in_batch),
                    'lastSourceConsumedReceivedMs': max(job['sourceConsumed']['received'] for job in jobs_in_batch)}
        for key, value in expected.items():
            same_number(stored[key], (value - origin) / 1000)
        same_number(stored['dispatchToLastReceiveMs'], stored['lastResultReceivedMs'] - stored['dispatchFirstMs'])
        same_number(stored['lastPostedToLastReceivedMs'], stored['lastResultReceivedMs'] - stored['lastResultPostedMs'])
        assert critical['sourceInferredGroups'][index]['compressionBatch'] == stored
        ready = None if index == 0 else critical['sourceInferredGroups'][index]['replyHandledMs'] < compression['batches'][index - 1]['lastResultReceivedMs']
        assert critical['sourceInferredGroups'][index]['receivedBeforePreviousCompressionLastHandled'] == ready
    gap = read('trace/coordinator-required-group-gap.json')
    overlap = sum(max(0, min(event['ts'] + event.get('dur', 0), origin + 720678) - max(event['ts'], origin + 660016))
                  for event in events if event.get('tid') == 3714 and event.get('ph') == 'X' and event['name'] == 'RunTask') / 1000
    same_number(overlap, 0.731)
    same_number(gap['allRunTaskOverlapMs'], overlap)
    same_number(critical['visibleMidstreamWait']['noCoordinatorRunTaskMs'], 60.662 - overlap)
    audit_points(events, origin)
    return {'parserJobs': 12, 'compressionJobs': 103, 'compressionBatches': 12,
            'noCoordinatorRunTaskMsInRequiredGroup4Gap': 60.662 - overlap}


def main():
    if not __debug__:
        raise RuntimeError('Do not disable audit assertions with -O or PYTHONOPTIMIZE')
    manifest = read('manifest.json.txt')
    for name, identity in manifest['files'].items():
        data = (HERE / name).read_bytes()
        assert len(data) == identity['bytes'] and sha(data) == identity['sha256'], name
    with zipfile.ZipFile(HERE / 'original-jmdict-artifact.zip') as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert set(archive.namelist()) == set(manifest['originalArtifact']['members'])
        assert archive.testzip() is None
        for info in archive.infolist():
            data = archive.read(info)
            assert {'bytes': len(data), 'sha256': sha(data), 'crc32': info.CRC} == manifest['originalArtifact']['members'][info.filename]
        assert archive.read('source.txt').decode().split() == ['9e10d3b3fcf66d344ab31bc42c9b522fa5215da2', 'd99ea4d04658f7ec1c76acdc5f3684594212a471']
        audit_ordinary(archive.read('ordinary/run-1.json'))
        trace = audit_trace(archive.read('trace/run-1.trace.json'))
    census = audit_census()
    print(json.dumps({'status': 'PASS', 'scope': 'Frozen trace and exact-token diagnostic counts; no performance qualification',
                      'trace': trace, 'census': census}, indent=2))


if __name__ == '__main__':
    main()
