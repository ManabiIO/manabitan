#!/usr/bin/env python3
"""Assemble existing evidence only; no native execution, import, or timing."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

WORK = Path('/workspace/scratch/b9cacc3542c2')
ANALYSIS = WORK / 'analysis'
PACK = Path(__file__).resolve().parent
SOURCE = WORK / 'canonical-combined'
TEMP = Path('/home/agent/.cache/manabitan-b9cacc/canonical-combined-resumed-20261128')
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '0285d5bd779cc1f4225bd41826613b6c00b08516'
TREE = 'e1f60ce0a28bee8caeca32ebdc023e4a89eec96f'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def git(*args, env=None):
    return subprocess.check_output(['git', '-C', str(SOURCE), *args], env=env)


records = []
by_digest = {}


def preserve(path, destination, role):
    """Preserve raw bytes once; record every original source-path alias."""
    data = path.read_bytes()
    # Fail closed rather than rewriting any raw observation or guard receipt.
    text = data.decode('utf-8', errors='replace')
    forbidden = [
        r'https?://[^\s"<>]+[?&](?:sig|token|access_token|X-Amz-Signature|X-Amz-Credential)=',
        r'(?im)^Authorization\s*:\s*\S+',
        r'"(?:access_token|refresh_token|client_secret)"\s*:\s*"[^"\s]+"',
    ]
    if any(re.search(pattern, text, re.IGNORECASE) for pattern in forbidden):
        raise ValueError(f'Credential/ephemeral-URL screening failed: {path}')
    sha = digest(data)
    if sha in by_digest:
        stored = by_digest[sha]
        assert (PACK / stored).read_bytes() == data
    else:
        stored = destination
        out = PACK / stored
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        by_digest[sha] = stored
    records.append({'source': str(path), 'storedAt': stored, 'bytes': len(data), 'sha256': sha, 'role': role, 'bytePreserved': True})


assert git('rev-parse', 'HEAD').decode().strip() == CANDIDATE
assert git('rev-parse', 'HEAD^{tree}').decode().strip() == TREE
assert git('status', '--porcelain') == b''

for path in sorted((ANALYSIS / 'canonical-combined').rglob('*')):
    if not path.is_file() or '__pycache__' in path.parts:
        continue
    preserve(path, 'canonical/' + path.relative_to(ANALYSIS / 'canonical-combined').as_posix(), 'canonical-original-evidence')

excluded_captures = []
capture_manifest_bytes = (TEMP / 'acquisition-005/capture-manifest.json').read_bytes()
capture_by_name = {capture['file']: capture for capture in json.loads(capture_manifest_bytes)['captures']}
for path in sorted(TEMP.rglob('*')):
    if not path.is_file():
        continue
    if path.name.endswith('.bin.gz'):
        # Manifest hashes were independently checked earlier; no decompression.
        capture = capture_by_name[path.name]
        assert path.stat().st_size == capture['compressedBytes']
        excluded_captures.append({'source': str(path), 'bytes': path.stat().st_size, 'inputSha256': capture['inputSha256'], 'compressedSha256': capture['compressedSha256'], 'outputSha256': capture['outputSha256'], 'manifestSha256': digest(capture_manifest_bytes), 'identitySource': 'Previously independently verified acquisition005 manifest; no new gzip hash or native execution while packaging', 'reason': 'Large reproducible native input excluded from compact pack'})
        continue
    preserve(path, 'canonical/resumed-home/' + path.relative_to(TEMP).as_posix(), 'canonical-resumed-original-evidence')

extras = [
    ('canonical-wrapper-screen-20261128-b9cacc.json', 'wrapper/closed-screen.json'),
    ('canonical-js-ownership-20261128-b9cacc.json', 'wrapper/ownership-screen.json'),
    ('current-profile/analyze-canonical-parent-samples.py', 'wrapper/analyze-canonical-parent-samples.py'),
    ('current-profile/canonical-parent-js-sample-clusters.json', 'wrapper/canonical-parent-js-sample-clusters.json'),
    ('current-profile/native-sample-names.json', 'crc/jmdict-native-sample-names.json'),
    ('vndb-profile-b9cacc/acquired/native-sample-names.json', 'crc/vndb-native-sample-names.json'),
    ('independent-crc-gap-binary-review/prove.py', 'crc/prove.py'),
    ('independent-crc-gap-binary-review/binary-proof.json', 'crc/binary-proof.json'),
    ('independent-crc-gap-binary-review/git-acquisition.json', 'crc/git-acquisition.json'),
    ('native-symbol-map-b9cacc/symbol_map.py', 'crc/symbol_map.py'),
    ('native-symbol-map-b9cacc/acquired/independent-audit.json', 'crc/native-symbol-independent-audit.json'),
    ('native-symbol-map-b9cacc/acquired/files/receipt.json', 'crc/native-symbol-hosted-receipt.json'),
    ('native-symbol-map-b9cacc/acquired/files/term-bank-parser.wasm.functions.json', 'crc/parser-function-map.json'),
    ('hosted/compression-batch-summary.json', 'related/compression-batch-summary.json'),
    ('hosted/parser-source-trim-summary.json', 'related/parser-source-trim-summary.json'),
    ('hosted/parser-source-trim-experiment.json', 'related/parser-source-trim-experiment.json'),
    ('hosted/score-validation-experiment.json', 'related/score-validation-experiment.json'),
    ('hosted/score-validation-gates.json', 'related/score-validation-gates.json'),
    ('hosted/parser-worker-bundle-experiment.json', 'related/parser-worker-bundle-original-experiment.json'),
    ('parser-bundle-validation-failure/diagnosis.json', 'related/bundle-original-validation-failure.json'),
    ('parser-bundle-validation-failure/workflow-correction-publication.json', 'related/bundle-workflow-correction.json'),
]
for source, destination in extras:
    preserve(ANALYSIS / source, destination, 'source-or-related-study-receipt')
preserve(WORK / 'baseline/test/perf/dictionaries.lock.json', 'canonical/dictionaries.lock.json', 'immutable-fixture-lock')

# Preserve exact Git patch, including all binary data, then verify its tree using
# an isolated index. This does not mutate the worktree, normal index, or refs.
patch = git('diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', BASE, CANDIDATE)
patch_path = PACK / 'canonical/product/candidate-vs-9e10.binary.patch'
patch_path.parent.mkdir(parents=True, exist_ok=True)
patch_path.write_bytes(patch)
index = PACK / '.patch-proof-index'
if index.exists():
    raise ValueError('Unexpected prior isolated patch index')
env = dict(os.environ, GIT_INDEX_FILE=str(index))
try:
    git('read-tree', BASE, env=env)
    git('apply', '--cached', '--binary', '--check', str(patch_path), env=env)
    git('apply', '--cached', '--binary', str(patch_path), env=env)
    reconstructed = git('write-tree', env=env).decode().strip()
    assert reconstructed == TREE
finally:
    index.unlink(missing_ok=True)
assert git('status', '--porcelain') == b''
(PACK / 'canonical/product/candidate.commit.txt').write_bytes(git('cat-file', 'commit', CANDIDATE))
write_json(PACK / 'canonical/product/patch-proof.json', {
    'baseline': BASE, 'baselineTree': git('rev-parse', BASE + '^{tree}').decode().strip(),
    'candidate': CANDIDATE, 'candidateTree': TREE, 'reconstructedTree': reconstructed,
    'patchSha256': digest(patch), 'patchBytes': len(patch),
    'changedFiles': git('diff', '--name-only', BASE, CANDIDATE).decode().splitlines(),
    'proof': 'git read-tree baseline; git apply --cached --binary; git write-tree using an isolated temporary index',
    'productWorktreeAndNormalIndexUnchanged': True,
    'nativeOrTestExecution': False,
})

old_path = ANALYSIS / 'canonical-combined/acquire-002-capture-manifest.json'
new_path = TEMP / 'acquisition-005/capture-manifest.json'
old = json.loads(old_path.read_bytes())
new = json.loads(new_path.read_bytes())
fields = ['index', 'group', 'memoryBytes', 'inputSha256', 'compressedSha256', 'compressedBytes', 'config', 'beforeDense', 'beforePending', 'header', 'outputSha256', 'expectedReturn']
assert len(old['captures']) == len(new['captures']) == 12
rows = []
for left, right in zip(old['captures'], new['captures']):
    assert left['index'] == len(rows)
    changed = [key for key in fields if left.get(key) != right.get(key)]
    rows.append({'index': left['index'], 'group': left['group'], 'inputSha256': left['inputSha256'], 'compressedSha256': left['compressedSha256'], 'outputSha256': left['outputSha256'], 'memoryBytes': left['memoryBytes'], 'compressedBytes': left['compressedBytes'], 'fieldsCompared': fields, 'differingFields': changed, 'matches': not changed})
write_json(PACK / 'canonical/regeneration-comparison-002-to-005.json', {
    'scope': 'Read-only comparison of existing manifests; no native call, decompression, reacquisition, or timing',
    'oldManifestSha256': digest(old_path.read_bytes()), 'newManifestSha256': digest(new_path.read_bytes()),
    'allTwelveMatch': all(row['matches'] for row in rows), 'captures': rows,
    'qualificationBoundary': 'Acquisition002 remains resource-invalid. Exact regenerated input/output hashes do not repair its guard or create another performance observation.',
})

# Resolve Profile owner versus profiler-chunk emission thread without timing.
trace_path = ANALYSIS / 'current-profile/trace/run-1.trace.json'
trace_bytes = trace_path.read_bytes()
trace = json.loads(trace_bytes)
events = trace.get('traceEvents', trace) if isinstance(trace, dict) else trace
profiles = [{'pid': e['pid'], 'tid': e['tid'], 'id': e['id']} for e in events if e.get('name') == 'Profile' and e.get('id') == '0x4']
chunks = [e for e in events if e.get('name') == 'ProfileChunk' and e.get('id') == '0x4']
workers = []
for e in events:
    d = e.get('args', {}).get('data', {})
    if e.get('name') == 'TracingSessionIdForWorker' and str(d.get('url', '')).endswith('/js/background/offscreen-dictionary-worker.js'):
        workers.append({'pid': e['pid'], 'tid': e['tid'], 'workerThreadId': d['workerThreadId'], 'url': d['url']})
assert profiles == [{'pid': 3512, 'tid': 3541, 'id': '0x4'}]
assert len(chunks) == 81 and {(e['pid'], e['tid']) for e in chunks} == {(3512, 3588)}
assert workers[0]['workerThreadId'] == 3541
write_json(PACK / 'wrapper/thread-identity.json', {
    'traceSha256': digest(trace_bytes), 'profileOwner': profiles[0], 'workerIdentity': workers[0],
    'profileChunkEmission': {'pid': 3512, 'tid': 3588, 'events': 81},
    'scope': 'The sampled importer owner is 3541; 3588 emits ProfileChunk events. No sample-count change, weighted time, or new profile.',
})

write_json(PACK / 'source-aliases.json', {
    'schemaVersion': 1, 'scope': 'Every listed raw source is preserved byte-for-byte. Identical byte sequences are stored once and every source path remains mapped.',
    'records': records, 'excludedLargeCaptures': excluded_captures,
    'excluded': ['Python bytecode caches', 'Full source dictionary ZIPs', 'Generated/vendor bundles', 'Raw hosted trace files reacquirable from identified immutable artifacts'],
    'security': 'Selected source text screened for signed credential URLs and credential values; no redaction of raw observations or guard records performed. Auxiliary transport/download metadata not selected.',
})
print(json.dumps({'copiedUniqueFiles': len(by_digest), 'sourceAliases': len(records), 'copiedUniqueBytes': sum((PACK / p).stat().st_size for p in by_digest.values()), 'excludedCaptureCount': len(excluded_captures), 'regenerationMatches': all(row['matches'] for row in rows), 'patchTree': reconstructed}, indent=2))
