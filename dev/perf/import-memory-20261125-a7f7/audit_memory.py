"""Recompute every memory summary from original scans and bound marker bytes."""

import json
from pathlib import Path
import statistics
import sys

from chromium_memory import summarize_import_window, tree_signature, confirmed_exited_zombie, GONE_ERRORS


def audit_cell(root):
    root = Path(root)
    plan = json.loads((root / 'plan.json').read_text())
    observations = []
    for observation in plan['schedule']:
        location = root / observation['name']
        memory = json.loads((location / 'memory.json').read_text())
        markers = [json.loads(line) for line in (location / 'markers.jsonl').read_text().splitlines() if line]
        assert markers == memory['windowMarkers'], 'Summary markers differ from original marker bytes'
        previous_end = 0
        for sample in memory['samples']:
            start, end = sample['startedAtMonotonicNs'], sample['finishedAtMonotonicNs']
            assert type(start) is int and type(end) is int and previous_end <= start <= end
            previous_end = end
            before, after = sample['discoveryBefore'], sample['discoveryAfter']
            assert sample['stableObservedProcessTree'] == (tree_signature(before) == tree_signature(after))
            reads, unavailable = sample['processes'], sample['unavailableProcesses']
            assert len({p['pid'] for p in reads + unavailable}) == len(reads) + len(unavailable)
            assert {p['pid'] for p in before['processes']} == {p['pid'] for p in reads + unavailable}
            for metric, key in [('pssKiB', 'readableProcessPssKiB'), ('privateKiB', 'readableProcessPrivateKiB')]:
                assert all(type(p[metric]) is int and p[metric] >= 0 for p in reads)
                assert sample[key] == sum(p[metric] for p in reads)
            after_by_pid = {p['pid']: p for p in after['processes']}
            exited = {p['pid'] for p in unavailable if confirmed_exited_zombie(p, after_by_pid.get(p['pid']))}
            assert {p['pid'] for p in sample['confirmedExitedZombies']} == exited
            unreadable = [p for p in unavailable if p['pid'] not in exited]
            assert unreadable == sample['unreadableAddressSpaces']
            roles = {p['role'] for p in reads}
            assert sorted(roles) == sample['observedRoles']
            errors = before['inventoryIdentityReadErrors'] + after['inventoryIdentityReadErrors']
            reasons = []
            if not before['browserSeedPids']: reasons.append('no-browser-seed')
            if len(reads) < 2: reasons.append('no-multiple-process-coverage')
            if 'browser' not in roles: reasons.append('no-readable-browser-process')
            if 'renderer' not in roles: reasons.append('no-readable-renderer-process')
            if not sample['stableObservedProcessTree']: reasons.append('process-tree-changed-during-scan')
            if unreadable: reasons.append('unreadable-discovered-process-smaps')
            if any(e['errno'] not in GONE_ERRORS for e in errors): reasons.append('incomplete-process-identity-inventory')
            assert sample['qualificationFailures'] == reasons
            assert sample['qualifiedForWholeTreePss'] == (not reasons)
        recomputed = summarize_import_window(memory['samples'], markers, memory['benchmarkExitCode'])
        assert recomputed == memory, 'Memory coverage/maxima differ from original scans'
        observations.append({**observation, **{k: v for k, v in memory.items() if k != 'samples'}})
    assert observations == json.loads((root / 'observations.json').read_text())
    comparison = json.loads((root / 'memory-comparison.json').read_text())
    assert comparison['observations'] == observations
    qualified = all(row['qualifiedForWholeTreePss'] for row in observations)
    assert comparison['everyObservationQualified'] == qualified
    metrics = {}
    for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
        changes = []
        for pair in comparison['pairs']:
            selected = {row['arm']: row for row in observations if row['pair'] == pair['pair']}
            pair_qualified = all(row['qualifiedForWholeTreePss'] for row in selected.values())
            assert pair['qualified'] == pair_qualified
            a, b = selected['A'][metric], selected['B'][metric]
            delta = 100 * (b / a - 1) if pair_qualified and a > 0 else None
            assert pair[metric] == {'baseline': a, 'candidate': b, 'changePercent': delta}
            changes.append(delta)
        metrics[metric] = {'medianPairedChangePercent': statistics.median(changes) if qualified else None,
                           'maximumPairedChangePercent': max(changes) if qualified else None}
    assert comparison['metrics'] == metrics
    passes = qualified and all(m['medianPairedChangePercent'] <= 5 and m['maximumPairedChangePercent'] <= 10 for m in metrics.values())
    assert comparison['passesProspectiveMemoryScreen'] == passes
    return {'schemaVersion': 1, 'observations': len(observations), 'rawScanCount': sum(row['allObservedSampleCount'] for row in observations),
            'everyObservationQualified': qualified, 'passesProspectiveMemoryScreen': passes, 'metrics': metrics}


if __name__ == '__main__':
    result = audit_cell(sys.argv[1])
    (Path(sys.argv[1]) / 'memory-audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
