#!/usr/bin/env python3
"""Qualify experimental reference fields through real imports and restart.

This is a correctness/storage cohort, never a latency or memory measurement.
Both arms use one exact release package; only the explicit ephemeral flag varies.
The supplemental observer runs after the ordinary restart/media/lookup checks.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

from storage_contract import normalize_receipt
from sah_allocation_contract import exact_parent_allocation


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo-root', type=Path, required=True)
parser.add_argument('--source', required=True)
parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), required=True)
parser.add_argument('--order', choices=('off-on', 'on-off'), required=True)
parser.add_argument('--overlay', type=Path, required=True)
parser.add_argument('--contract', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
if not __debug__:
    raise SystemExit('Python optimized mode disables qualification assertions')
if re.fullmatch('[a-f0-9]{40}', args.source) is None:
    parser.error('An exact lowercase source commit is required')
root = args.repo_root.resolve()
evidence = args.evidence.resolve()
evidence.mkdir(parents=True, exist_ok=False)
source = evidence.parent / (evidence.name + '-source')
env = dict(os.environ, MANABITAN_E2E_STRICT_RUNTIME='1',
           MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK='0')
os.environ.update({key: env[key] for key in (
    'MANABITAN_E2E_STRICT_RUNTIME', 'MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK')})
sys.path.insert(0, str(root / 'dev/perf/import-memory-20261125-a7f7'))
from qualification_receipts import (
    validate_import_summary, require_matching_receipts,
)


def run(command, cwd, label):
    with (evidence / (label + '.log')).open('wb') as log:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    write_json(evidence / (label + '-exit.json'), {'command': command, 'returncode': result.returncode})
    if result.returncode:
        raise RuntimeError(f'{label} failed with exit {result.returncode}; retained complete log')


def git(*command, cwd=root):
    return subprocess.check_output(['git', *command], cwd=cwd, text=True).strip()


def load_json(path):
    return json.loads(path.read_text())


overlay_spec = importlib.util.spec_from_file_location('reference_format_activation', args.overlay)
assert overlay_spec is not None and overlay_spec.loader is not None
overlay_module = importlib.util.module_from_spec(overlay_spec)
overlay_spec.loader.exec_module(overlay_module)
collector_path = Path(overlay_module.COLLECTOR).resolve()
assert collector_path.parent == args.overlay.resolve().parent
observer_sources = {
    args.overlay.name: digest(args.overlay.read_bytes()),
    collector_path.name: digest(collector_path.read_bytes()),
    Path(__file__).name: digest(Path(__file__).read_bytes()),
    'storage_contract.py': digest(Path(__file__).with_name('storage_contract.py').read_bytes()),
    'sah_allocation_contract.py': digest(Path(__file__).with_name('sah_allocation_contract.py').read_bytes()),
}
contract = load_json(args.contract)
assert contract['schemaVersion'] == 2 and contract['candidate'] == args.source
sah_allocation_units = exact_parent_allocation(contract, args.dictionary)
case = contract['dictionaries'][args.dictionary]
assert set(case['modes']) == {'off', 'on'}
assert contract['timingEligible'] is False
fixture_lock_bytes = (root / 'test/perf/dictionaries.lock.json').read_bytes()
fixture = json.loads(fixture_lock_bytes)['dictionaries'][args.dictionary]
assert case['totalRows'] == fixture['termRows']
assert subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.22.0'
browser_binary = Path(subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())",
], cwd=root, text=True))
browser_text = subprocess.check_output([str(browser_binary), '--version'], text=True).strip()
browser_version = re.search(r'\d+\.\d+\.\d+\.\d+', browser_text).group(0)
write_json(evidence / 'browser-identity.json', {
    'version': browser_version, 'versionOutput': browser_text,
    'executableSha256': digest(browser_binary.read_bytes()),
})
write_json(evidence / 'registered-plan.json', {
    'schemaVersion': 1, 'source': args.source, 'dictionary': args.dictionary,
    'toolingSource': git('rev-parse', 'HEAD'), 'toolingTree': git('rev-parse', 'HEAD^{tree}'),
    'qualificationReceiptValidatorSha256': digest((root / 'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py').read_bytes()),
    'schedule': args.order.split('-'), 'timingEligible': False,
    'scope': 'Exact release package, fresh profile per import, orderly restart, 72 lookup observations, all media, actual field headers and SQLite floor',
    'contractSha256': digest(args.contract.read_bytes()),
    'overlaySha256': digest(args.overlay.read_bytes()),
    'observerSourceHashes': observer_sources,
    'fixtureLockSha256': digest(fixture_lock_bytes), 'contract': contract,
    'failurePolicy': 'Stop at first failure; retain every completed and failed observation; no replacement of an unchanged acquisition',
    'normalization': 'Only the explicitly asserted ephemeral flag and prospectively exact term-file sizes differ between arms; all other semantic/storage/media fields remain exact',
})
shutil.copy2(args.contract, evidence / 'storage-contract.json')
shutil.copy2(args.overlay, evidence / 'activation-overlay.py')
shutil.copy2(collector_path, evidence / collector_path.name)
shutil.copy2(Path(__file__), evidence / Path(__file__).name)
shutil.copy2(Path(__file__).with_name('storage_contract.py'), evidence / 'storage_contract.py')
shutil.copy2(Path(__file__).with_name('sah_allocation_contract.py'), evidence / 'sah_allocation_contract.py')
shutil.copy2(root / 'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py', evidence / 'qualification_receipts.py')
run(['node', 'dev/perf/prepare-dictionaries.js', args.dictionary], root, 'fixtures')
run(['git', 'worktree', 'add', '--detach', str(source), args.source], root, 'worktree')
assert git('rev-parse', 'HEAD^{tree}', cwd=source) == contract['candidateTree']
shutil.copytree(root / 'node_modules', source / 'node_modules', copy_function=os.link, symlinks=True)
(source / 'builds').mkdir(exist_ok=True)
(source / 'builds/e2e-dictionary-cache').symlink_to(root / 'builds/e2e-dictionary-cache', target_is_directory=True)
assert (source / 'package-lock.json').read_bytes() == (root / 'package-lock.json').read_bytes()
assert (source / 'test/perf/dictionaries.lock.json').read_bytes() == fixture_lock_bytes
run(['npm', 'run', 'build:libs'], source, 'libs')
run(['npm', 'run', 'license-report:html'], source, 'license')
run(['npm', 'run', 'build', '--', '--target', 'chrome'], source, 'build')
assert not git('status', '--porcelain', cwd=source), 'Unexpected changes after ordinary release build'
package_path = source / 'builds/manabitan-chrome.zip'
package_bytes = package_path.read_bytes()
package_sha = digest(package_bytes)
with zipfile.ZipFile(package_path) as package:
    names = [item.filename for item in package.infolist() if not item.is_dir()]
    assert len(names) == len(set(names))
    entries = {name: digest(package.read(name)) for name in names}
assert entries['lib/sqlite/index.mjs'] == overlay_module.SQLITE_BUNDLE_SHA256
assert entries['js/dictionary/sqlite-wasm.js'] == overlay_module.SQLITE_WRAPPER_SHA256
assert digest((source / 'ext/lib/sqlite/index.mjs').read_bytes()) == overlay_module.SQLITE_BUNDLE_SHA256
assert digest((source / 'ext/js/dictionary/sqlite-wasm.js').read_bytes()) == overlay_module.SQLITE_WRAPPER_SHA256
shutil.copy2(package_path, evidence / 'package.zip')
provenance_paths = (
    'package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/benchmark-support.js',
    'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js',
    'test/chromium/import-flags-ab-benchmark.js', 'test/chromium/extension-two-dictionary-import.e2e.js',
    'test/e2e/import-timing.js', 'ext/js/pages/settings/dictionary-import-controller.js',
    'builds/manabitan-chrome.zip', 'builds/manabitan-chrome-dev.zip',
)
harness_relative = 'test/chromium/extension-two-dictionary-import.e2e.js'
harness = source / harness_relative
original = harness.read_text()
instrumented = overlay_module.overlay(original)
assert instrumented != original
(evidence / 'harness-original.js').write_text(original)
(evidence / 'harness-instrumented.js').write_text(instrumented)
harness.write_text(instrumented)
assert git('diff', '--name-only', cwd=source).splitlines() == [harness_relative]
hashes = {path: digest((source / path).read_bytes()) if (source / path).is_file() else None
          for path in provenance_paths}
identity = {
    'sha': git('rev-parse', 'HEAD', cwd=source), 'tree': git('rev-parse', 'HEAD^{tree}', cwd=source),
    'packageSha256': package_sha, 'packageBytes': len(package_bytes), 'entries': entries,
    'sourceHashes': hashes, 'sourceDirty': True,
    'observerSourceHashes': observer_sources,
    'instrumentation': {'originalHarnessSha256': digest(original.encode()),
                        'instrumentedHarnessSha256': digest(instrumented.encode()),
                        'scope': 'Supplemental verification after post-UI completion, restart, lookup and media checks; no product changes'},
}
write_json(evidence / 'source-identity.json', identity)


reference = None
observations = []
for mode in args.order.split('-'):
    output = evidence / mode
    flags = {'experimentalReferenceTableFields': mode == 'on'}
    assert harness.read_text() == instrumented
    assert digest(package_path.read_bytes()) == package_sha
    run(['node', 'dev/perf/import-benchmark.js', args.dictionary,
         '--runs', '1', '--no-build', '--build-target', 'chrome', '--media-check', 'all',
         '--flags', json.dumps(flags, separators=(',', ':')), '--output', str(output)], source, 'import-' + mode)
    summary = load_json(output / 'summary.json')
    raw = load_json(output / 'run-1.json')
    receipt = validate_import_summary(
        summary, raw, dictionary=args.dictionary, fixture=fixture,
        source_sha=args.source, package_sha256=package_sha, browser_version=browser_version,
        import_flags=flags, source_hashes=hashes, source_dirty=True, media_check='all',
        vndb_sah_allocation_units=sah_allocation_units,
    )
    activation = overlay_module.validate_activation(raw['referenceFormatActivation'], case['modes'][mode]['activation'])
    normalized = normalize_receipt(receipt, case, mode)
    if reference is None:
        reference = normalized
    else:
        require_matching_receipts(reference, normalized)
    write_json(output / 'canonical-receipt.json', receipt)
    write_json(output / 'normalized-receipt.json', normalized)
    write_json(output / 'activation-receipt.json', activation)
    observations.append({'mode': mode, 'semanticChecksPassed': True, 'activation': activation,
                         'actualTermFileBytes': sum(case['modes'][mode]['termFiles'].values()),
                         'timingEligible': False})
    write_json(evidence / 'observations.json', observations)
    print(json.dumps({'mode': mode, 'dictionary': args.dictionary, 'passed': True,
                      'actualTermFileBytes': observations[-1]['actualTermFileBytes']}), flush=True)
assert git('diff', '--name-only', cwd=source).splitlines() == [harness_relative]
assert digest(package_path.read_bytes()) == package_sha
saved = sum(case['modes']['off']['termFiles'].values()) - sum(case['modes']['on']['termFiles'].values())
write_json(evidence / 'result.json', {
    'status': 'passed', 'source': args.source, 'dictionary': args.dictionary,
    'order': args.order, 'observations': observations, 'actualTermFileBytesSaved': saved,
    'timingEligible': False, 'processMemoryMeasured': False,
    'limitations': 'Orderly restart only; corruption, interrupted publication and older-reader rejection remain separate focused gates. This verifies storage and sampled browser results, not a latency or whole-process-memory improvement.',
})
