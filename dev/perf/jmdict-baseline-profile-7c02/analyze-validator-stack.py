#!/usr/bin/env python3
"""Read-only diagnostic attribution of archived baseline Chrome traces.

ProfileChunk events can migrate between exporter threads. Profile IDs are
process scoped here; preserve the originating Profile thread separately.
Weights are sampling intervals, not CPU time or elapsed critical-path time.
"""
import collections
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import sys

path = Path(sys.argv[1])
output = Path(sys.argv[2])
dictionary = sys.argv[3] if len(sys.argv) > 3 else 'jmdict'
identities = {
    'jmdict': ('9713413c3406f1d664bedc5a7fa2934f6049fee4f8f5946e2bd4b63eec531e0f', 140848885601, 15246484756),
    'jitendex': ('b15945ac0dcd31e4030343f961b1ddcf0281520d42da0733ab239dfc55b102fc', 140848885295, 15246676338),
    'vndb': ('0ae649ff6f1a43db2f1a258648fbe9b6e6faea5af31161c3e27309021457769e', 140848885442, 15246796550),
}
trace_hash, job_id, artifact_id = identities[dictionary]
raw = path.read_bytes()
if path.suffix == '.gz':
    raw = gzip.decompress(raw)
assert hashlib.sha256(raw).hexdigest() == trace_hash
events = json.loads(raw)['traceEvents']
profiles = {}
thread_names = {}
for event in events:
    if event.get('ph') == 'M' and event.get('name') == 'thread_name':
        thread_names[(event.get('pid'), event.get('tid'))] = event.get('args', {}).get('name')
    if event.get('name') not in ('Profile', 'ProfileChunk'):
        continue
    key = (event['pid'], json.dumps(event.get('id2', event.get('id')), sort_keys=True))
    item = profiles.setdefault(key, {'nodes': {}, 'chunks': [], 'exporterThreads': set(), 'originThread': None})
    if event['name'] == 'Profile':
        assert item['originThread'] in (None, event['tid'])
        item['originThread'] = event['tid']
    else:
        item['exporterThreads'].add(event['tid'])
        data = event.get('args', {}).get('data', {})
        profile = data.get('cpuProfile', {})
        for node in profile.get('nodes', []):
            old = item['nodes'].get(node['id'])
            assert old is None or old == node, ('conflicting node definition', key, node['id'])
            item['nodes'][node['id']] = node
        item['chunks'].append((profile.get('samples', []), data.get('timeDeltas', []), data.get('lines', [])))

targets = {'parseCompactRecordFields', 'validateRecordFields', '_createLookupIndexChunk', '_encodeArtifactRecordFields', '_appendEncodedChunk'}
if len(sys.argv) > 4:
    targets.update(sys.argv[4].split(','))
summary = {}
missing_nodes = missing_deltas = 0
overall = collections.Counter()
native_profiles = collections.Counter()
for key, item in profiles.items():
    nodes = item['nodes']
    for samples, deltas, lines in item['chunks']:
        for i, nid in enumerate(samples):
            if nid not in nodes:
                missing_nodes += 1
                continue
            if i >= len(deltas):
                missing_deltas += 1
                continue
            node = nodes[nid]
            frame = node.get('callFrame', {})
            name = frame.get('functionName', '')
            overall[(name, frame.get('url', ''), frame.get('lineNumber'))] += deltas[i]
            if frame.get('url') == 'wasm://wasm/0004212e':
                native_profiles[(key, name)] += deltas[i]
            if name not in targets:
                continue
            report = summary.setdefault(name, {'deltas': [], 'lines': collections.Counter(), 'lineSamples': collections.Counter(), 'stacks': collections.Counter(), 'stackSamples': collections.Counter(), 'profiles': set()})
            report['profiles'].add(key)
            report['deltas'].append(deltas[i])
            line = lines[i] if i < len(lines) else None
            report['lines'][line] += deltas[i]
            report['lineSamples'][line] += 1
            stack = []
            seen = set()
            current = node
            while current is not None:
                assert current['id'] not in seen, 'cyclic parent chain'
                seen.add(current['id'])
                f = current.get('callFrame', {})
                stack.append((f.get('functionName', ''), f.get('url', ''), f.get('lineNumber')))
                parent = current.get('parent')
                if parent is not None and parent not in nodes:
                    stack.append(('<missing-parent>', '', parent))
                    break
                current = nodes.get(parent)
            stack = tuple(stack)
            report['stacks'][stack] += deltas[i]
            report['stackSamples'][stack] += 1

reports = {}
for name, report in summary.items():
    ds = report['deltas']
    reports[name] = {
        'sampledMs': round(sum(ds) / 1000, 3), 'samples': len(ds),
        'medianDeltaUs': statistics.median(ds), 'maxDeltaUs': max(ds),
        'samplesOver1ms': sum(d > 1000 for d in ds),
        'sampledMsOver1ms': round(sum(d for d in ds if d > 1000) / 1000, 3),
        'profiles': [{'pid': p[0], 'id': json.loads(p[1]), 'originThread': profiles[p]['originThread'], 'threadName': thread_names.get((p[0], profiles[p]['originThread'])), 'exporterThreads': sorted(profiles[p]['exporterThreads'])} for p in sorted(report['profiles'])],
        'sampleLines': [{'rawLine': line, 'sampledMs': round(value / 1000, 3), 'samples': report['lineSamples'][line]} for line, value in report['lines'].most_common()],
        'callers': [{'sampledMs': round(value / 1000, 3), 'samples': report['stackSamples'][stack], 'leafToRoot': [{'function': f[0], 'url': f[1], 'functionStartLine0': f[2]} for f in stack]} for stack, value in report['stacks'].most_common()],
    }
result = {
    'dictionary': dictionary,
    'sourceCommit': '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2',
    'runId': 46102820124, 'jobId': job_id, 'artifactId': artifact_id,
    'traceSha256': hashlib.sha256(raw).hexdigest(), 'traceBytes': len(raw),
    'grouping': 'PID plus process-scoped profile ID; exporter thread migration checked for duplicate node conflicts; originating thread from Profile event',
    'missingNodeSamples': missing_nodes, 'missingDeltaSamples': missing_deltas,
    'targets': reports,
    'nativeParserModuleByProfile': [{'pid': key[0][0], 'profileId': json.loads(key[0][1]), 'originThread': profiles[key[0]]['originThread'], 'threadName': thread_names.get((key[0][0], profiles[key[0]]['originThread'])), 'function': key[1], 'sampledMs': round(value / 1000, 3)} for key, value in native_profiles.most_common()],
    'top': [{'function': key[0], 'url': key[1], 'line0': key[2], 'sampledMs': round(value / 1000, 3)} for key, value in overall.most_common(50)],
    'interpretation': 'Self-sample interval attribution from one diagnostic trace. Scheduling delays can inflate deltas. Not measured CPU time, ordinary wall time, or an optimization gain. Async parent continuations are not reconstructed beyond captured frames.',
}
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'output': str(output), 'missingNodeSamples': missing_nodes, 'missingDeltaSamples': missing_deltas, 'targets': {name: {k: v for k, v in report.items() if k != 'callers'} | {'callers': [{'sampledMs': c['sampledMs'], 'samples': c['samples'], 'leafToRoot': [f['function'] for f in c['leafToRoot']]} for c in report['callers']]} for name, report in reports.items()}}, indent=2))
