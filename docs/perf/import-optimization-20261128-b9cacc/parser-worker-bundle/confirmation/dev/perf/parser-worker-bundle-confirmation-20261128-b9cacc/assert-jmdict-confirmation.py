"""Fail closed after a complete cohort; never alter or replace observations."""
import argparse
import hashlib
import json
import pathlib
import sys
import zipfile

from confirmation_criteria import BASELINE, CANDIDATE, evaluate_review_criteria, fixed_schedule


def actual_package_members(path):
    entries, lengths = {}, {}
    with zipfile.ZipFile(path) as package:
        names = package.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate actual package member names')
        unpacked = 0
        for info in package.infolist():
            parts = pathlib.PurePosixPath(info.filename)
            if parts.is_absolute() or '..' in parts.parts or '\\' in info.filename:
                raise ValueError('Unsafe actual package member')
            if info.is_dir():
                continue
            unpacked += info.file_size
            if unpacked > 1024 * 1024 * 1024:
                raise ValueError('Actual package members exceed inspection budget')
            digest, length = hashlib.sha256(), 0
            with package.open(info) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    length += len(block)
                    if length > info.file_size:
                        raise ValueError('Actual package member length mismatch')
                    digest.update(block)
            if length != info.file_size:
                raise ValueError('Actual package member length mismatch')
            entries[info.filename] = digest.hexdigest()
            lengths[info.filename] = length
    return entries, lengths


parser = argparse.ArgumentParser()
parser.add_argument('evidence', type=pathlib.Path)
parser.add_argument('--order', choices=['AB', 'BA'], required=True)
args = parser.parse_args()
output = args.evidence / 'confirmation-review.json'
if output.exists():
    raise ValueError('Never overwrite a previous confirmation review')
result = {'schemaVersion': 1, 'status': 'failed', 'initialOrder': args.order,
          'baseline': BASELINE, 'candidate': CANDIDATE, 'authoritativeTiming': True}
try:
    def read(name):
        return json.loads((args.evidence / name).read_text())

    registration = json.loads(pathlib.Path(__file__).with_name('registration.json').read_text())
    plan = read('registered-plan.json')
    for key, value in {'baseline': BASELINE, 'candidate': CANDIDATE, 'dictionary': 'jmdict',
                       'initialOrder': args.order, 'pairs': 12, 'flags': {}, 'schedule': fixed_schedule(args.order),
                       'expectedPackageEntries': ['js/dictionary/term-bank-wasm-parser.js'],
                       'expectedAddedPackageEntries': ['js/dictionary/term-bank-wasm-parser-worker.bundle.js']}.items():
        if plan.get(key) != value:
            raise ValueError('Registered plan mismatch: ' + key)
    sources = read('source-identities.json')
    maps = {}
    result['actualPackageProof'] = {}
    for arm, expected_sha, expected_tree, payloads in [
        ('A', BASELINE, registration['baselineTree'], registration['expectedBaselineRuntimePayloads']),
        ('B', CANDIDATE, registration['candidateTree'], registration['expectedRuntimePayloads']),
    ]:
        identity = sources['arms'][arm]
        if identity['sha'] != expected_sha or identity['tree'] != expected_tree:
            raise ValueError('Runtime source or tree mismatch: ' + arm)
        package_path = args.evidence / ('package-' + arm + '.zip')
        digest = hashlib.sha256()
        with package_path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != identity['packageSha256']:
            raise ValueError('Actual runtime package checksum mismatch: ' + arm)
        entries, lengths = actual_package_members(package_path)
        if entries != identity['entries']:
            raise ValueError('Actual complete package member map differs from producer receipt: ' + arm)
        payload_proof = {}
        for name, expected in payloads.items():
            actual = {'sha256': entries.get(name), 'bytes': lengths.get(name)}
            if actual != expected:
                raise ValueError('Source-frozen actual runtime payload mismatch: ' + arm + ':' + name)
            payload_proof[name] = actual
        maps[arm] = entries
        result['actualPackageProof'][arm] = {
            'sourceSha': expected_sha, 'sourceTree': expected_tree, 'packageSha256': digest.hexdigest(),
            'packageBytes': package_path.stat().st_size, 'memberCount': len(entries),
            'memberMapSha256': hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'runtimePayloads': payload_proof,
        }
    a, b = maps['A'], maps['B']
    if sorted(b.keys() - a.keys()) != ['js/dictionary/term-bank-wasm-parser-worker.bundle.js'] or a.keys() - b.keys():
        raise ValueError('Unexpected actual added or removed package member')
    if sorted(name for name in a.keys() & b.keys() if a[name] != b[name]) != ['js/dictionary/term-bank-wasm-parser.js']:
        raise ValueError('Unexpected actual changed existing package member')
    if b['js/dictionary/term-bank-wasm-parser-worker.bundle.js'] != 'f6c0c2b6c19f686d1280cc0c456357a944208a2e9f56a588788a8da58e4611a6':
        raise ValueError('Actual generated bundle differs from the frozen candidate')
    analysis = read('analysis.json')
    result['review'] = evaluate_review_criteria(read('observations.json'), args.order, analysis)
    result['semanticMemoryPassed'] = analysis.get('status') == 'correctness-memory-passed' and analysis.get('memoryPassed') is True
    result['status'] = 'passed' if result['semanticMemoryPassed'] and result['review']['passesPerformanceReview'] else 'criteria-not-met'
except Exception as error:
    result['failure'] = {'type': type(error).__name__, 'message': str(error)}
args.evidence.mkdir(parents=True, exist_ok=True)
with output.open('x') as stream:
    json.dump(result, stream, indent=2, allow_nan=False)
    stream.write('\n')
print(json.dumps(result, indent=2, allow_nan=False))
sys.exit(0 if result['status'] == 'passed' else 1)
