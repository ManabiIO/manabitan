"""Audit the exact failed preparation prefix; never synthesize a success result."""
from pathlib import Path
import collections
import copy
import datetime
import json
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
AUDIT_ROOT = HERE.parents[1] / 'numeric-suffix-proof-consumer-audit'
sys.path.insert(0, str(AUDIT_ROOT))
from evidence_core import Archive, git_blob, parse_json, primary_records, require, sha, tracked_native, values

expected = parse_json((AUDIT_ROOT / 'expected.json').read_bytes())
require(sha((AUDIT_ROOT / 'expected.json').read_bytes()) == '766b4371ffe2a3203a8ee40642b99c8807c2a5183d16157ee70f6b83bcb62c52', 'Original frozen expectation')
metadata = parse_json((HERE / 'artifact-metadata.json').read_bytes())
archive = Archive(HERE / 'original-artifact.zip', metadata, expected)
require(len(archive.members) == 43, 'Every43 original failed-build members')
require('result.json' not in archive.members and 'diagnostic.wasm' not in archive.members, 'Failure before later correctness/diagnostic result')
raw, records = primary_records(HERE / 'primary-job.log')
require(sha(raw) == '454e7cd10e8a23783790e6bf833c9e448a83eb0fec672247c1dde9305e396fd1', 'Original terminal primary log')
require(all(record['tag'] == 'SUFFIX_PROOF_BUILD_STEP' for record in records), 'No component, timing or success-result records')
steps = values(records, 'SUFFIX_PROOF_BUILD_STEP')
labels = expected['buildCommandLabels'][:16]
require([step['label'] for step in steps] == labels, 'Exact completed command prefix')
binding = expected['binding']
start = archive.json('preparation-start.json')
require(start['binding'] == binding and start['bindingSha256'] == expected['bindingSha256'], 'Reviewed original binding')
require(start['toolingHead'] == expected['publication']['commit'] and start['toolingTree'] == expected['publication']['tree'], 'Original tooling commit/tree')
require(start['node'] == 'v22.22.0' and '21.1.8' in start['compiler'] and '21.1.8' in start['linker'], 'Pinned runtime/toolchain')
receipts = {name: archive.json(name + '.receipt.json') for name in labels}
repo = receipts['fetch-baseline']['cwd']
baseline = receipts['create-baseline']['command'][4]
candidate = receipts['create-candidate']['command'][4]
tooling = repo + '/dev/perf/numeric-suffix-proof-consumer-c563d487'
commands = {
    'fetch-baseline': (repo, ['git', 'fetch', '--no-tags', 'origin', binding['baseline']['commit']]),
    'create-baseline': (repo, ['git', 'worktree', 'add', '--detach', baseline, binding['baseline']['commit']]),
    'create-candidate': (repo, ['git', 'worktree', 'add', '--detach', candidate, binding['baseline']['commit']]),
    'dependencies-baseline': (repo, ['cp', '-a', repo + '/node_modules', baseline + '/node_modules']),
    'dependencies-candidate': (repo, ['cp', '-a', repo + '/node_modules', candidate + '/node_modules']),
    'reproduce-baseline': (baseline, ['npm', 'run', 'build:dictionary-wasm', '--', '--check']),
    'build-baseline-libraries': (baseline, ['npm', 'run', 'build:libs']),
    'apply-check': (candidate, ['git', 'apply', '--check', tooling + '/candidate.patch']),
    'apply-patch': (candidate, ['git', 'apply', tooling + '/candidate.patch']),
    'build-native-candidate': (candidate, ['npm', 'run', 'build:dictionary-wasm', '--', '--write']),
    'build-candidate-libraries': (candidate, ['npm', 'run', 'build:libs']),
    'reproduce-candidate': (candidate, ['npm', 'run', 'build:dictionary-wasm', '--', '--check']),
    'scoped-lint': (candidate, ['npx', 'eslint', *['test/' + name for name in binding['qualificationFiles']]]),
    'strict-main-types': (candidate, ['npm', 'run', 'test:ts:main']),
    'strict-test-types': (candidate, ['npm', 'run', 'test:ts:test']),
    'complete-unit-suite': (candidate, ['npm', 'run', 'test:unit', '--', '--maxWorkers=2']),
}
prior_finish = None
for index, (label, primary) in enumerate(zip(labels, steps)):
    receipt = receipts[label]
    require(receipt == primary, 'Original command receipt equals primary: ' + label)
    require((receipt['cwd'], receipt['command']) == commands[label], 'Exact original command/cwd: ' + label)
    require(receipt['exitCode'] == (1 if index == 15 else 0), 'Exact original completed/failed gate: ' + label)
    require(receipt['logSha256'] == archive.file_sha(label + '.log'), 'Every raw command log hash')
    require(receipt['finishedEpoch'] >= receipt['startedEpoch'] and (prior_finish is None or receipt['startedEpoch'] >= prior_finish), 'Serial original correctness commands')
    prior_finish = receipt['finishedEpoch']
compiled = archive.json('compiled-source-binding.json')
require(compiled['baseline'] == binding['baseline'] and compiled['candidateSource'] == binding['candidateCSourceSha256'], 'Compiled source/base binding')
products = compiled['productFilesSha256']
require(set(products) == set(expected['nativePaths']) | {'test/' + name for name in binding['qualificationFiles']}, 'Exact eight original products')
c_path, wasm_path, manifest_path = expected['nativePaths']
require(products[c_path] == binding['candidateCSourceSha256'] and compiled['extWasmSha256'] == products[wasm_path], 'Actual reviewed C and runtime/tracked WASM')
tracked_native(compiled['candidateTrackedChanges'], expected['nativePaths'])
product_root = HERE / 'product'
require(not product_root.exists(), 'Never replace recovered original product files')
product_root.mkdir()
product_details = {}
for name, digest in products.items():
    data = archive.read('product/' + name)
    require(sha(data) == digest, 'Original product SHA: ' + name)
    if name.startswith('test/'):
        require(digest == binding['qualificationFiles'][Path(name).name], 'Original failed-test bytes preserved')
    path = product_root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    product_details[name] = {'sha256': digest, 'bytes': len(data), 'gitBlobSha1': git_blob(data)}
manifest = archive.json('product/' + manifest_path)
sources = dict(expected['baselineNativeSourceHashes'])
sources[c_path] = products[c_path]
digest = sha(''.join(name + '\0' + sources[name] + '\n' for name in sorted(sources)).encode())
require(manifest['sourceDigest'] == digest and manifest['sourceFileCount'] == len(sources) == 14, 'All native source inputs')
normalized = copy.deepcopy(manifest)
normalized['sourceDigest'] = expected['baselineManifest']['sourceDigest']
term = next(item for item in normalized['targets'] if item['name'] == 'term-bank-parser.wasm')
require(term['sha256'] == products[wasm_path], 'Actual module pinned by manifest')
term['sha256'] = binding['baseline']['wasmSha256']
require(normalized == expected['baselineManifest'], 'Pinned toolchain/arguments/exports/other target unchanged')
diff = archive.read('rebuilt-candidate.diff')
require(sha(diff) == compiled['rebuiltDiffSha256'], 'Original binary diff')
pairs = re.findall(r'^diff --git a/(\S+) b/(\S+)$', diff.decode(), re.M)
require(len(pairs) == 3 and {left for left, right in pairs if left == right} == set(expected['nativePaths']), 'Only original native paths in diff')
with tempfile.TemporaryDirectory(prefix='suffix-proof-failed-diff-') as temporary:
    temp = Path(temporary)
    for name in expected['nativePaths']:
        path = temp / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(archive.read('product/' + name))
    patch = temp / 'original.diff'
    patch.write_bytes(diff)
    for extra in (['--check'], []):
        completed = subprocess.run(['git', 'apply', '--reverse', *extra, str(patch)], cwd=temp, capture_output=True)
        require(completed.returncode == 0, 'Original data-only diff reversal')
    for name, field in ((c_path, 'cSha256'), (wasm_path, 'wasmSha256'), (manifest_path, 'manifestSha256')):
        require(sha((temp / name).read_bytes()) == binding['baseline'][field], 'Reversed exact baseline byte identity')
unit = re.sub(r'\x1b\[[0-9;]*m', '', archive.read('complete-unit-suite.log').decode())
require(re.search(r'Test Files\s+1 failed\s+\|\s+673 passed\s+\(674\)', unit), 'Original file totals')
require(re.search(r'Tests\s+1 failed\s+\|\s+15224 passed\s+\|\s+47 skipped\s+\(15272\)', unit), 'Original test totals')
require('test/term-bank-row-suffix-proof-consumer.test.js (17 tests | 1 failed)' in unit, 'One failed added assertion')
require('148|         expect(value.indexes.length).toBeGreaterThan(0);' in unit and 'expected 0 to be greater than 0' in unit, 'Exact wide-sequence optional-index assertion failure')
test_lines = archive.read('product/test/term-bank-row-suffix-proof-consumer.test.js').decode().splitlines()
require(test_lines[146].strip() == 'expect(value.rows).toStrictEqual(expected);' and test_lines[147].strip() == 'expect(value.indexes.length).toBeGreaterThan(0);', 'Row semantic assertion immediately preceded failing optional-index assertion')
expected_members = {'product/' + name for name in products} | {'preparation-start.json', 'compiled-source-binding.json', 'rebuilt-candidate.diff'}
expected_members |= {label + suffix for label in labels for suffix in ('.log', '.receipt.json')}
require(set(archive.members) == expected_members, 'Complete exact43-member prefix inventory')
report = {'schema': 1, 'artifactAuditComplete': True, 'correctnessPass': False,
          'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'scope': 'Original failed preparation prefix only; exact artifact/native/test/command provenance. No success result synthesized, no native execution or measurements.',
          'artifact': metadata, 'primaryLogSha256': sha(raw), 'expectedSha256': sha((AUDIT_ROOT / 'expected.json').read_bytes()),
          'sourceAndCompiledBytesBound': True, 'productFiles': product_details, 'sourceDigest': digest,
          'all16CommandReceiptsAndLogsMatchPrimary': True, 'completedCommandLabels': labels,
          'successfulPrefixCommands': 15, 'failedCommand': 'complete-unit-suite', 'failedCommandExitCode': 1,
          'unattemptedCommandLabels': expected['buildCommandLabels'][16:],
          'tests': {'passed': 15224, 'failed': 1, 'skipped': 47, 'filesPassed': 673, 'filesFailed': 1,
                    'failure': 'New wide-sequence fixture asserted a nonempty optional native-index map; decoded rows had already passed.'},
          'componentObservations': 0, 'diagnosticChildren': 0, 'originalPreparationSucceeded': False,
          'binaryDiffReversesToExactBaseline': True, 'originalCompiledBindingSha256': archive.file_sha('compiled-source-binding.json'),
          'members': archive.members, 'auditorSha256': sha(Path(__file__).read_bytes()),
          'interpretation': 'The source-built bytes are identified, but this original run failed correctness and cannot qualify performance. Any reviewed test-contract correction is a separate cohort.'}
path = HERE / 'original-failed-artifact-audit.json'
require(not path.exists(), 'Never overwrite an earlier audit')
path.write_text(json.dumps(report, indent=2) + '\n')
archive.zip.close()
print(json.dumps({'artifactAuditComplete': True, 'correctnessPass': False, 'sha256': sha(path.read_bytes()),
                  'members': 43, 'commandReceipts': 16, 'componentObservations': 0, 'products': product_details}))
