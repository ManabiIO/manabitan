#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify retained six-cell browser evidence without acquiring new imports.

The compact archive omits only the twelve original product package ZIP files.
Their hashes and previously verified entry manifests remain bound to the raw
receipts. Supply --original-artifacts to rehash those original ZIP payloads too.
"""
import argparse
import base64
import binascii
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import random
import re
import statistics
import sys
import tarfile
import tempfile
import zipfile

if not __debug__:
    raise RuntimeError('Do not disable audit assertions with -O or PYTHONOPTIMIZE')

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '2cdcc90241fa19221b7fc4e5d793eb70896c3258'
TREES = {'A': 'd99ea4d04658f7ec1c76acdc5f3684594212a471',
         'B': 'df0f1f9fc77d931381a9f687f4e9bb0c4a225d1d'}
SOURCES = {'A': BASELINE, 'B': CANDIDATE}
RUN = 46104027586
PAIRS = 6
DICTIONARIES = ('jmdict', 'jitendex', 'vndb')
CELLS = tuple(f'{dictionary}-{order}' for dictionary in DICTIONARIES for order in ('AB', 'BA'))
POLICY = {'jmdict': (3, 12), 'jitendex': (3, 22), 'vndb': (3, 170)}
HOST_JOBS = {'jmdict-AB': 140859697687, 'jmdict-BA': 140859697779,
             'jitendex-AB': 140859697721, 'jitendex-BA': 140859697695,
             'vndb-AB': 140859697652, 'vndb-BA': 140859697696}
PACKAGE_DELTA = ('js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm')
NATIVE_PATHS = {'js/dictionary/wasm/term-bank-parser.c': 'ext/js/dictionary/wasm/term-bank-parser.c',
                'lib/term-bank-parser.wasm': 'dev/data/dictionary-wasm/term-bank-parser.wasm'}
PARSER = {'A': '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee',
          'B': '6b327b4b5c85a973b1e2344276bb5476b6d036b197d87ab03b2a930ed50059eb'}
CHANGED_PATHS = {'.github/workflows/composite-window-screen-5a86.yml',
                 'dev/data/dictionary-wasm/manifest.json',
                 'dev/data/dictionary-wasm/term-bank-parser.wasm',
                 'dev/perf/composite-window-5a86/local-component-evidence.json.txt',
                 'dev/perf/composite-window-screen-5a86.py',
                 'ext/js/dictionary/wasm/term-bank-parser.c',
                 'test/term-bank-first-special.test.js'}
SUPPORT = 'dev/perf/import-memory-20261125-a7f7/'
FROZEN = {
    SUPPORT + 'qualification_receipts.py': '4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51',
    SUPPORT + 'audit_memory.py': '871f29b9d87c42468714263a0eda05ee9edd2f76bff269ea9cb6d6d1fe51de7c',
    SUPPORT + 'protocol.py': 'ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7',
    SUPPORT + 'chromium_memory.py': '8044bf3f4c48a868c7e076dc5f1bef9c2663f6323fe4a4fba5c121161cada4c7',
    'test/perf/dictionaries.lock.json': '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89',
    'test/chromium/extension-two-dictionary-import.e2e.js': 'd0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf',
    'dev/perf/import-qualification-20261125-a7f7.py': 'cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef',
    '.github/workflows/composite-window-screen-5a86.yml': '9e75f011ff82d9a62b9690d8ea119daf0e95be2a9ca416ddea3061c33c67a110',
    'dev/perf/composite-window-screen-5a86.py': 'af67203a300e1b5d4697f1ddf835237417b07dc91a1c2ec7d085fa53f631d881',
}
SOURCE_HASH_PATHS = {'builds/manabitan-chrome-dev.zip', 'builds/manabitan-chrome.zip',
                     'dev/perf/benchmark-support.js', 'dev/perf/dictionary-fixtures.js',
                     'dev/perf/import-benchmark.js', 'ext/js/pages/settings/dictionary-import-controller.js',
                     'package-lock.json', 'test/chromium/extension-two-dictionary-import.e2e.js',
                     'test/chromium/import-flags-ab-benchmark.js', 'test/e2e/import-timing.js',
                     'test/perf/dictionaries.lock.json'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def identity(data):
    return {'bytes': len(data), 'sha256': sha(data)}


def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def safe_name(name):
    path = PurePosixPath(name)
    assert name and not path.is_absolute() and '..' not in path.parts
    assert str(path) == name and '\\' not in name
    return path


class GitProof:
    """Check raw Git object identities and traverse selected commit tree paths."""

    def __init__(self, root, manifest):
        self.root = root
        self.objects = manifest['gitObjects']
        self.cache = {}
        for oid, item in self.objects.items():
            assert re.fullmatch('[0-9a-f]{40}', oid)
            assert item['kind'] in ('commit', 'tree', 'blob')
            self.object(oid, item['kind'])

    def object(self, oid, kind):
        record = self.objects[oid]
        assert record['kind'] == kind
        if oid not in self.cache:
            data = (self.root / 'git-objects' / oid).read_bytes()
            assert identity(data) == {key: record[key] for key in ('bytes', 'sha256')}
            header = f'{kind} {len(data)}\0'.encode()
            assert hashlib.sha1(header + data).hexdigest() == oid
            self.cache[oid] = data
        return self.cache[oid]

    def commit(self, revision):
        header = self.object(revision, 'commit').split(b'\n\n', 1)[0].splitlines()
        trees = [line[5:].decode() for line in header if line.startswith(b'tree ')]
        parents = [line[7:].decode() for line in header if line.startswith(b'parent ')]
        assert len(trees) == 1
        return trees[0], parents

    def tree(self, oid):
        data = self.object(oid, 'tree')
        entries, offset = {}, 0
        while offset < len(data):
            end = data.index(b'\0', offset)
            mode, name = data[offset:end].split(b' ', 1)
            name = name.decode()
            assert '/' not in name and name not in entries and name not in ('.', '..')
            assert end + 21 <= len(data)
            entries[name] = (mode.decode(), data[end + 1:end + 21].hex())
            offset = end + 21
        assert offset == len(data)
        return entries

    def source(self, revision, path):
        parts = safe_name(path).parts
        oid, _ = self.commit(revision)
        for index, part in enumerate(parts):
            mode, oid = self.tree(oid)[part]
            assert mode in (('100644', '100755') if index == len(parts) - 1 else ('40000',))
        return self.object(oid, 'blob')

    def changed(self, left, right, prefix=''):
        if left == right:
            return set()
        a = self.tree(left) if left else {}
        b = self.tree(right) if right else {}
        result = set()
        for name in a.keys() | b.keys():
            if a.get(name) == b.get(name):
                continue
            before, after = a.get(name), b.get(name)
            if (before is None or before[0] == '40000') and (after is None or after[0] == '40000'):
                result |= self.changed(before[1] if before else None, after[1] if after else None, prefix + name + '/')
            else:
                assert before is None or before[0] in ('100644', '100755')
                assert after is None or after[0] in ('100644', '100755')
                result.add(prefix + name)
        return result


def paired(items, kind, right):
    pairs = {}
    for item in items:
        if item['kind'] == kind:
            pair = pairs.setdefault(item['pair'], {})
            assert item['arm'] not in pair
            value = item['totalImportMs']
            assert isinstance(value, (int, float)) and math.isfinite(value) and value > 0
            pair[item['arm']] = value
    assert len(pairs) == (PAIRS if kind == 'candidate' else PAIRS // 3)
    assert all(set(pair) == {'A', right} for pair in pairs.values())
    values = list(pairs.values())
    ratios = [pair[right] / pair['A'] for pair in values]
    rng = random.Random(897)
    bootstrap = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {'count': len(values), 'ratios': ratios,
            'medianPairedChangePercent': 100 * (statistics.median(ratios) - 1),
            'equalWorkChangePercent': 100 * (sum(pair[right] for pair in values) / sum(pair['A'] for pair in values) - 1),
            'worstPairChangePercent': 100 * (max(ratios) - 1),
            'descriptiveBootstrap95Percent': [100 * (bootstrap[index] - 1) for index in (249, 9749)],
            'fasterPairs': sum(ratio < 1 for ratio in ratios)}


def expected_schedule(order):
    assert order in ('AB', 'BA')
    result = []
    for pair, current in enumerate((order, order[::-1]), 1):
        result.extend({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm} for arm in current)
    for pair in range(1, PAIRS + 1):
        result.extend({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm}
                      for arm in (order if pair % 2 else order[::-1]))
        if pair % 3 == 0:
            control = pair // 3
            current = 'AC' if (control + (order == 'BA')) % 2 else 'CA'
            result.extend({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm} for arm in current)
    return result


def check_original_archive(path, record, source_ids=None, proof=None):
    assert path.stat().st_size == record['bytes'] and file_sha(path) == record['sha256']
    with zipfile.ZipFile(path) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert set(archive.namelist()) == set(record['members'])
        for entry in archive.infolist():
            assert not entry.is_dir()
            data = archive.read(entry)
            assert {**identity(data), 'crc32': entry.CRC} == record['members'][entry.filename]
            if entry.filename in record['omittedMembers']:
                assert source_ids is not None and proof is not None
                arm = entry.filename[-5]
                source = source_ids['arms'][arm]
                assert sha(data) == source['packageSha256']
                with zipfile.ZipFile(io.BytesIO(data)) as package:
                    assert len(package.namelist()) == len(set(package.namelist()))
                    entries = {name: sha(package.read(name)) for name in package.namelist() if not name.endswith('/')}
                    assert entries == source['entries']
                    for name, source_path in NATIVE_PATHS.items():
                        assert package.read(name) == proof.source(SOURCES[arm], source_path)


def check_retained_members(root, cell, record):
    prefix = cell + '/'
    omitted = {prefix + 'package-A.zip', prefix + 'package-B.zip'}
    assert set(record['omittedMembers']) == omitted
    assert len(record['members']) == 203 and len(record['omittedMembers']) == 2
    retained = set(record['members']) - omitted
    assert len(retained) == 201
    for name in retained:
        safe_name(name)
        assert name.startswith((prefix, cell + '-driver/'))
        data = (root / 'hosted' / name).read_bytes()
        assert identity(data) == {key: record['members'][name][key] for key in ('bytes', 'sha256')}
        assert binascii.crc32(data) == record['members'][name]['crc32']
    actual = {str(path.relative_to(root / 'hosted')) for directory in (root / 'hosted' / cell, root / 'hosted' / (cell + '-driver'))
              for path in directory.rglob('*') if path.is_file()}
    assert actual == retained


def audit_host(root, cell, record, proof, helpers, originals=None):
    validate, match, audit_memory, memory_schedule, overlay = helpers
    dictionary, order = cell.rsplit('-', 1)
    assert dictionary in DICTIONARIES and order in ('AB', 'BA')
    evidence = root / 'hosted' / cell
    metadata = read(root / 'reviews' / cell / 'artifact-metadata.json')
    assert metadata['id'] == record['id'] and metadata['size_in_bytes'] == record['bytes']
    assert metadata['digest'] == 'sha256:' + record['sha256']
    assert metadata['name'] == 'composite-window-' + cell + '-5a86'
    assert metadata['workflow_run']['id'] == RUN and metadata['workflow_run']['head_sha'] == CANDIDATE
    check_retained_members(root, cell, record)
    invocation = read(root / 'hosted' / (cell + '-driver') / 'invocation.json')
    assert type(invocation['exitCode']) is int
    assert invocation['status'] == ('complete' if invocation['exitCode'] == 0 else 'failed')
    assert invocation['candidate'] == CANDIDATE and invocation['baseline'] == BASELINE
    assert invocation['dictionary'] == dictionary and invocation['order'] == order
    assert invocation['flags'] == {} and invocation['pairs'] == PAIRS and invocation['retries'] == 0
    command = invocation['command']
    expected_command = ['dev/perf/import-qualification-20261125-a7f7.py', '--baseline', BASELINE, '--candidate', CANDIDATE,
                        '--dictionary', dictionary, '--initial-order', order, '--pairs', str(PAIRS), '--evidence', command[13]]
    if dictionary == 'vndb':
        expected_command += ['--vndb-sah-allocation-units', '37', '37']
    for entry in PACKAGE_DELTA:
        expected_command += ['--expected-package-entry', entry]
    assert command[1:] == expected_command and command[13].endswith('/' + cell)
    source_gate = invocation['sourceIdentity']
    assert source_gate['baseline'] == BASELINE and source_gate['candidate'] == CANDIDATE
    assert source_gate['candidateTree'] == TREES['B'] and set(source_gate['changedPaths']) == CHANGED_PATHS
    assert source_gate['packageEntries'] == list(PACKAGE_DELTA) and source_gate['vndbSahAllocationUnits'] == [37, 37]
    assert set(source_gate['productHashes']) == {'ext/js/dictionary/wasm/term-bank-parser.c',
                                               'dev/data/dictionary-wasm/manifest.json',
                                               'dev/data/dictionary-wasm/term-bank-parser.wasm',
                                               'test/term-bank-first-special.test.js'}
    assert set(source_gate['frozenHashes']) == {'dev/perf/import-qualification-20261125-a7f7.py',
                                              SUPPORT + 'qualification_receipts.py', 'dev/perf/benchmark-support.js',
                                              'test/chromium/extension-two-dictionary-import.e2e.js',
                                              'test/perf/dictionaries.lock.json', 'package-lock.json'}
    for path, digest in source_gate['productHashes'].items():
        assert sha(proof.source(CANDIDATE, path)) == digest
    for path, digest in source_gate['frozenHashes'].items():
        assert sha(proof.source(BASELINE, path)) == sha(proof.source(CANDIDATE, path)) == digest
    for arm in ('A', 'B'):
        assert source_gate['parserModules'][arm] == identity(proof.source(SOURCES[arm], NATIVE_PATHS[PACKAGE_DELTA[1]]))
        assert source_gate['nativeSourceHashes'][arm] == sha(proof.source(SOURCES[arm], NATIVE_PATHS[PACKAGE_DELTA[0]]))
    fixtures = json.loads(proof.source(BASELINE, 'test/perf/dictionaries.lock.json'))['dictionaries']
    assert source_gate['fixtures'] == {key: fixtures[key] for key in DICTIONARIES}
    plan = read(evidence / 'registered-plan.json')
    assert plan['baseline'] == BASELINE and plan['candidate'] == CANDIDATE and plan['dictionary'] == dictionary
    assert plan['initialOrder'] == order and plan['pairs'] == PAIRS and plan['flags'] == {} and plan['expectedWorkers'] is None
    assert plan['expectedPackageEntries'] == list(PACKAGE_DELTA)
    assert plan['schedule'] == expected_schedule(order) and plan['memorySchedule'] == memory_schedule(1 if order == 'AB' else 2)
    allocation = [37, 37] if dictionary == 'vndb' else None
    assert plan['vndbSahAllocationPolicy'] == ({'origin': 'explicit', 'rangeUnits': allocation, 'unitBytes': 4096} if allocation else None)
    observed = read(evidence / 'observations.json')
    assert len(observed) == 20 and [{key: value for key, value in item.items() if key != 'totalImportMs'} for item in observed] == plan['schedule']
    ids = read(evidence / 'source-identities.json')
    assert set(ids['arms']) == {'A', 'B'} and ids['changedPackageEntries'] == list(PACKAGE_DELTA)
    for arm in ('A', 'B'):
        source = ids['arms'][arm]
        assert source['sha'] == SOURCES[arm] and source['tree'] == TREES[arm]
        assert source['packageSha256'] == record['members'][cell + f'/package-{arm}.zip']['sha256']
        assert source['entries']['lib/term-bank-parser.wasm'] == PARSER[arm] and len(source['entries']) == 554
        assert source['fixtureLockSha256'] == FROZEN['test/perf/dictionaries.lock.json']
        assert source['lockSha256'] == sha(proof.source(SOURCES[arm], 'package-lock.json'))
        assert set(source['sourceHashes']) == SOURCE_HASH_PATHS
        for path, digest in source['sourceHashes'].items():
            if path.startswith('builds/'):
                assert path in ('builds/manabitan-chrome.zip', 'builds/manabitan-chrome-dev.zip')
                assert digest == (source['packageSha256'] if path.endswith('/manabitan-chrome.zip') else None)
            else:
                assert sha(proof.source(SOURCES[arm], path)) == digest
        for package_path, source_path in NATIVE_PATHS.items():
            data = (root / 'modules' / cell / arm / package_path).read_bytes()
            assert data == proof.source(SOURCES[arm], source_path)
            assert sha(data) == source['entries'][package_path]
    a, b = (ids['arms'][arm]['entries'] for arm in ('A', 'B'))
    assert set(a) == set(b) and {name for name in a if a[name] != b[name]} == set(PACKAGE_DELTA)
    if originals is not None:
        check_original_archive(originals / (cell + '.zip'), record, ids, proof)
    browser = read(evidence / 'browser-identity.json')
    assert browser['version'] == '153.0.8010.12'
    assert browser['sha256'] == '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e'
    original = (evidence / 'memory/harness-original.js').read_text()
    instrumented = (evidence / 'memory/harness-instrumented.js').read_text()
    assert original.encode() == proof.source(BASELINE, 'test/chromium/extension-two-dictionary-import.e2e.js')
    assert instrumented == overlay(original)
    memory_plan = read(evidence / 'memory/plan.json')
    assert memory_plan == {'authoritativeTiming': False, 'dictionary': dictionary,
                           'overlaySha256': sha(instrumented.encode()), 'replication': 1 if order == 'AB' else 2,
                           'schedule': plan['memorySchedule'], 'sourceHashes': ids['arms']}
    expected = [(item['id'], 'B' if item['arm'] == 'B' else 'A', 'sample', False) for item in observed]
    expected += [('exhaustive-media-' + arm, arm, 'all', False) for arm in ('A', 'B')]
    expected += [('memory/' + item['name'], item['arm'], 'sample', True) for item in plan['memorySchedule']]
    assert len(expected) == 26
    expected_names = {item[0] for item in expected}
    assert {str(path.parent.relative_to(evidence)) for path in evidence.rglob('summary.json')} == expected_names
    assert {str(path.parent.relative_to(evidence)) for path in evidence.rglob('canonical-receipt.json')} == expected_names
    receipts, bindings, common_hashes, policies, media_receipts = [], [], set(), set(), []
    for name, arm, media, memory in expected:
        location = evidence / name
        summary, report = read(location / 'summary.json'), read(location / 'run-1.json')
        source = ids['arms'][arm]
        hashes = source['sourceHashes'].copy()
        if memory:
            hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = sha(instrumented.encode())
        rebuilt = validate(summary, report, dictionary=dictionary, fixture=fixtures[dictionary], source_sha=source['sha'],
                           package_sha256=source['packageSha256'], browser_version=browser['version'], import_flags=None,
                           source_hashes=hashes, source_dirty=memory, media_check=media, vndb_sah_allocation_units=allocation)
        assert rebuilt == read(location / 'canonical-receipt.json')
        if receipts:
            match(receipts[0], rebuilt, compare_media=media == 'sample')
        receipts.append(rebuilt)
        if media == 'all':
            media_receipts.append(rebuilt)
        common = sha(json.dumps(rebuilt['common'], sort_keys=True).encode())
        common_hashes.add(common)
        bindings.append({'id': name, 'receiptSha256': file_sha(location / 'canonical-receipt.json'), 'commonSha256': common,
                         'termRows': rebuilt['common']['validation']['termRows'], 'media': rebuilt['media']})
        dictionaries = summary['runs'][0]['step4Breakdown']['dictionaries']
        assert len(dictionaries) == 1
        policies.add((dictionaries[0]['parserWorkerCount'], dictionaries[0]['parserGroupCount']))
        item = next((item for item in observed if item['id'] == name), None)
        if item is not None:
            assert summary['runs'][0]['totalImportMs'] == item['totalImportMs']
    match(*media_receipts)
    assert len(common_hashes) == 1 and policies == {POLICY[dictionary]}
    analysis = read(evidence / 'analysis.json')
    assert analysis['candidateVsBaseline'] == paired(observed, 'candidate', 'B')
    assert analysis['identicalCodeControl'] == paired(observed, 'control', 'C')
    memory = audit_memory(evidence / 'memory')
    assert memory == read(evidence / 'memory/memory-audit.json') and read(evidence / 'memory/semantic-failures.json') == []
    assert memory['observations'] == 4 and type(memory['everyObservationQualified']) is bool
    assert analysis['memoryPassed'] == memory['passesProspectiveMemoryScreen']
    assert analysis['status'] == ('correctness-memory-passed' if analysis['memoryPassed'] else 'memory-or-semantics-failed')
    assert (invocation['exitCode'] == 0) == analysis['memoryPassed']
    review = read(root / 'reviews' / cell / 'independent-audit.json')
    assert review['status'] == 'PASS' and review['noNewAcquisition'] is True
    assert review['artifactMetadata'] == metadata and review['archiveSha256'] == record['sha256']
    assert review['order'] == order and review['driverInvocation'] == invocation
    assert review['prescribedObservationsVerified'] == review['semanticReceiptCount'] == 26
    assert review['rawOrdinaryObservationCount'] == 20 and review['packageEntriesChecked'] == {'A': 554, 'B': 554}
    assert review['bindings'] == bindings and review['analysisRecomputed'] == analysis and review['memoryRawAudit'] == memory
    return {'imports': len(receipts), 'commonReceiptSha256': next(iter(common_hashes)), 'policy': list(POLICY[dictionary]),
            'artifactId': record['id'], 'artifactSha256': record['sha256'], 'analysis': analysis, 'memoryAudit': memory}


def audit_validation(root, record, proof):
    archive = root / 'validation/artifact.zip'
    check_original_archive(archive, record)
    metadata = read(root / 'validation/artifact-metadata.json')
    assert metadata['id'] == 15247024567 and metadata['workflow_run']['id'] == RUN and metadata['workflow_run']['head_sha'] == CANDIDATE
    assert record['bytes'] == metadata['size_in_bytes'] and 'sha256:' + record['sha256'] == metadata['digest']
    job = read(root / 'validation/job.json')
    assert job['id'] == 140852629541 and job['run_id'] == RUN and job['status'] == 'completed' and job['conclusion'] == 'success'
    steps = {step['name']: step for step in job['steps']}
    for name in ('Verify exact source and unchanged qualification guards', 'Reproduce the checked-in native artifacts',
                 'Check changed test source', 'Run the complete unit suite', 'Validate generated JSON and all build targets'):
        assert steps[name]['conclusion'] == 'success'
    with zipfile.ZipFile(archive) as original:
        assert set(original.namelist()) == {'build.log', 'json-format.log', 'native-rebuild.log', 'unit.log'}
        unit = re.sub(r'\x1b\[[0-9;]*m', '', original.read('unit.log').decode())
        assert '669 passed (669)' in unit and '15139 passed | 47 skipped (15186)' in unit
        native_text = original.read('native-rebuild.log').decode()
        native = json.loads(native_text[native_text.index('{'):])
        assert native['mode'] == 'check' and native['toolchain'] == {'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8'}
        assert {item['name']: item['sha256'] for item in native['targets']} == {
            'term-bank-parser.wasm': PARSER['B'],
            'term-content-canonical-scan-v1.wasm': '40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af'}
        builds = re.findall(r'^Building ([a-z-]+)\.\.\.$', original.read('build.log').decode(), re.M)
        assert builds == ['chrome', 'chrome-dev', 'chrome-playwright', 'firefox', 'firefox-dev', 'firefox-android', 'edge']
    log = (root / 'validation/validation-job.log').read_text()
    assert 'Ran 32 tests in ' in log and re.search(r'(?m)^\S+Z OK$', log)
    assert 'Run npx eslint test/term-bank-first-special.test.js' in log
    workflow = proof.source(CANDIDATE, '.github/workflows/composite-window-screen-5a86.yml').decode()
    assert 'npm run test:ts' not in workflow
    return {'unitPassed': 15139, 'unitSkipped': 47, 'unitFilesPassed': 669, 'receiptObserverTests': 32,
            'nativeCompiler': '21.1.8', 'nativeLinker': '21.1.8', 'buildTargets': builds,
            'sourceLint': 'Changed test source only', 'typescript': 'No TypeScript validation command in this source gate'}


def extract_retained(evidence, manifest, target):
    packed_bytes = (evidence / manifest['packedArchive']['path']).read_bytes()
    assert identity(packed_bytes) == {key: manifest['packedArchive'][key] for key in ('bytes', 'sha256')}
    packed = json.loads(packed_bytes)
    assert packed['encoding'] == 'base64' and packed['format'] == 'tar.xz'
    data = base64.b64decode(packed['data'], validate=True)
    assert identity(data) == {key: manifest['archive'][key] for key in ('bytes', 'sha256')}
    assert identity(data) == {key: packed[key] for key in ('bytes', 'sha256')}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        entries = archive.getmembers()
        assert len(entries) == len({entry.name for entry in entries})
        assert {entry.name for entry in entries} == set(manifest['members'])
        for entry in entries:
            safe_name(entry.name)
            assert entry.isfile() and entry.mode == 0o644 and entry.uid == entry.gid == entry.mtime == 0
            assert entry.uname == entry.gname == ''
            content = archive.extractfile(entry).read()
            assert identity(content) == manifest['members'][entry.name], entry.name
            path = target / entry.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)


def audit_all(root, manifest, originals=None):
    assert manifest['baseline'] == BASELINE and manifest['candidate'] == CANDIDATE and manifest['runId'] == RUN
    assert set(manifest['originalArtifacts']) == set(CELLS) | {'validation'}
    assert manifest['acquisitionRerun'] is False and manifest['pairsPerCell'] == PAIRS
    proof = GitProof(root, manifest)
    for arm in ('A', 'B'):
        tree, parents = proof.commit(SOURCES[arm])
        assert tree == TREES[arm]
        if arm == 'B':
            assert parents == [BASELINE]
    assert proof.changed(TREES['A'], TREES['B']) == CHANGED_PATHS
    support_directory = root / 'audit-support'
    support_directory.mkdir(exist_ok=True)
    for path, expected in FROZEN.items():
        revision = CANDIDATE if path in CHANGED_PATHS else BASELINE
        data = proof.source(revision, path)
        assert sha(data) == expected
        if revision == BASELINE:
            assert data == proof.source(CANDIDATE, path)
        if path.startswith(SUPPORT):
            (support_directory / Path(path).name).write_bytes(data)
    sys.path.insert(0, str(support_directory))
    from qualification_receipts import validate_import_summary, require_matching_receipts
    from audit_memory import audit_cell
    from protocol import schedule, memory_overlay
    helpers = (validate_import_summary, require_matching_receipts, audit_cell, schedule, memory_overlay)
    cells = {cell: audit_host(root, cell, manifest['originalArtifacts'][cell], proof, helpers, originals) for cell in CELLS}
    jobs = read(root / 'preservation/final-jobs.json')['jobs']
    assert len(jobs) == len({job['id'] for job in jobs}) == 7
    jobs = {job['id']: job for job in jobs}
    assert set(jobs) == set(HOST_JOBS.values()) | {140852629541}
    for cell, job_id in HOST_JOBS.items():
        job = jobs[job_id]
        dictionary, order = cell.rsplit('-', 1)
        assert job['run_id'] == RUN and job['status'] == 'completed'
        assert job['name'] == dictionary + ' complete import (' + order + ')'
        assert job['conclusion'] == ('success' if cells[cell]['analysis']['memoryPassed'] else 'failure')
    for dictionary in DICTIONARIES:
        assert cells[dictionary + '-AB']['commonReceiptSha256'] == cells[dictionary + '-BA']['commonReceiptSha256']
    validation = audit_validation(root, manifest['originalArtifacts']['validation'], proof)
    if originals is not None:
        check_original_archive(originals / 'validation.zip', manifest['originalArtifacts']['validation'])
    return {'status': 'PASS', 'noNewAcquisition': True, 'baseline': BASELINE, 'candidate': CANDIDATE, 'runId': RUN,
            'cells': cells, 'imports': sum(value['imports'] for value in cells.values()),
            'rawMemoryScans': sum(value['memoryAudit']['rawScanCount'] for value in cells.values()),
            'originalProductZipBytesReverified': originals is not None, 'validation': validation,
            'limits': ['Per-host descriptive bootstrap intervals; AB/BA hosts and same-code controls remain separate.',
                       'Lexical receipts sample terms; complete-corpus parity is preserved by a separate study.',
                       'Memory maxima are sampled and must pass the unchanged prospective gate.',
                       'The compact archive cannot reconstruct or rehash the omitted original product ZIP payloads. '
                       'Supply the original six host artifact ZIPs to repeat that byte-level package audit.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=Path(__file__).resolve().parent / 'composite-window-5a86/hosted')
    parser.add_argument('--original-artifacts', type=Path,
                        help='Directory containing jmdict-AB.zip, jmdict-BA.zip, jitendex-AB.zip, jitendex-BA.zip, vndb-AB.zip, vndb-BA.zip and validation.zip')
    args = parser.parse_args()
    manifest = read(args.evidence / 'manifest.json.txt')
    assert file_sha(Path(__file__)) == manifest['auditorSha256']
    with tempfile.TemporaryDirectory(prefix='composite-window-evidence-') as directory:
        root = Path(directory)
        extract_retained(args.evidence, manifest, root)
        result = audit_all(root, manifest, args.original_artifacts)
        previous = read(root / 'preservation/full-originals-audit.json')
        assert previous['originalProductZipBytesReverified'] is True
        previous['originalProductZipBytesReverified'] = args.original_artifacts is not None
        assert result == previous
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
