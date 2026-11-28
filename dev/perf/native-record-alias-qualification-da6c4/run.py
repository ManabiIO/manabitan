#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Exact-source hosted native-alias verification, browser proof and fixed cells."""
import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import traceback
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BASELINE = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
NATURAL_CANDIDATE = '2c02336b135ee01661ca2a788395afec75e66712'
CANDIDATE = 'cce6353276f92b80fc6c377bf543354ea59edce3'
TREES = {'A': 'd911260f1a57f518d59b3a12127fcc3b2293c918', 'B': 'b65955a62da72c55e24a681011684601fa089f07'}
CANDIDATE_TEST_AMENDMENT = json.loads((HERE / 'candidate-test-amendment.json').read_text())
PROTOCOL_BLOB = '7801b5fd696fffe4f250b98a19d6d80406518705'
HARNESS = 'test/chromium/extension-two-dictionary-import.e2e.js'
MEMORY_DIRECTORY = 'dev/perf/import-memory-20261125-a7f7'
PROVENANCE_PATHS = (
    'package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/benchmark-support.js',
    'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js',
    'test/chromium/import-flags-ab-benchmark.js', HARNESS, 'test/e2e/import-timing.js',
    'ext/js/pages/settings/dictionary-import-controller.js', 'builds/manabitan-chrome-dev.zip',
    'builds/manabitan-chrome.zip',
)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.partial')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')
    temporary.replace(path)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def same(actual, expected, message):
    require(json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True, allow_nan=False), message)


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def copy_dependency_tree(source, destination):
    """Use the stock qualifier's real ignored directory and shared immutable files."""
    shutil.copytree(source, destination, copy_function=os.link, symlinks=True)


def verify_candidate_test_amendment(root):
    amendment = CANDIDATE_TEST_AMENDMENT
    same(amendment['naturalCandidate'], NATURAL_CANDIDATE, 'Wrong historical natural candidate')
    same(amendment['candidate'], CANDIDATE, 'Wrong test-only candidate')
    same(amendment['candidateTree'], TREES['B'], 'Wrong test-only candidate tree')
    same(git(root, 'rev-list', '--parents', '-n', '1', CANDIDATE),
         CANDIDATE + ' ' + NATURAL_CANDIDATE, 'Test-only amendment must have exactly the natural candidate parent')
    for commit, expected_tree, expected_blob in (
        (NATURAL_CANDIDATE, amendment['naturalCandidateTree'], amendment['beforeBlob']),
        (CANDIDATE, amendment['candidateTree'], amendment['afterBlob']),
    ):
        same(git(root, 'rev-parse', commit + '^{tree}'), expected_tree, 'Amended source tree differs')
        same(git(root, 'rev-parse', commit + ':ext'), amendment['runtimeExtTree'], 'Runtime subtree changed')
        same(git(root, 'rev-parse', commit + ':' + amendment['changedPath']), expected_blob, 'Amended test blob differs')
    same(git(root, 'diff-tree', '--no-commit-id', '--name-status', '-r', NATURAL_CANDIDATE, CANDIDATE),
         'M\t' + amendment['changedPath'], 'Unexpected product amendment paths')
    return dict(amendment)


def package_entries(filename):
    with zipfile.ZipFile(filename) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Duplicate package member')
        return {item.filename: hashlib.sha256(archive.read(item)).hexdigest() for item in archive.infolist() if not item.is_dir()}


class Study:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.repository).resolve()
        self.evidence = Path(args.evidence).resolve()
        self.evidence.mkdir(parents=True, exist_ok=False)
        self.work = self.evidence.parent / (self.evidence.name + '-sources')
        self.work.mkdir(exist_ok=False)
        self.state = {'schemaVersion': 1, 'complete': False, 'mode': args.mode,
                      'dictionary': args.dictionary, 'initialOrder': args.initial_order,
                      'baseline': BASELINE, 'candidate': CANDIDATE, 'phase': 'created',
                      'commands': [], 'failures': [], 'cleanupFailures': [], 'observations': []}
        self.save_state()
        self.sources = {}
        self.identities = {}
        self.original_harness = None
        self.overlay = None
        self.overlay_info = None
        self.memory_overlay = None
        self.current_overlays = {}
        self.comparator = None
        self.reference = None
        self.source_manifest = json.loads((HERE / 'source-manifest.json').read_text())
        self.source_manifest_sha256 = digest(HERE / 'source-manifest.json')
        self.plan = json.loads((HERE / 'plan.json').read_text())
        self.node = subprocess.check_output(['node', '--version'], text=True).strip()
        same(self.node, 'v22.22.0', 'Node qualification version changed')
        require(os.environ.get('GITHUB_ACTIONS') == 'true', 'This acquisition is hosted-only')
        self.research_commit = git(self.root, 'rev-parse', 'HEAD')
        self.research_tree = git(self.root, 'rev-parse', 'HEAD^{tree}')
        same(self.research_commit, os.environ.get('GITHUB_SHA'), 'Research HEAD differs from workflow event SHA')
        same(git(self.root, 'status', '--porcelain'), '', 'Research checkout is dirty')
        self.verify_controls()
        self.env = dict(os.environ, MANABITAN_E2E_STRICT_RUNTIME='1', MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK='0',
                        MANABITAN_CHROMIUM_HEADLESS='1', MANABITAN_CHROMIUM_BROWSER='chromium',
                        PYTHONDONTWRITEBYTECODE='1')
        os.environ.update({key: self.env[key] for key in ('MANABITAN_E2E_STRICT_RUNTIME', 'MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK',
                                                       'MANABITAN_CHROMIUM_HEADLESS', 'MANABITAN_CHROMIUM_BROWSER', 'PYTHONDONTWRITEBYTECODE')})
        self.oracle = self.unpack_oracles()
        self.core = json.loads(self.oracle['core'].read_text())
        same(self.core['complete'], True, 'Natural proof incomplete')
        same(self.core['baseline'], BASELINE, 'Stale natural baseline')
        same(self.core['candidate'], NATURAL_CANDIDATE, 'Wrong historical natural candidate')
        self.native = {arm: json.loads(self.oracle['pipeline-' + arm].read_text()) for arm in ('A', 'B')}
        self.fixture = json.loads((self.root / 'test/perf/dictionaries.lock.json').read_text())['dictionaries'][args.dictionary]
        write_json(self.evidence / 'host-identity.json', {
            'platform': platform.platform(), 'uname': list(platform.uname()), 'node': self.node,
            'python': platform.python_version(), 'cpuCount': os.cpu_count(),
            'cpuInfo': Path('/proc/cpuinfo').read_text(), 'memInfo': Path('/proc/meminfo').read_text(),
            'researchCommit': self.research_commit, 'researchTree': self.research_tree,
            'githubRunId': os.environ.get('GITHUB_RUN_ID'), 'githubRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
            'githubJob': os.environ.get('GITHUB_JOB'), 'sourceManifestSha256': self.source_manifest_sha256,
        })

    def save_state(self):
        write_json(self.evidence / 'run-state.json', self.state)

    def phase(self, name):
        self.state['phase'] = name
        self.save_state()
        print(json.dumps({'kind': 'phase', 'phase': name}), flush=True)

    def run(self, command, cwd, log, env=None):
        log = Path(log)
        entry = {'command': list(map(str, command)), 'cwd': str(cwd), 'log': str(log),
                 'startedUnixMs': time.time_ns() // 1000000, 'exitCode': None}
        self.state['commands'].append(entry)
        self.save_state()
        with log.open('xb') as output:
            completed = subprocess.run(command, cwd=cwd, env=env or self.env, stdout=output, stderr=subprocess.STDOUT)
        entry['exitCode'] = completed.returncode
        entry['finishedUnixMs'] = time.time_ns() // 1000000
        self.save_state()
        require(completed.returncode == 0, f'Command failed ({completed.returncode}); exact log: {log}')

    def verify_controls(self):
        same(digest(HERE / 'source-manifest.json'), self.source_manifest_sha256, 'Control manifest changed')
        same(self.source_manifest['baseline'], BASELINE, 'Control baseline changed')
        same(self.source_manifest['candidate'], CANDIDATE, 'Control candidate changed')
        same(self.source_manifest['naturalCandidate'], NATURAL_CANDIDATE, 'Historical natural identity changed')
        same(self.source_manifest['candidateTestAmendment'], CANDIDATE_TEST_AMENDMENT, 'Test-only source amendment changed')
        same(self.plan['candidateTestAmendment'], CANDIDATE_TEST_AMENDMENT, 'Plan test-only source amendment changed')
        same(self.source_manifest['protocolBlob'], PROTOCOL_BLOB, 'Protocol Git blob changed')
        same(git(self.root, 'rev-parse', 'HEAD'), self.research_commit, 'Research checkout moved')
        same(git(self.root, 'rev-parse', 'HEAD^{tree}'), self.research_tree, 'Research tree changed')
        same(git(self.root, 'status', '--porcelain'), '', 'Research control checkout changed')
        for relative, expected in self.source_manifest['files'].items():
            same(digest(self.root / relative), expected, 'Control bytes changed: ' + relative)
        same(digest(self.root / self.source_manifest['workflowPath']), self.source_manifest['workflowSha256'], 'Workflow bytes changed')
        same(git(self.root, 'hash-object', str(HERE / 'protocol.json')), PROTOCOL_BLOB, 'Protocol bytes differ from its frozen Git blob')

    def unpack_oracles(self):
        output = self.evidence / 'natural-oracle'
        output.mkdir()
        result = {}
        for name, item in self.source_manifest['oracles'].items():
            source = self.root / item['path']
            same(digest(source), item['storedSha256'], 'Oracle stored bytes changed')
            data = gzip.decompress(source.read_bytes()) if item['gzip'] else source.read_bytes()
            same(len(data), item['bytes'], 'Oracle decoded size changed')
            same(hashlib.sha256(data).hexdigest(), item['sha256'], 'Oracle decoded bytes changed')
            destination = output / (name + '.json')
            destination.write_bytes(data)
            result[name] = destination
        return result

    def capture_setup_state(self, target, arm, stage):
        """Keep original status/diffs and generated hashes before enforcing cleanliness."""
        prefix = self.evidence / f'source-{arm}-{stage}'
        status = subprocess.check_output(['git', 'status', '--porcelain=v1', '--untracked-files=all'],
                                         cwd=target, text=True)
        (prefix.with_suffix('.porcelain.txt')).write_text(status)
        diff_paths = {}
        for name, extra in (('working', []), ('staged', ['--cached'])):
            data = subprocess.check_output(['git', 'diff', '--no-ext-diff', '--binary', *extra], cwd=target)
            filename = prefix.with_name(prefix.name + '-' + name + '.diff')
            filename.write_bytes(data)
            diff_paths[name] = {'path': filename.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        generated = [target / 'ext/manifest.json', target / 'ext/legal-npm.html',
                     target / 'builds/manabitan-chrome.zip']
        library = target / 'ext/lib'
        if library.is_dir():
            generated.extend(path for path in library.rglob('*') if path.is_file())
        hashes = [{'path': path.relative_to(target).as_posix(),
                   'bytes': path.stat().st_size if path.is_file() else None,
                   'sha256': digest(path) if path.is_file() else None} for path in sorted(set(generated))]
        untracked_names = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=target).decode().split('\0')
        untracked = []
        for relative in filter(None, untracked_names):
            path = target / relative
            if path.is_symlink():
                details = {'kind': 'symlink', 'target': os.readlink(path)}
            elif path.is_file():
                details = {'kind': 'file', 'bytes': path.stat().st_size, 'sha256': digest(path)}
            else:
                details = {'kind': 'other'}
            untracked.append({'path': relative, **details})
        receipt = {'arm': arm, 'stage': stage, 'gitHead': git(target, 'rev-parse', 'HEAD'),
                   'gitTree': git(target, 'rev-parse', 'HEAD^{tree}'), 'rawPorcelain': status,
                   'diffs': diff_paths, 'generated': hashes, 'untracked': untracked}
        write_json(prefix.with_suffix('.json'), receipt)
        print(json.dumps({'kind': 'source-setup-state', **receipt}), flush=True)
        return status.strip()

    def setup_sources(self):
        self.phase('source-and-release-package-setup')
        self.run(['python', '-m', 'unittest', '-v', 'test_setup_sources.py', 'test_candidate_identity.py'], HERE,
                 self.evidence / 'dependency-setup-test.log')
        tooling = {}
        tree_output = git(self.root, 'ls-tree', '-r', BASELINE, '--', 'dev/perf', 'test/chromium', 'test/e2e', '.github/actions/setup')
        for line in tree_output.splitlines():
            metadata, relative = line.split('\t', 1)
            _, kind, blob = metadata.split()
            if kind == 'blob' and relative.endswith(('.js', '.mjs', '.py', '.html', '.json', '.yml')):
                tooling[relative] = blob
        (self.root / 'builds/e2e-dictionary-cache').mkdir(parents=True, exist_ok=True)
        for arm, commit in (('A', BASELINE), ('B', CANDIDATE)):
            target = self.work / arm
            self.run(['git', 'worktree', 'add', '--detach', '--no-checkout', str(target), commit], self.root, self.evidence / f'worktree-{arm}.log')
            self.run(['git', 'sparse-checkout', 'set', '--no-cone', '/*', '!/builds/perf/'], target, self.evidence / f'sparse-{arm}.log')
            self.run(['git', 'checkout', '--detach', commit], target, self.evidence / f'checkout-{arm}.log')
            same(git(target, 'rev-parse', 'HEAD'), commit, 'Wrong runtime source')
            same(git(target, 'rev-parse', 'HEAD^{tree}'), TREES[arm], 'Wrong complete runtime tree')
            same(git(target, 'status', '--porcelain'), '', 'Runtime checkout dirty before build')
            if arm == 'B':
                write_json(self.evidence / 'candidate-test-amendment.json', verify_candidate_test_amendment(target))
            for relative in ('package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json'):
                require((target / relative).read_bytes() == (self.root / relative).read_bytes(), 'Research/dependency/fixture mismatch: ' + relative)
            for relative, blob in tooling.items():
                same(git(target, 'hash-object', relative), blob, 'Runtime benchmark tooling differs: ' + relative)
            before_dependencies = self.capture_setup_state(target, arm, 'before-dependencies')
            same(before_dependencies, '', 'Runtime changed before dependency setup: ' + repr(before_dependencies))
            copy_dependency_tree(self.root / 'node_modules', target / 'node_modules')
            (target / 'builds').mkdir(exist_ok=True)
            (target / 'builds/e2e-dictionary-cache').symlink_to(self.root / 'builds/e2e-dictionary-cache', target_is_directory=True)
            after_dependencies = self.capture_setup_state(target, arm, 'after-dependencies')
            same(after_dependencies, '', 'Runtime changed during dependency setup: ' + repr(after_dependencies))
            self.run(['npm', 'run', 'build:libs'], target, self.evidence / f'libs-{arm}.log')
            self.run(['npm', 'run', 'license-report:html'], target, self.evidence / f'license-{arm}.log')
            self.run(['npm', 'run', 'build', '--', '--target', 'chrome'], target, self.evidence / f'build-{arm}.log')
            after_build = self.capture_setup_state(target, arm, 'after-build')
            same(after_build, '', 'Runtime changed during release build: ' + repr(after_build))
            original = (target / HARNESS).read_text()
            if self.original_harness is None:
                self.original_harness = original
            same(original, self.original_harness, 'A/B stock harness differs')
            if arm == 'A':
                self.run(['node', str(HERE / 'test-runtime-source-guard.mjs'), str(target / 'ext/lib')],
                         self.root, self.evidence / 'runtime-source-guard-tests.log')
            natural_runtime = self.native[arm]['configuration']['sourceHashes']
            compatibility_config = self.evidence / f'runtime-source-proof-config-{arm}.json'
            compatibility_path = self.evidence / f'runtime-source-proof-{arm}.json'
            write_json(compatibility_config, {'root': str(target), 'naturalSourceHashes': natural_runtime})
            self.run(['node', str(HERE / 'runtime-source-guard.mjs'), str(compatibility_config), str(compatibility_path)],
                     self.root, self.evidence / f'runtime-source-proof-{arm}.log')
            compatibility = json.loads(compatibility_path.read_text())
            same(compatibility['complete'], True, 'Runtime source proof incomplete')
            same(compatibility['naturalSourceHashes'], natural_runtime, 'Wrong natural source proof inputs')
            same(compatibility['proofSha256'], digest(HERE / 'generated-runtime-source-proof.json'), 'Wrong fixed source proof')
            runtime = compatibility['actualSourceHashes']
            archive = target / 'builds/manabitan-chrome.zip'
            runtime_manifest = {'commit': commit, 'tree': TREES[arm], 'files': runtime,
                                'candidateTestAmendment': CANDIDATE_TEST_AMENDMENT,
                                'naturalSourceHashes': natural_runtime,
                                'generatedRuntimeSourceProofSha256': compatibility['proofSha256'],
                                'runtimeSourceProofReceiptSha256': digest(compatibility_path)}
            manifest_path = self.evidence / f'runtime-manifest-{arm}.json'
            write_json(manifest_path, runtime_manifest)
            identity = {'commit': commit, 'tree': TREES[arm], 'runtimeHashes': runtime,
                        'toolingHashes': {relative: digest(target / relative) for relative in tooling if relative != HARNESS},
                        'sourceManifestPath': str(manifest_path), 'sourceManifestSha256': digest(manifest_path),
                        'generatedRuntimeSourceProofSha256': compatibility['proofSha256'],
                        'runtimeSourceProofReceiptSha256': digest(compatibility_path),
                        'packageSha256': digest(archive), 'entries': package_entries(archive),
                        'sourceHashes': {relative: digest(target / relative) if (target / relative).is_file() else None for relative in PROVENANCE_PATHS}}
            self.sources[arm] = target
            self.identities[arm] = identity
            shutil.copyfile(archive, self.evidence / f'package-{arm}.zip')
            write_json(self.evidence / 'source-identities.json', self.identities)
        left, right = self.identities['A']['entries'], self.identities['B']['entries']
        changed = sorted(name for name in left.keys() & right.keys() if left[name] != right[name])
        added, removed = sorted(right.keys() - left.keys()), sorted(left.keys() - right.keys())
        same(changed, sorted(self.plan['expectedChangedPackageEntries']), 'Unexpected package content changes')
        same(added, sorted(self.plan['expectedAddedPackageEntries']), 'Unexpected package additions')
        same(removed, [], 'Unexpected package removals')
        write_json(self.evidence / 'package-delta.json', {'changed': changed, 'added': added, 'removed': removed})
        sys.path.insert(0, str(self.sources['A'] / MEMORY_DIRECTORY))
        from qualification_receipts import validate_import_summary
        from protocol import memory_overlay, memory_comparison, schedule as memory_schedule
        from chromium_memory import run_with_sampling
        from audit_memory import audit_cell
        from harness_overlay import layout_overlay
        from receipt_adapter import AliasReceiptComparator
        self.validate_import_summary = validate_import_summary
        self.memory_comparison = memory_comparison
        self.memory_schedule = memory_schedule
        self.run_with_sampling = run_with_sampling
        self.audit_cell = audit_cell
        self.Comparator = AliasReceiptComparator
        self.overlay, self.overlay_info = layout_overlay(self.original_harness, HERE / 'browser-layout-export.mjs', self.source_manifest['stockHarnessSha256'])
        self.memory_overlay = memory_overlay(self.overlay)
        write_json(self.evidence / 'harness-overlay.json', self.overlay_info)
        (self.evidence / 'harness-original.js').write_text(self.original_harness)
        (self.evidence / 'harness-layout.js').write_text(self.overlay)
        (self.evidence / 'harness-memory-layout.js').write_text(self.memory_overlay)
        self.verify_controls()

    def set_overlay(self, text):
        for arm, target in self.sources.items():
            expected = self.current_overlays.get(arm, self.original_harness)
            same((target / HARNESS).read_text(), expected, 'Harness changed outside controlled overlay')
            (target / HARNESS).write_text(text)
            self.current_overlays[arm] = text

    def guard_sources(self):
        self.verify_controls()
        for arm, target in self.sources.items():
            identity = self.identities[arm]
            same(git(target, 'rev-parse', 'HEAD'), identity['commit'], 'Runtime HEAD moved')
            same(git(target, 'rev-parse', 'HEAD^{tree}'), identity['tree'], 'Runtime tree changed')
            expected_harness = self.current_overlays.get(arm, self.original_harness)
            expected_status = '' if expected_harness == self.original_harness else 'M ' + HARNESS
            same(git(target, 'status', '--porcelain'), expected_status, 'Unexpected runtime working-tree changes')
            same((target / HARNESS).read_text(), expected_harness, 'Controlled harness drift')
            for relative, expected in identity['runtimeHashes'].items():
                same(digest(target / relative), expected, 'Runtime bytes changed: ' + relative)
            for relative, expected in identity['toolingHashes'].items():
                same(digest(target / relative), expected, 'Benchmark tooling changed: ' + relative)
            same(digest(target / 'builds/manabitan-chrome.zip'), identity['packageSha256'], 'Release package drift')
            same(digest(identity['sourceManifestPath']), identity['sourceManifestSha256'], 'Runtime manifest changed')

    def verify_gates(self):
        self.phase('exact-candidate-repository-gates')
        target = self.sources['B']
        commands = [
            ('javascript', ['npm', 'run', 'test:js']),
            ('types', ['npm', 'run', 'test:ts']),
            ('css', ['npm', 'run', 'test:css']), ('html', ['npm', 'run', 'test:html']),
            ('markdown', ['npm', 'run', 'test:md']), ('json-format', ['npm', 'run', 'test:json:format']),
            ('json-types', ['npm', 'run', 'test:json:types', '--', '--maxWorkers=2']),
            ('complete-unit-inventory', ['npm', 'run', 'test:unit', '--', '--maxWorkers=2']),
            ('unit-options', ['npm', 'run', 'test:unit:options', '--', '--maxWorkers=2']),
            ('current-wasm-rebuild', ['npm', 'run', 'build:dictionary-wasm', '--', '--check']),
            ('all-target-build', ['npm', 'run', 'test:build']),
        ]
        for name, command in commands:
            self.phase('gate-' + name)
            capped_env = dict(self.env, NODE_OPTIONS='--max-old-space-size=3072')
            self.run(command, target, self.evidence / ('gate-' + name + '.log'), capped_env)
            self.guard_sources()
        write_json(self.evidence / 'repository-gates.json', {'complete': True, 'candidate': CANDIDATE, 'tree': TREES['B'],
                   'commands': commands, 'allTestFilesRetained': True, 'maxUnitWorkers': 2, 'noRetries': True})

    def prepare_browser(self):
        self.phase('pinned-fixture-browser-and-helper-gates')
        self.run(['node', 'dev/perf/prepare-dictionaries.js', self.args.dictionary], self.sources['A'], self.evidence / 'fixtures.log')
        fixture_path = self.root / 'builds/e2e-dictionary-cache' / self.fixture['cacheFile']
        same(fixture_path.stat().st_size, self.fixture['sizeBytes'], 'Fixture size changed')
        same(digest(fixture_path), self.fixture['sha256'], 'Fixture checksum changed')
        binary = Path(subprocess.check_output(['node', '--input-type=module', '-e',
                      "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"], cwd=self.root, text=True))
        version_output = subprocess.check_output([str(binary), '--version'], text=True).strip()
        match = re.search(r'\d+\.\d+\.\d+\.\d+', version_output)
        require(match is not None, 'Chromium identity missing')
        self.browser_version = match.group(0)
        self.browser = {'executable': str(binary), 'sha256': digest(binary), 'version': self.browser_version, 'versionOutput': version_output}
        write_json(self.evidence / 'browser-identity.json', self.browser)
        self.run(['node', '--test', '--test-concurrency=1', str(HERE / 'test-browser-layout-export.mjs')],
                 self.root, self.evidence / 'export-helper-tests.log')
        self.run(['node', str(HERE / 'archived/raw-alias-node-opfs.test.mjs'), str(HERE / 'archived/raw-alias-node-opfs.mjs')],
                 self.root, self.evidence / 'decoder-adapter-tests.log')
        helper_env = dict(self.env, MANABITAN_RECEIPT_SOURCE=str(self.sources['A']))
        self.run(['python', '-m', 'unittest', '-v', 'test_receipt_adapter.py', 'test_probe_projection.py',
                  'test_qualification_stats.py', 'test_pack_artifacts.py', 'test_browser_proof.py'],
                 HERE, self.evidence / 'receipt-stats-tests.log', helper_env)
        self.set_overlay(self.overlay)
        self.guard_sources()
        write_json(self.evidence / 'pre-acquisition-binding.json', {
            'complete': True, 'mode': self.args.mode, 'researchCommit': self.research_commit, 'researchTree': self.research_tree,
            'githubSha': os.environ.get('GITHUB_SHA'), 'sourceManifestSha256': self.source_manifest_sha256,
            'workflowSha256': self.source_manifest['workflowSha256'], 'protocolBlob': PROTOCOL_BLOB,
            'protocolSha256': digest(HERE / 'protocol.json'), 'planSha256': digest(HERE / 'plan.json'),
            'naturalCoreSha256': digest(self.oracle['core']), 'sourceIdentities': self.identities,
            'overlay': self.overlay_info, 'memoryOverlaySha256': hashlib.sha256(self.memory_overlay.encode()).hexdigest(),
            'browser': self.browser, 'fixture': self.fixture, 'node': self.node,
        })

    def common_binding(self):
        return {'schemaVersion': 1, 'baseline': BASELINE, 'candidate': CANDIDATE, 'protocolBlob': PROTOCOL_BLOB,
                'naturalCandidate': NATURAL_CANDIDATE, 'candidateTestAmendment': CANDIDATE_TEST_AMENDMENT,
                'dictionary': self.args.dictionary, 'fixtureSha256': self.fixture['sha256'],
                'exporterSha256': digest(HERE / 'browser-layout-export.mjs'),
                'receiptAdapterSha256': digest(HERE / 'receipt_adapter.py'),
                'sources': {arm: {key: identity[key] for key in ('commit', 'tree', 'sourceManifestSha256', 'packageSha256')}
                            for arm, identity in self.identities.items()}}

    def observation(self, name, arm, *, media='sample', export=False, memory_item=None):
        self.phase(name)
        self.guard_sources()
        source_arm = 'B' if arm == 'B' else 'A'
        target, identity = self.sources[source_arm], self.identities[source_arm]
        output = self.evidence / name
        output.mkdir(parents=True, exist_ok=False)
        layout_path = output / 'layout/layout.json'
        request = {'schemaVersion': 1, 'baseline': BASELINE, 'candidate': CANDIDATE, 'protocolBlob': PROTOCOL_BLOB,
                   'observationId': name, 'arm': arm, 'mode': 'export' if export else 'hash-only',
                   'dictionary': self.args.dictionary, 'sourceCommit': identity['commit'], 'sourceTree': identity['tree'],
                   'sourceManifestSha256': identity['sourceManifestSha256'], 'packageSha256': identity['packageSha256'],
                   'exporterSha256': digest(HERE / 'browser-layout-export.mjs'), 'fixtureSha256': self.fixture['sha256'],
                   'termFiles': self.plan['termFiles'][self.args.dictionary], 'outputDirectory': str(output / 'layout')}
        request_path = output / 'layout-request.json'
        write_json(request_path, request)
        require(not layout_path.exists() and not (output / 'summary.json').exists(), 'Observation output was reused')
        custom_env = dict(self.env, MANABITAN_ALIAS_LAYOUT_REQUEST=str(request_path))
        self.run(['node', str(self.sources['A'] / 'dev/perf/host-environment.js')], self.sources['A'], output / 'host-before.json')
        command = ['node', 'dev/perf/import-benchmark.js', self.args.dictionary, '--runs', '1', '--no-build',
                   '--build-target', 'chrome', '--media-check', media, '--output', str(output)]
        sampled = None
        if memory_item is None:
            self.run(command, target, output / 'run.log', custom_env)
        else:
            previous = os.environ.get('MANABITAN_ALIAS_LAYOUT_REQUEST')
            os.environ['MANABITAN_ALIAS_LAYOUT_REQUEST'] = str(request_path)
            try:
                sampled = self.run_with_sampling(command, target, output / 'run.log', output / 'memory.json', output / 'markers.jsonl')
            except Exception as error:
                write_json(output / 'sampling-failure.json', {'type': type(error).__name__, 'message': str(error), 'retried': False})
                raise
            finally:
                if previous is None:
                    os.environ.pop('MANABITAN_ALIAS_LAYOUT_REQUEST', None)
                else:
                    os.environ['MANABITAN_ALIAS_LAYOUT_REQUEST'] = previous
        summary = json.loads((output / 'summary.json').read_text())
        raw = json.loads((output / 'run-1.json').read_text())
        hashes = identity['sourceHashes'].copy()
        hashes[HARNESS] = hashlib.sha256(self.current_overlays[source_arm].encode()).hexdigest()
        receipt = self.validate_import_summary(summary, raw, dictionary=self.args.dictionary, fixture=self.fixture,
            source_sha=identity['commit'], package_sha256=identity['packageSha256'], browser_version=self.browser_version,
            import_flags=None, source_hashes=hashes, source_dirty=True, media_check=media,
            vndb_sah_allocation_units=(37, 37) if self.args.dictionary == 'vndb' else None)
        write_json(output / 'canonical-receipt.json', receipt)
        layout = json.loads(layout_path.read_text())
        same(layout['request'], request, 'Layout receipt is not this exact fresh observation request')
        same(json.loads(request_path.read_text()), request, 'Request changed during observation')
        checked = None
        if self.comparator is not None:
            checked = self.comparator.check(receipt, layout, arm)
            if self.reference is not None:
                self.comparator.compare(self.reference[0], receipt, self.reference[1], arm, compare_media=self.reference[2] == media)
            else:
                self.reference = (receipt, arm, media)
        elapsed = summary['runs'][0]['totalImportMs']
        require(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed > 0, 'Invalid complete import endpoint')
        self.guard_sources()
        self.run(['node', str(self.sources['A'] / 'dev/perf/host-environment.js')], self.sources['A'], output / 'host-after.json')
        item = {'name': name, 'arm': arm, 'sourceArm': source_arm, 'media': media, 'export': export,
                'authoritativeTiming': memory_item is None and not export and name.startswith(('pair-', 'control-')),
                'totalImportMs': elapsed, 'summarySha256': digest(output / 'summary.json'),
                'reportSha256': digest(output / 'run-1.json'), 'layoutSha256': digest(layout_path), 'checked': checked}
        write_json(output / 'observation.json', item)
        self.state['observations'].append(item)
        self.save_state()
        print(json.dumps({'kind': 'observation', **item}), flush=True)
        return {'receipt': receipt, 'layoutPath': str(layout_path), 'layout': layout, 'output': output,
                'totalImportMs': elapsed, 'sampled': sampled}

    def preflight(self):
        require(self.args.dictionary == 'vndb', 'Full layout preflight is VNDB-only')
        from browser_proof import bind_preflight
        arms = {}
        for arm in self.args.initial_order:
            item = self.observation('browser-preflight-' + arm, arm, media='all', export=True)
            output, identity = item['output'], self.identities[arm]
            config = {
                'schemaVersion': 1, 'mode': 'browser-export-verification', 'arm': arm, 'protocolBlob': PROTOCOL_BLOB,
                'root': str(self.sources[arm]), 'opfsDirectory': str(output / 'layout/opfs'),
                'reportPath': str(output / 'browser-verification.json'),
                'pipelineReport': str(self.oracle['pipeline-' + arm]),
                'pipelineReportSha256': self.core['arms'][arm]['pipelineSha256'],
                'naturalVerificationReport': str(self.oracle['verification-' + arm]),
                'naturalVerificationReportSha256': self.core['arms'][arm]['verificationSha256'],
                'naturalComparisonReport': str(self.oracle['comparison']),
                'naturalComparisonReportSha256': self.core['comparisonSha256'],
                'naturalCoreReport': str(self.oracle['core']), 'naturalCoreSha256': digest(self.oracle['core']),
                'browserLayoutReport': item['layoutPath'], 'browserLayoutReportSha256': digest(item['layoutPath']),
                'expectedCommit': identity['commit'], 'expectedTree': identity['tree'],
                'candidateTestAmendment': CANDIDATE_TEST_AMENDMENT,
                'expectedGitStatus': git(self.sources[arm], 'status', '--porcelain'),
                'packageSha256': identity['packageSha256'], 'sourceManifestSha256': identity['sourceManifestSha256'],
                'sourceManifestPath': identity['sourceManifestPath'],
                'harnessOverlaySha256': hashlib.sha256(self.overlay.encode()).hexdigest(),
                'exporterSha256': digest(HERE / 'browser-layout-export.mjs'), 'fixtureSha256': self.fixture['sha256'],
                'verifierSourceSha256': digest(HERE / 'browser-verify.mjs'),
                'dependencyHashes': {name: digest(HERE / name) for name in ('product-common.mjs', 'archived/raw-alias-node-opfs.mjs',
                                                                          'runtime-source-guard.mjs', 'generated-runtime-source-proof.json',
                                                                          'candidate-test-amendment.json')},
            }
            write_json(output / 'browser-verifier-config.json', config)
            self.run(['node', '--expose-gc', str(HERE / 'browser-verify.mjs'), str(output / 'browser-verifier-config.json')],
                     self.root, output / 'browser-verifier.log')
            item['verificationPath'] = str(output / 'browser-verification.json')
            arms[arm] = item
        binding = bind_preflight(core=self.core, core_sha256=digest(self.oracle['core']),
                                 comparison_path=self.oracle['comparison'], arms=arms, common_binding=self.common_binding())
        self.guard_sources()
        write_json(self.evidence / 'browser-preflight-binding.json', binding)
        proof = {'schemaVersion': 1, 'complete': True, 'baseline': BASELINE, 'candidate': CANDIDATE,
                 'protocolBlob': PROTOCOL_BLOB, 'researchCommit': self.research_commit, 'researchTree': self.research_tree,
                 'sourceManifestSha256': self.source_manifest_sha256, 'naturalCoreSha256': digest(self.oracle['core']),
                 'bindingSha256': digest(self.evidence / 'browser-preflight-binding.json'), 'binding': binding,
                 'scope': 'Untimed actual full-browser all-media/restart/export proof. No timing gain. The exact natural logical/canonical/normal-span proof transfers through complete same-arm normalized term-file equality.'}
        write_json(self.evidence / 'preflight-gate.json', proof)
        print(json.dumps({'kind': 'full-browser-proof', **proof}), flush=True)
        return binding

    def cell(self):
        from qualification_stats import schedule, analyze
        gate_path = Path(self.args.preflight_gate)
        gate = json.loads(gate_path.read_text())
        same(gate['complete'], True, 'Global full-browser proof did not pass')
        for key, expected in [('baseline', BASELINE), ('candidate', CANDIDATE), ('protocolBlob', PROTOCOL_BLOB),
                              ('researchCommit', self.research_commit), ('researchTree', self.research_tree),
                              ('sourceManifestSha256', self.source_manifest_sha256),
                              ('naturalCoreSha256', digest(self.oracle['core']))]:
            same(gate[key], expected, 'Global preflight binding differs: ' + key)
        write_json(self.evidence / 'global-preflight-guard.json', {'complete': True, 'sha256': digest(gate_path), 'gate': gate})
        if self.args.dictionary == 'vndb':
            binding = self.preflight()
            for arm in ('A', 'B'):
                same(binding['witnesses'][arm]['files'], gate['binding']['witnesses'][arm]['files'],
                     'Per-host browser bytes differ from global proof')
        else:
            binding = self.common_binding()
        self.comparator = self.Comparator(binding)
        self.reference = None
        fixed_schedule = schedule(self.args.initial_order)
        memory_plan = self.memory_schedule(1 if self.args.initial_order == 'AB' else 2)
        write_json(self.evidence / 'registered-plan.json', {'protocolBlob': PROTOCOL_BLOB, 'schedule': fixed_schedule,
                   'exhaustiveMediaOrder': self.args.initial_order, 'memorySchedule': memory_plan,
                   'noRetriesOrExclusions': True, 'comparatorBinding': binding,
                   'ordinaryEndpoint': 'Unchanged page file-input-change to post-UI import-complete; identical bounded hash overlay after existing validation'})
        observations = []
        for item in fixed_schedule:
            result = self.observation(item['id'], item['arm'])
            observations.append({**item, 'totalImportMs': result['totalImportMs']})
            write_json(self.evidence / 'observations.json', observations)
        full_reference = None
        for arm in self.args.initial_order:
            result = self.observation('exhaustive-media-' + arm, arm, media='all')
            if full_reference is None:
                full_reference = (result['receipt'], arm)
            else:
                self.comparator.compare(full_reference[0], result['receipt'], full_reference[1], arm)
        memory_root = self.evidence / 'memory'
        memory_root.mkdir()
        replication = 1 if self.args.initial_order == 'AB' else 2
        write_json(memory_root / 'plan.json', {'schedule': memory_plan, 'replication': replication,
                   'dictionary': self.args.dictionary, 'authoritativeTiming': False,
                   'overlaySha256': hashlib.sha256(self.memory_overlay.encode()).hexdigest()})
        memory_observations = []
        self.set_overlay(self.memory_overlay)
        try:
            for item in memory_plan:
                result = self.observation('memory/' + item['name'], item['arm'], memory_item=item)
                row = {**item, **result['sampled']}
                memory_observations.append(row)
                write_json(memory_root / 'observations.json', memory_observations)
                require(row['qualifiedForWholeTreePss'], 'Memory observation failed existing coverage/scan-gap requirements')
        finally:
            self.set_overlay(self.overlay)
        memory_result = self.memory_comparison(memory_observations, self.args.dictionary, replication, self.memory_schedule)
        write_json(memory_root / 'memory-comparison.json', memory_result)
        write_json(memory_root / 'semantic-failures.json', [])
        write_json(memory_root / 'memory-audit.json', self.audit_cell(memory_root))
        analysis = analyze(observations, self.args.dictionary, self.args.initial_order)
        analysis['memoryPassed'] = memory_result['passesProspectiveMemoryScreen']
        analysis['semanticAndSourceGatesPassed'] = True
        analysis['passesCompleteCell'] = analysis['passesProspectiveTimingScreen'] and analysis['memoryPassed']
        analysis['status'] = 'qualified-cell' if analysis['passesCompleteCell'] else 'hold'
        analysis['sourceBinding'] = {'baseline': BASELINE, 'candidate': CANDIDATE, 'researchCommit': self.research_commit,
                                     'preAcquisitionBindingSha256': digest(self.evidence / 'pre-acquisition-binding.json'),
                                     'registeredPlanSha256': digest(self.evidence / 'registered-plan.json')}
        write_json(self.evidence / 'analysis.json', analysis)
        print(json.dumps({'kind': 'cell-analysis', **analysis}), flush=True)
        require(analysis['passesCompleteCell'], 'Complete cohort retained; fixed timing/control/memory advancement gate did not pass')

    def cleanup(self):
        for arm, target in self.sources.items():
            try:
                if self.original_harness is not None:
                    expected = self.current_overlays.get(arm, self.original_harness)
                    same((target / HARNESS).read_text(), expected, 'Unexpected harness state during cleanup')
                    (target / HARNESS).write_text(self.original_harness)
                    self.current_overlays[arm] = self.original_harness
                same(git(target, 'status', '--porcelain'), '', 'Runtime not clean after restoring only declared overlay')
                same(digest(target / 'builds/manabitan-chrome.zip'), self.identities[arm]['packageSha256'],
                     'Package changed during cleanup')
            except Exception as error:
                self.state['cleanupFailures'].append({'arm': arm, 'message': str(error), 'traceback': traceback.format_exc()})
        if self.state['cleanupFailures']:
            self.state['complete'] = False
        self.save_state()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', required=True, choices=('verify', 'preflight', 'cell'))
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), default='vndb')
    parser.add_argument('--initial-order', choices=('AB', 'BA'), default='AB')
    parser.add_argument('--repository', default=str(HERE.parents[2]))
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--preflight-gate')
    args = parser.parse_args()
    require(args.mode != 'cell' or args.preflight_gate is not None, 'Cell requires global full-browser proof artifact')
    study = None
    try:
        study = Study(args)
        study.setup_sources()
        if args.mode == 'verify':
            study.verify_gates()
        else:
            study.prepare_browser()
            if args.mode == 'preflight':
                study.preflight()
            else:
                study.cell()
        study.guard_sources()
        study.state['complete'] = True
        study.phase('complete')
    except Exception as error:
        if study is not None:
            study.state['complete'] = False
            study.state['failures'].append({'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
            study.save_state()
        else:
            evidence = Path(args.evidence)
            evidence.mkdir(parents=True, exist_ok=True)
            write_json(evidence / 'setup-failure.json', {'complete': False, 'type': type(error).__name__,
                       'message': str(error), 'traceback': traceback.format_exc(), 'retried': False})
        raise
    finally:
        if study is not None:
            study.cleanup()
    require(study is not None and study.state['complete'], 'Study did not complete cleanly')


if __name__ == '__main__':
    main()

