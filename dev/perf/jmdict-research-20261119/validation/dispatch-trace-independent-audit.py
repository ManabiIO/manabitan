import collections
import hashlib
import json
from pathlib import Path

ROOT = Path('/workspace/scratch/cb98f2e06b71')
RAW = ROOT / 'manabitan/builds/perf/remote-dispatch-only'
OUT = ROOT / 'dispatch-trace-independent-audit.json'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def decode(path):
    raw = path.read_bytes()
    events = json.loads(raw)['traceEvents']
    profiles = {}
    for event_index, event in enumerate(events):
        if event.get('name') not in ('Profile', 'ProfileChunk'):
            continue
        key = event['pid'], event['id']
        profile = profiles.setdefault(key, {'starts': [], 'nodes': {}, 'chunks': [], 'conflictingNodeIds': []})
        if event['name'] == 'Profile':
            profile['starts'].append(event)
        else:
            profile['chunks'].append((event_index, event))
            for node in event['args']['data'].get('cpuProfile', {}).get('nodes', []):
                previous = profile['nodes'].get(node['id'])
                if previous is not None and previous != node:
                    profile['conflictingNodeIds'].append(node['id'])
                profile['nodes'][node['id']] = node
    matches = [(key, profile) for key, profile in profiles.items() if any(
        node.get('callFrame', {}).get('url', '').endswith('/dictionary-database.js')
        for node in profile['nodes'].values()
    )]
    assert len(matches) == 1
    (pid, profile_id), profile = matches[0]
    assert len(profile['starts']) == 1 and not profile['conflictingNodeIds']
    start = profile['starts'][0]
    nodes = profile['nodes']
    target_nodes = {}
    for node in nodes.values():
        frame = node.get('callFrame', {})
        parent = nodes.get(node.get('parent'), {})
        caller = parent.get('callFrame', {})
        if frame.get('functionName') == 'postMessage' and not frame.get('url') and caller.get('url', '').endswith('/zstd-term-content.js'):
            chain = []
            ancestor = node
            while ancestor:
                chain.append(ancestor)
                ancestor = nodes.get(ancestor.get('parent'))
            target_nodes[node['id']] = {'nativeFrame': node, 'ancestorChain': chain}
    assert len(target_nodes) == 1
    samples = []
    timestamp = start['args']['data']['startTime']
    chunks = sorted(profile['chunks'], key=lambda pair: (pair[1]['ts'], pair[0]))
    file_order_monotonic = [i for i, _ in chunks] == [i for i, _ in profile['chunks']]
    for event_index, event in chunks:
        data = event['args']['data']
        sample_ids = data.get('cpuProfile', {}).get('samples', [])
        deltas = data.get('timeDeltas', [])
        lines = data.get('lines', [])
        assert len(sample_ids) == len(deltas)
        for chunk_sample_index, (node_id, delta) in enumerate(zip(sample_ids, deltas)):
            assert node_id in nodes
            timestamp += delta
            samples.append({
                'sampleIndex': len(samples), 'traceEventIndex': event_index,
                'chunkSampleIndex': chunk_sample_index, 'nodeId': node_id,
                'timestampUs': timestamp, 'rawDeltaUs': delta,
                'callSiteLine': lines[chunk_sample_index] if chunk_sample_index < len(lines) else None,
            })
    targets = [sample for sample in samples if sample['nodeId'] in target_nodes]
    call_sites = set(sample['callSiteLine'] for sample in targets)
    js_self = [sample for sample in samples if (
        nodes[sample['nodeId']]['callFrame'].get('url', '').endswith('/zstd-term-content.js')
        and sample['callSiteLine'] in call_sites
    )]
    assert not ({sample['sampleIndex'] for sample in targets} & {sample['sampleIndex'] for sample in js_self})
    negative = [sample for sample in samples if sample['rawDeltaUs'] < 0]
    target_negative = [sample for sample in targets if sample['rawDeltaUs'] < 0]
    ordered = sorted(samples, key=lambda sample: (sample['timestampUs'], sample['sampleIndex']))
    tasks = [event for event in events if event.get('name') == 'RunTask'
             and (event.get('pid'), event.get('tid')) == (pid, start['tid']) and 'dur' in event]
    before_weight = after_weight = 0
    before_task_clipped = after_task_clipped = raw_positive_task_clipped = 0
    samples_without_task = []
    raw_positive_crossing_task_start = []
    for index, sample in enumerate(ordered):
        if sample['nodeId'] not in target_nodes:
            continue
        prior_time = ordered[index - 1]['timestampUs'] if index else start['args']['data']['startTime']
        following_time = ordered[index + 1]['timestampUs'] if index + 1 < len(ordered) else sample['timestampUs']
        before_weight += sample['timestampUs'] - prior_time
        after_weight += following_time - sample['timestampUs']
        containing = [task for task in tasks if task['ts'] <= sample['timestampUs'] <= task['ts'] + task['dur']]
        if not containing:
            samples_without_task.append(sample['sampleIndex'])
            continue
        task = max(containing, key=lambda item: item['ts'])
        before_task_clipped += sample['timestampUs'] - max(prior_time, task['ts'])
        after_task_clipped += min(following_time, task['ts'] + task['dur']) - sample['timestampUs']
        positive_delta = max(0, sample['rawDeltaUs'])
        clipped_delta = min(positive_delta, sample['timestampUs'] - task['ts'])
        raw_positive_task_clipped += clipped_delta
        if clipped_delta != positive_delta:
            raw_positive_crossing_task_start.append(sample['sampleIndex'])
    schedule_events = []
    for event_index, event in enumerate(events):
        if event.get('name') != 'SchedulePostMessage' or (event.get('pid'), event.get('tid')) != (pid, start['tid']):
            continue
        frames = event.get('args', {}).get('data', {}).get('stackTrace', [])
        if not any(frame.get('url', '').endswith('/zstd-term-content.js') for frame in frames):
            continue
        schedule_events.append({
            'traceEventIndex': event_index, 'timestampUs': event['ts'],
            'threadTimestampUs': event.get('tts'), 'stackTrace': frames,
        })
    return {
        'tracePath': str(path), 'traceSha256': sha256(raw),
        'profile': {'pid': pid, 'profileId': profile_id, 'sampledTid': start['tid'],
                    'samplerTids': sorted(set(event['tid'] for _, event in chunks)),
                    'startTimeUs': start['args']['data']['startTime'], 'chunkCount': len(chunks),
                    'nodeCount': len(nodes), 'sampleCount': len(samples)},
        'chunkFileOrderAlreadyMonotonic': file_order_monotonic,
        'conflictingNodeIds': profile['conflictingNodeIds'],
        'sampleDeltaLengthsMatch': True,
        'nativeFrames': target_nodes,
        'nativeSampleCount': len(targets),
        'nativeCallSiteLines': sorted(call_sites),
        'signedRawDeltaWeightMs': sum(sample['rawDeltaUs'] for sample in targets) / 1000,
        'positiveOnlyRawDeltaWeightMs': sum(max(0, sample['rawDeltaUs']) for sample in targets) / 1000,
        'negativeNativeSampleCount': len(target_negative),
        'negativeNativeDeltaTotalUs': sum(sample['rawDeltaUs'] for sample in target_negative),
        'negativeProfileSampleCount': len(negative),
        'negativeProfileDeltaTotalUs': sum(sample['rawDeltaUs'] for sample in negative),
        'timestampSortedPrecedingGapWeightMs': before_weight / 1000,
        'timestampSortedFollowingGapWeightMs': after_weight / 1000,
        'timestampSortedPrecedingGapTaskClippedMs': before_task_clipped / 1000,
        'timestampSortedFollowingGapTaskClippedMs': after_task_clipped / 1000,
        'positiveRawDeltaTaskClippedMs': raw_positive_task_clipped / 1000,
        'nativeSampleIndexesWithoutContainingRunTask': samples_without_task,
        'positiveRawNativeIntervalsCrossingTaskStart': raw_positive_crossing_task_start,
        'timestampSortMovedSampleCount': sum(index != sample['sampleIndex'] for index, sample in enumerate(ordered)),
        'directJavaScriptCallSiteSelfSampleCount': len(js_self),
        'directJavaScriptCallSiteSignedRawDeltaWeightMs': sum(sample['rawDeltaUs'] for sample in js_self) / 1000,
        'compressionSchedulePostMessageCount': len(schedule_events),
        'compressionSchedulePostMessageEvents': schedule_events,
        'nativeSamples': targets,
    }


manifest_raw = (RAW / 'manifest.json').read_bytes()
manifest = json.loads(manifest_raw)
results = {arm: decode(RAW / f'trace-{arm}/run-1.trace.json') for arm in 'AB'}
source_identities = {}
for arm, repo in [('A', ROOT / 'manabitan'), ('B', ROOT / 'manabitan-dispatch')]:
    relative = 'js/dictionary/zstd-term-content.js'
    source = repo / 'ext' / relative
    identity = sha256(source.read_bytes())
    assert identity == manifest['sources'][arm]['packageEntries'][relative]
    source_identities[arm] = {'sourcePath': str(source), 'sha256': identity,
        'packageSourceCommit': manifest['sources'][arm]['gitSha'],
        'packageSha256': manifest['sources'][arm]['packageSha256']}
assert results['A']['nativeSampleCount'] == 140 and results['B']['nativeSampleCount'] == 63
assert results['A']['compressionSchedulePostMessageCount'] == 102 and results['B']['compressionSchedulePostMessageCount'] == 48
report = {
    'purpose': 'Independent read-only audit of compression dispatch native-frame attribution in the first browser cohort',
    'actionsRun': 'https://github.com/ManabiIO/manabitan/actions/runs/44605359044',
    'manifestSha256': sha256(manifest_raw), 'sourceIdentities': source_identities,
    'method': [
        'Decode raw traces independently of the qualification analyzer; group by process ID and profile ID, and take the sampled thread from the Profile header.',
        'Identify the unique importer profile by dictionary-database.js frames. Select only top-of-stack postMessage frames with no source URL whose immediate parent comes from zstd-term-content.js.',
        'Retain the native frame, complete ancestor chain, every selected raw sample, and direct SchedulePostMessage events on the same importer thread.',
        'Sum each selected sample raw timeDelta once. Do not separately add enclosing JavaScript intervals, other worker samples, idle/program nodes or asynchronous waits to this signed raw-delta summary.',
        'Check each native sample against RunTask events on the importer thread; report task-clipped sensitivities without adding task durations. Every selected sample lies inside a task, and every positive raw native interval stays within that task.',
        'Retain negative deltas. Positive-only and timestamp-sorted preceding/following-gap alternatives are explicitly sensitivity checks; none is substituted as a corrected measured duration.',
    ],
    'interpretation': [
        'Native attribution and the reduction from 102 outgoing compression posts to 48 are directly verified. JavaScript self-line-only counting omits the native frames.',
        'The signed raw-delta totals reproduce 42.419 ms and 28.319 ms, but they are sample weights, not exact synchronous dispatch elapsed time or CPU time.',
        'Negative deltas are present within already ordered chunks. Clamping them silently changes the reported weights. Sorting reconstructed sample timestamps also changes attribution depending on interpolation convention.',
        'The following-gap sensitivity is approximately neutral; none of these simplified gap assignments is the full DevTools task-integrated model. Do not treat the 14.100 ms difference as a measured critical-path saving.',
        'No whole-import, compression-wall-time or cross-device effect is inferred from these two diagnostic traces. Use the independent ordinary browser cohort for qualification.',
    ],
    'primaryMethodReferences': [
        {'url': 'https://chromium.googlesource.com/devtools/devtools-frontend/+/9a696c4e723caa3c7e1f78886da353f1f06a79b0/front_end/core/sdk/CPUProfileDataModel.ts',
         'relevance': 'Historical primary implementation reconstructs timestamps by cumulative signed deltas and sorts samples by timestamps; referenced for method context, not pinned to this Chromium build.'},
        {'url': 'https://chromium.googlesource.com/devtools/devtools-frontend/+/HEAD/front_end/panels/timeline/docs/profile_calls.md',
         'relevance': 'Primary documentation distinguishes observed sample stacks from estimated intervals and describes trace/task integration heuristics.'},
    ],
    'arms': results,
    'auditScriptSha256': sha256(Path(__file__).read_bytes()),
}
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({arm: {key: value for key, value in result.items() if key.endswith(('Count', 'Ms', 'Us')) and not isinstance(value, list)} for arm, result in results.items()}, indent=2))
print(str(OUT))
