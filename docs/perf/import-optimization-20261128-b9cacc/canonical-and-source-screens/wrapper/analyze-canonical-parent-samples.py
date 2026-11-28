"""Count stack-qualified parent self samples; never consume timeDelta values."""
import collections
import hashlib
import json
import pathlib

ROOT = pathlib.Path('/workspace/scratch/b9cacc3542c2')
PROFILE = ROOT / 'analysis/current-profile'
TRACE = PROFILE / 'trace/run-1.trace.json'
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
sha = lambda data: hashlib.sha256(data).hexdigest()
raw = TRACE.read_bytes()
assert sha(raw) == '5b89ba263782ce409155bee286c51a1c7f6e181976321da71a6e9014ffac1d15'
summary = json.loads((PROFILE / 'trace/summary.json').read_text())
assert summary['gitSha'] == summary['source']['gitSha'] == BASE and summary['source']['dirty'] is False
assert summary['traceEnabled'] is True and summary['authoritativeTiming'] is False and summary['importFlags'] is None
events = json.loads(raw)['traceEvents']
workers = {event['tid']: event['args']['data']['url'] for event in events if event.get('name') == 'TracingSessionIdForWorker'}
parent_tids = [tid for tid, url in workers.items() if url.endswith('/js/background/offscreen-dictionary-worker.js')]
assert len(parent_tids) == 1
profiles = {}
for event in events:
    if event.get('name') not in ['Profile', 'ProfileChunk']:
        continue
    key = (event['pid'], event['id'])
    profile = profiles.setdefault(key, {'nodes': {}, 'samples': [], 'tid': None})
    if event['name'] == 'Profile':
        profile['tid'] = event['tid']
    else:
        cpu = event['args']['data'].get('cpuProfile', {})
        for node in cpu.get('nodes', []):
            assert node['id'] not in profile['nodes'] or profile['nodes'][node['id']] == node
            profile['nodes'][node['id']] = node
        profile['samples'].extend(cpu.get('samples', []))
selected = [(key, value) for key, value in profiles.items() if value['tid'] == parent_tids[0]]
assert len(selected) == 1
(pid, profile_id), profile = selected[0]

def frame_key(frame):
    return (frame.get('url', ''), frame.get('functionName', ''), frame.get('lineNumber', -1) + 1,
            frame.get('columnNumber', -1) + 1)

def describe(key):
    return dict(zip(['url', 'function', 'line', 'column'], key))

def stack(node_id):
    seen, result = set(), []
    while node_id in profile['nodes']:
        assert node_id not in seen
        seen.add(node_id)
        node = profile['nodes'][node_id]
        result.append(frame_key(node['callFrame']))
        node_id = node.get('parent')
    return result

names = {
    'resolvedPlanPublication': {'_publishResolvedArtifactTermContentPlan'},
    'metadataPublication': {'_publishArtifactTermContentMetadata', '_tryPublishContiguousArtifactTermContentMetadata'},
    'pendingColumnAdoption': {'adoptPendingColumns'},
    'exactResolution': {'resolveExactCandidates', '_findMatchingPersistedTermEntryContentMetaBatch', '_termContentBytesEqualSpan',
                        '_readTermEntryContentBytesDetailed', '_readTermEntryContentBytesDetailedBatch', '_findRecentTermContentSource'},
    'recentSourceCache': {'_cacheRecentPublishedTermContentSources'},
    'inFlightSourceRegistration': {'_registerInFlightTermContentSources'},
    'canonicalPreparation': {'_resolveArtifactTermContentDedup', 'initializeTermContentPlanResolution',
                             '_ensureTermEntryContentMetaHashPairCapacity', '_reserveArtifactTermContentMetadata',
                             '_reservePreparedArtifactTermContentMetadata', '_stageArtifactTermContentMetadata'},
}

def category(frame):
    url, name, _, _ = frame
    if url.endswith('/term-content-canonical-scan.js'):
        return 'canonicalScanner'
    if url.endswith('/term-content-metadata-arena.js'):
        return 'metadataArena'
    for key, choices in names.items():
        if name in choices and '/js/dictionary/' in url:
            return key
    return None

self_counts = collections.Counter()
cluster_counts = collections.Counter()
cluster_leaf_counts = collections.defaultdict(collections.Counter)
cluster_stack_counts = collections.defaultdict(collections.Counter)
anchor_counts = collections.Counter()
anchor_self = collections.Counter()
position_tick_nodes = 0
for node_id, count in collections.Counter(profile['samples']).items():
    frames = stack(node_id)
    assert frames
    leaf = frames[0]
    self_counts[leaf] += count
    if profile['nodes'][node_id].get('positionTicks'):
        position_tick_nodes += 1
    anchors = [(index, category(frame)) for index, frame in enumerate(frames) if category(frame) is not None]
    for index, _ in anchors:
        anchor_counts[frames[index]] += count
        if index == 0:
            anchor_self[frames[index]] += count
    if anchors:
        _, selected_category = anchors[0]
        cluster_counts[selected_category] += count
        cluster_leaf_counts[selected_category][leaf] += count
        cluster_stack_counts[selected_category][tuple(frames[:8])] += count

result = {
    'scope': 'One existing diagnostic trace. Counts only; no timeDelta reads/weighting, phase subtraction, new profile or performance inference. Nearest-anchor clusters are disjoint; inclusive anchor counts can overlap.',
    'baseline': BASE, 'traceSha256': sha(raw), 'packageSha256': summary['runs'][0]['packageSha256'],
    'pid': pid, 'tid': profile['tid'], 'profileId': profile_id, 'worker': workers[profile['tid']],
    'sampleCount': len(profile['samples']), 'sampledNodesWithPositionTicks': position_tick_nodes,
    'nearestAnchorClusters': [dict(category=name, selfSamples=count,
        javascriptSelfSamples=sum(n for frame, n in cluster_leaf_counts[name].items() if frame[0].startswith('chrome-extension://')),
        wasmSelfSamples=sum(n for frame, n in cluster_leaf_counts[name].items() if frame[0].startswith('wasm://')),
        builtinOrUnattributedSelfSamples=sum(n for frame, n in cluster_leaf_counts[name].items() if not frame[0]),
        leaves=[dict(**describe(frame), selfSamples=n) for frame, n in cluster_leaf_counts[name].most_common()],
        topStacks=[{'selfSamples': n, 'frames': [describe(frame) for frame in frames]}
                   for frames, n in cluster_stack_counts[name].most_common(15)]) for name, count in cluster_counts.most_common()],
    'anchors': [dict(**describe(frame), inclusiveSamples=count, ownSelfSamples=anchor_self[frame])
                for frame, count in anchor_counts.most_common()],
    'allParentSelf': [dict(**describe(frame), selfSamples=count) for frame, count in self_counts.most_common()],
}
out = PROFILE / 'canonical-parent-js-sample-clusters.json'
with out.open('x') as stream:
    json.dump(result, stream, indent=2)
    stream.write('\n')
print(json.dumps({'output': str(out), 'sampleCount': result['sampleCount'],
    'sampledNodesWithPositionTicks': position_tick_nodes,
    'clusters': [{'category': row['category'], 'selfSamples': row['selfSamples'],
                  'javascriptSelfSamples': row['javascriptSelfSamples'], 'wasmSelfSamples': row['wasmSelfSamples'],
                  'builtinOrUnattributedSelfSamples': row['builtinOrUnattributedSelfSamples'], 'topLeaves': row['leaves'][:6]}
                 for row in result['nearestAnchorClusters']], 'anchors': result['anchors']}, indent=2))
