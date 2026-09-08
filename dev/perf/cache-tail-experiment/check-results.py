"""Check non-timing import outcomes without trimming or changing the timing population."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
result = json.loads((root / 'results.json').read_text())
if result['status'] != 'complete' or len(result['runs']) != 72 or len(result['warmupRuns']) != 6:
    raise ValueError('Expected all twelve pairs per dictionary and separate warmups')
keys = ['rows', 'parserEncodedContentBytes', 'parserRecentContentDedupHitCount', 'dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount', 'dedupExactFallbackCount']
by_pair = {}
for run in result['runs']:
    summary = json.loads(Path(run['summary']).read_text())
    phases = summary['runs'][0]['importDebug']['importerPhaseTimings']
    matches = [phase['details'] for phase in phases if phase['phase'].startswith('term-file-fast-path:')]
    if len(matches) != 1:
        raise ValueError('Expected one complete fast-path summary')
    details = matches[0]
    pair = by_pair.setdefault((run['dataset'], run['pair']), {})
    if run['arm'] in pair:
        raise ValueError('Duplicate arm')
    pair[run['arm']] = {key: details[key] for key in keys}
for pair, arms in by_pair.items():
    if set(arms) != {'baseline', 'candidate'} or arms['baseline'] != arms['candidate']:
        raise ValueError(f'Changed deduplication outcomes: {pair}: {arms}')
output = {'pairsVerified': len(by_pair), 'keys': keys, 'allMatched': True, 'scope': 'Aggregate parser and exact-deduplication outcomes; not exhaustive persisted byte equality'}
(root / 'outcome-parity.json').write_text(json.dumps(output, indent=2))
print(json.dumps(output, indent=2))
