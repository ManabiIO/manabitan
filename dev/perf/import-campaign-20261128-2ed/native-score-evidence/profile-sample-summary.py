#!/usr/bin/env python3
"""Summarize diagnostic CPU samples without treating trace time as import time."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--trace', type=Path)
parser.add_argument('--zip', type=Path)
parser.add_argument('--member')
parser.add_argument('--source-sha', required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
assert (args.trace is None) != (args.zip is None)
assert args.zip is None or args.member
if args.zip is not None:
    with zipfile.ZipFile(args.zip) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        raw = archive.read(args.member)
else:
    raw = args.trace.read_bytes()
trace_sha = hashlib.sha256(raw).hexdigest()
events = json.loads(raw)['traceEvents']
del raw

target_names = {
    '_encodeArtifactRecordFields', 'isCanonicalTermScorePlan',
    'getSynchronousTermScorePlan', 'getSynchronousRecordFieldReferences',
    'readCapturedTermScore', 'assertUnchangedTermScorePlan',
    'validateContentOffset', 'validateContentLength', 'getContentOffsetDelta',
    '_encodeAndAppendArtifactChunkForState', '_createLookupIndexChunk',
    'parseCompactRecordFields', 'hashLookupIndexBytes',
    '_publishResolvedArtifactTermContentPlan', '_publishArtifactTermContentMetadata',
    '_cacheRecentPublishedTermContentSources', '_registerInFlightTermContentSources',
    '_scan', 'resolveExactCandidates', 'prepareNativeTermScorePlan',
    'copyOwnedTermScorePlan', 'copyWasmBackedColumnChunkInternal',
}

worker_urls = {}
for event in events:
    if event.get('name') == 'TracingSessionIdForWorker':
        data = event.get('args', {}).get('data', {})
        if 'workerThreadId' in data and 'url' in data:
            thread = data['workerThreadId']
            assert worker_urls.get(thread, data['url']) == data['url']
            worker_urls[thread] = data['url']


def profile_key(event):
    return (event['pid'], json.dumps(event.get('id', event.get('id2')), sort_keys=True))


profiles = {}
chunks_by_profile = collections.defaultdict(list)
for event in events:
    if event.get('name') == 'Profile':
        key = profile_key(event)
        assert key not in profiles
        profiles[key] = event
    elif event.get('name') == 'ProfileChunk':
        chunks_by_profile[profile_key(event)].append(event)

result = {
    'sourceShaLabel': args.source_sha,
    'traceSha256': trace_sha,
    'input': str(args.trace if args.trace is not None else args.zip),
    'member': args.member,
    'diagnosticOnly': True,
    'limitations': [
        'Source SHA is a caller label and must be bound to the independent artifact audit.',
        'Instrumented samples are not ordinary import timings or a causal speedup estimate.',
        'Optimized source-line positions are not branch counters.',
        'Negative or long profile time deltas are reported; no sample is removed or time-weighted.',
        'Separate A/B traces are single diagnostic observations, not another benchmark cohort.',
    ],
    'profiles': [],
}
for key, profile in profiles.items():
    chunks = chunks_by_profile[key]
    nodes = {}
    for chunk in chunks:
        for node in chunk['args']['data'].get('cpuProfile', {}).get('nodes', []):
            previous = nodes.get(node['id'])
            assert previous is None or previous == node
            nodes[node['id']] = node
    self_counts = collections.Counter()
    inclusive_counts = collections.Counter()
    target_lines = collections.defaultdict(collections.Counter)
    target_descendants = collections.defaultdict(collections.Counter)
    missing_samples = 0
    sample_count = 0
    negative_deltas = 0
    maximum_delta = 0
    unpaired_deltas = 0
    for chunk in chunks:
        data = chunk['args']['data']
        samples = data.get('cpuProfile', {}).get('samples', [])
        lines = data.get('lines', [])
        deltas = data.get('timeDeltas', [])
        sample_count += len(samples)
        negative_deltas += sum(delta < 0 for delta in deltas)
        maximum_delta = max([maximum_delta, *deltas])
        unpaired_deltas += abs(len(samples) - len(deltas))
        for index, sample_id in enumerate(samples):
            if sample_id not in nodes:
                missing_samples += 1
                continue
            node = nodes[sample_id]
            frame = node.get('callFrame', {})
            name = frame.get('functionName', '')
            self_counts[name] += 1
            if name in target_names:
                target_lines[name][str(lines[index] if index < len(lines) else -1)] += 1
            seen = set()
            ancestor_names = set()
            current = sample_id
            while current in nodes and current not in seen:
                seen.add(current)
                ancestor = nodes[current]
                ancestor_names.add(ancestor.get('callFrame', {}).get('functionName', ''))
                current = ancestor.get('parent')
            inclusive_counts.update(ancestor_names)
            for target in ancestor_names & target_names:
                target_descendants[target][name] += 1
    targets = {
        name: {
            'selfSamples': self_counts[name],
            'inclusiveSamples': inclusive_counts[name],
            'selfSourceLines': dict(target_lines[name]),
            'topDescendantSelfSamples': target_descendants[name].most_common(12),
        }
        for name in sorted(target_names)
        if inclusive_counts[name] or self_counts[name]
    }
    result['profiles'].append({
        'pid': profile['pid'], 'profileId': key[1], 'thread': profile['tid'],
        'workerUrl': worker_urls.get(profile['tid']),
        'sampleCount': sample_count, 'missingNodeSamples': missing_samples,
        'negativeTimeDeltas': negative_deltas, 'maximumTimeDeltaMicroseconds': maximum_delta,
        'unpairedSamplesOrDeltas': unpaired_deltas,
        'topSelfSamples': self_counts.most_common(30),
        'targets': targets,
    })
with args.out.open('x') as output:
    json.dump(result, output, indent=2)
    output.write('\n')
print(json.dumps({
    'traceSha256': trace_sha,
    'profiles': len(result['profiles']),
    'samples': sum(item['sampleCount'] for item in result['profiles']),
    'output': str(args.out),
}))
