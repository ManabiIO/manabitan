#!/usr/bin/env python3
"""Frozen real-worker component qualification. No failed or timed run is replaced."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import signal
import shutil
import statistics
import subprocess
import time
import traceback
import zipfile

CODE = Path(__file__).resolve().parent
HERE = None
BASE = None
CANDIDATE = None
NODE = None
ARCHIVE = None
COMMIT = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
ORDERS = ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC']
GIB = 1024 ** 3
LIMITS = {'rssBytes': 2 * GIB, 'minimumStartAvailableBytes': 3 * GIB,
          'minimumAvailableBytes': GIB, 'realmOldSpaceMiB': 384,
          'timeoutSeconds': 180, 'sampleSeconds': 0.1}
RUNTIME_CHANGES = sorted(['ext/js/dictionary/dictionary-importer.js',
                         'ext/js/dictionary/dictionary-media-diagnostics.js',
                         'ext/js/dictionary/term-bank-wasm-parser-worker.js',
                         'ext/js/dictionary/term-bank-wasm-parser.js'])


def write_new(filename, value):
    with Path(filename).open('x') as f:
        json.dump(value, f, indent=2, ensure_ascii=True)
        f.write('\n')


def sha(filename):
    h = hashlib.sha256()
    with Path(filename).open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def source_identity(root):
    sources = git(root, 'ls-files', '-z', 'ext/js').decode().split('\0')
    return {'runtimeTree': git(root, 'rev-parse', 'HEAD:ext/js').decode().strip(),
            'sources': {name: sha(root / name) for name in sources if name},
            'packageManifest': sha(root / 'package.json'),
            'dependencyLock': sha(root / 'package-lock.json'),
            'fixtureLock': sha(root / 'test/perf/dictionaries.lock.json'),
            'stockAdapter': sha(root / 'test/fixtures/parser-settlement/worker-node.mjs'),
            'mediaLoader': sha(root / 'test/mocks/dictionary-importer-media-loader.js'),
            'nativeManifest': sha(root / 'dev/data/dictionary-wasm/manifest.json'),
            'dictionaryWasm': {str(p.relative_to(root)): sha(p)
                               for p in sorted((root / 'dev/data/dictionary-wasm').glob('*.wasm'))}}


def identity(root):
    return {'root': str(root), 'head': git(root, 'rev-parse', 'HEAD').decode().strip(),
            'source': source_identity(root),
            'libraries': {str(p.relative_to(root)): sha(p)
                          for p in sorted((root / 'ext/lib').rglob('*')) if p.is_file()},
            'workingDiffSha256': hashlib.sha256(git(root, 'diff', '--binary', 'HEAD')).hexdigest()}


def harness_identity():
    return {name: sha(CODE / name) for name in ['screen-child.mjs', 'screen-worker.mjs',
                                               'screen-digest.mjs', 'screen-controller.py', 'generate-identities.py',
                                               'source-identities.json', 'README.md']}


def available_bytes():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    raise RuntimeError('MemAvailable is unavailable')


def process_tree_rss(pid):
    pending, seen, total = [pid], set(), 0
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        try:
            for line in Path(f'/proc/{current}/status').read_text().splitlines():
                if line.startswith('VmRSS:'):
                    total += int(line.split()[1]) * 1024
            pending.extend(int(value) for value in
                           Path(f'/proc/{current}/task/{current}/children').read_text().split())
        except FileNotFoundError:
            pass
    return total


def run_child(root, archive, fixture_path, mode, name):
    report_path, log_path = HERE / f'{name}.json', HERE / f'{name}.log'
    guard_path = HERE / f'{name}-watchdog.json'
    assert not any(p.exists() for p in [report_path, log_path, guard_path]), 'Refusing replacement observation'
    available = available_bytes()
    if available < LIMITS['minimumStartAvailableBytes']:
        write_new(guard_path, {'started': False, 'availableBytes': available, 'limits': LIMITS})
        raise RuntimeError('Insufficient starting memory headroom; observation not started')
    command = [str(NODE), '--max-old-space-size=384', str(CODE / 'screen-child.mjs'),
               str(root), str(archive), str(fixture_path), mode, str(report_path)]
    guard = {'started': True, 'command': command, 'limits': LIMITS,
             'startedEpochSeconds': time.time(), 'samples': []}
    started = time.monotonic()
    process = None
    violation = None
    try:
        with log_path.open('x') as log:
            process = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            guard['pid'] = process.pid
            while process.poll() is None:
                elapsed = time.monotonic() - started
                rss, available = process_tree_rss(process.pid), available_bytes()
                guard['samples'].append({'seconds': elapsed, 'rssBytes': rss, 'availableBytes': available})
                if rss > LIMITS['rssBytes']:
                    violation = 'process-tree-rss'
                elif available < LIMITS['minimumAvailableBytes']:
                    violation = 'system-headroom'
                elif elapsed > LIMITS['timeoutSeconds']:
                    violation = 'timeout'
                if violation:
                    break
                time.sleep(LIMITS['sampleSeconds'])
    except BaseException:
        guard['controllerError'] = traceback.format_exc()
        raise
    finally:
        if process is not None:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            guard['exitCode'] = process.wait()
        guard.update({'violation': violation, 'elapsedSeconds': time.monotonic() - started})
        guard['peakCommonProcessRssBytes'] = max((s['rssBytes'] for s in guard['samples']), default=0)
        guard['minimumAvailableBytes'] = min((s['availableBytes'] for s in guard['samples']), default=available)
        write_new(guard_path, guard)
    if guard['exitCode'] != 0 or violation:
        raise RuntimeError(f'{name} failed; original log and watchdog retained')
    result = json.loads(report_path.read_text())
    if not result.get('passed'):
        raise RuntimeError(f'{name} did not qualify')
    return result


def parity(a, b):
    for field in ['rows', 'referenceCount', 'uniqueMediaPaths', 'workerCount',
                  'sourceCount', 'sourceEstimatedBytes', 'groupBoundaryHash']:
        assert a[field] == b[field], (field, a[field], b[field])
    for field in ['columnsHash', 'referencesHash', 'firstOwnerHash', 'diagnosticSurvival', 'chunkProofs']:
        assert a['qualification'][field] == b['qualification'][field], field
    for result in [a, b]:
        assert result['qualification']['reuseChecks'] == len(result['groups'])
        assert len(result['qualification']['transferProofs']) == len(result['groups'])
        assert len(result['qualification']['ownershipReceipts']) == len(result['groups'])
        assert all(receipt['expected'] == receipt['received'] for receipt in result['qualification']['ownershipReceipts'])
    return {key: a['qualification'][key] for key in ['columnsHash', 'referencesHash', 'firstOwnerHash']}


def freeze():
    reference, candidate = identity(BASE), identity(CANDIDATE)
    expected = json.loads((CODE / 'source-identities.json').read_text())
    assert reference['head'] == COMMIT
    assert not git(BASE, 'diff', '--name-only', 'HEAD').strip()
    assert reference['source'] == expected['reference']
    assert candidate['source'] == expected['candidate']
    a_files, b_files = reference['source']['sources'], candidate['source']['sources']
    assert sorted(name for name in a_files.keys() | b_files.keys()
                  if a_files.get(name) != b_files.get(name)) == RUNTIME_CHANGES
    assert reference['libraries'] == candidate['libraries']
    assert reference['source']['stockAdapter'] == candidate['source']['stockAdapter']
    for name in ['packageManifest', 'dependencyLock', 'fixtureLock']:
        assert reference['source'][name] == candidate['source'][name]
    for name, digest in reference['source']['dictionaryWasm'].items():
        assert reference['libraries']['ext/lib/' + Path(name).name] == digest, 'Stale generated native module'
    fixture = json.loads((CANDIDATE / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']['vndb']
    assert ARCHIVE.stat().st_size == fixture['sizeBytes'] and sha(ARCHIVE) == fixture['sha256']
    write_new(HERE / 'fixture.json', fixture)
    node_version = subprocess.check_output([str(NODE), '--version']).decode().strip()
    assert node_version == 'v22.22.0'
    protocol = {'schemaVersion': 1, 'frozenEpochSeconds': time.time(), 'orders': ORDERS,
                'acquisitionLocation': 'hosted-ubuntu-26.04',
                'reference': reference, 'candidate': candidate, 'harness': harness_identity(),
                'node': {'path': str(NODE), 'sha256': sha(NODE),
                         'version': node_version},
                'provenance': expected['provenance'],
                'fixture': fixture, 'archive': str(ARCHIVE), 'limits': LIMITS,
                'primary': 'B / sqrt(A * C)',
                'promotion': {'medianRatioAtMost': 0.95, 'bootstrap95UpperBelow': 1.0,
                              'absoluteMedianCOverADriftAtMost': 0.03},
                'bootstrap': {'resamples': 20000, 'seed': 20261128, 'unit': 'paired block', 'statistic': 'median ratio'},
                'scope': 'Production parser+real transfer/delivery+importer media materialization with retained first-owner deferred diagnostics; no database, compression, media payload storage or OPFS.'}
    protocol['timerBoundary'] = 'Parent module imports, archive SHA verification/catalog creation and parent Wasm compilation precede the timer. The timer surrounds the production _readTermBankFileFast call, including parser worker startup and the final ordered sink callback.'
    write_new(HERE / 'frozen-protocol.json', protocol)
    print(json.dumps({'frozen': True, 'protocolSha256': sha(HERE / 'frozen-protocol.json')}))


def check_frozen():
    protocol = json.loads((HERE / 'frozen-protocol.json').read_text())
    assert protocol['reference'] == identity(BASE), 'Reference changed after freeze'
    assert protocol['candidate'] == identity(CANDIDATE), 'Candidate changed after freeze'
    assert protocol['harness'] == harness_identity(), 'Harness changed after freeze'
    assert protocol['orders'] == ORDERS and protocol['limits'] == LIMITS
    assert protocol['node']['sha256'] == sha(NODE)
    assert json.loads((HERE / 'fixture.json').read_text()) == protocol['fixture']
    return protocol


def qualify():
    check_frozen()
    a = run_child(BASE, ARCHIVE, HERE / 'fixture.json', 'qualify', 'qualification-A')
    check_frozen()
    b = run_child(CANDIDATE, ARCHIVE, HERE / 'fixture.json', 'qualify', 'qualification-B')
    check_frozen()
    result = {'passed': True, 'rows': a['rows'], 'referenceCount': a['referenceCount'],
              'uniqueMediaPaths': a['uniqueMediaPaths'], 'groups': len(a['groups']),
              'groupBoundaryHash': a['groupBoundaryHash'], 'hashes': parity(a, b)}
    write_new(HERE / 'qualification-summary.json', result)
    print(json.dumps(result))


def timing():
    protocol = check_frozen()
    qualification = json.loads((HERE / 'qualification-summary.json').read_text())
    assert qualification['passed']
    write_new(HERE / 'cohort-started.json', {'epochSeconds': time.time(), 'protocolSha256': sha(HERE / 'frozen-protocol.json')})
    blocks = []
    for block_index, order in enumerate(ORDERS, 1):
        values = {}
        for arm in order:
            check_frozen()
            result = run_child(CANDIDATE if arm == 'B' else BASE, ARCHIVE, HERE / 'fixture.json',
                               'timing', f'block-{block_index}-{arm}')
            check_frozen()
            assert result['rows'] == qualification['rows']
            assert result['referenceCount'] == qualification['referenceCount']
            assert result['uniqueMediaPaths'] == qualification['uniqueMediaPaths']
            assert result['groupBoundaryHash'] == qualification['groupBoundaryHash']
            values[arm] = result['componentWallMs']
        block = {'block': block_index, 'order': order, 'wallMs': values,
                 'B_over_A': values['B'] / values['A'], 'B_over_C': values['B'] / values['C'],
                 'C_over_A': values['C'] / values['A'],
                 'primaryRatio': values['B'] / math.sqrt(values['A'] * values['C'])}
        blocks.append(block)
        print(json.dumps(block), flush=True)
    ratios = [block['primaryRatio'] for block in blocks]
    rng = random.Random(protocol['bootstrap']['seed'])
    boot = sorted(statistics.median(rng.choices(ratios, k=len(ratios)))
                  for _ in range(protocol['bootstrap']['resamples']))
    interval = [boot[int(len(boot) * .025)], boot[int(len(boot) * .975)]]
    median = statistics.median(ratios)
    drift = statistics.median(block['C_over_A'] for block in blocks) - 1
    result = {'blocks': blocks, 'medianPrimaryRatio': median, 'bootstrap95': interval,
              'medianBOverA': statistics.median(block['B_over_A'] for block in blocks),
              'medianBOverC': statistics.median(block['B_over_C'] for block in blocks),
              'medianCOverADrift': drift,
              'promoteToBrowserQualification': median <= .95 and interval[1] < 1 and abs(drift) <= .03,
              'wholeImportClaim': False}
    write_new(HERE / 'component-summary.json', result)
    print(json.dumps(result))


def smoke():
    archive = HERE / 'smoke.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for bank in range(12):
            rows = [[f'first-{bank}-\ud800', '', '', '', bank,
                     [{'type': 'image', 'path': 'shared.png'}, 'x' * 2048], bank, ''],
                    [f'\ufeffword-{bank}', f'reading-{bank}', '', '', -bank,
                     [{'type': 'image', 'path': f'{bank}.png'}], bank + 1, '']]
            z.writestr(f'term_bank_{bank + 1}.json', json.dumps(rows, ensure_ascii=True))
    fixture = {'expectedTitle': 'Synthetic transport smoke', 'sha256': sha(archive),
               'sizeBytes': archive.stat().st_size, 'termRows': 24, 'mediaFiles': 13}
    fixture_path = HERE / 'smoke-fixture.json'
    write_new(fixture_path, fixture)
    a = run_child(BASE, archive, fixture_path, 'qualify', 'smoke-A')
    b = run_child(CANDIDATE, archive, fixture_path, 'qualify', 'smoke-B')
    print(json.dumps({'smokePassed': True, 'hashes': parity(a, b)}))


if __name__ == '__main__':
    commands = {'smoke': smoke, 'freeze': freeze, 'qualify': qualify, 'timing': timing}
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument('command', choices=commands)
    arguments.add_argument('--reference', type=Path, required=True)
    arguments.add_argument('--candidate', type=Path, default=CODE.parents[2])
    arguments.add_argument('--node', type=Path, default=shutil.which('node'))
    arguments.add_argument('--archive', type=Path, required=True)
    arguments.add_argument('--output', type=Path, required=True)
    args = arguments.parse_args()
    BASE, CANDIDATE, NODE, ARCHIVE, HERE = [Path(value).resolve() for value in
                                         [args.reference, args.candidate, args.node, args.archive, args.output]]
    HERE.mkdir(parents=True, exist_ok=True)
    commands[args.command]()
