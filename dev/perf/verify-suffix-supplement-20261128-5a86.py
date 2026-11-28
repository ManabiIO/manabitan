#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify frozen suffix supplemental evidence without acquiring new imports."""
import argparse
import ast
import collections
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EVIDENCE = ROOT / 'builds/perf/suffix-supplement-20261128-5a86'
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '38031a752b26c9b630e5f2f1d45e780786656c74'
TREES = {'A': 'd99ea4d04658f7ec1c76acdc5f3684594212a471',
         'B': 'a05ece005d9fb4931cb1fc24f0cb67ceb109a7f5'}
WASM = {'A': '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee',
        'B': 'a9e15a67b2f72adf2288f4c981c0fb78362273953d94440706c41cf44515292f'}
NATIVE_C = {'A': '5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a',
            'B': '5fb1656504b65502f396d23d1222342f9c9b6485f90b949207758cb8058fa3ca'}
SCANNER = '40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af'
ORIGINALS = {
    'adversarial/runner.mjs': '6f97176e8500c35911022c5382fdfd771f9aa273d099aae566c1a59163c880f9',
    'adversarial/preflight.json': '77731eb743b0456631c1f193c4435f3aff62577dfbe3e5b09fcc3523c90e42c4',
    'adversarial/summary.json': 'e7cf657b9539159e9a52346f2a399a3d18854791bf4fcf463a89a50da2568dac',
    'adversarial/observations.jsonl': '699d3544f8415a933eb1ae25ba2022cce3c0499cb73755288df318f24ed34573',
    'adversarial/invocation.json': '06362f4804fcb391d1b2ebf55b92e96adb03786adbf25156314b76acfad963fa',
    'adversarial/stdout.log': '9018c60fd1f6c126ebc02590e16ea054c3540873783d2cbd4d4108c4f209d0fb',
    'adversarial/stderr.log': 'e0cb71fe601c6aa0bc77d1c72b7de24eb689cec9d73775860edf39dc4fa5755c',
    'review/independent-audit.json': '7ab5b699ae1bb1277f1e42bfe5b02a464213eda0715cb7466c8585dde165f79b',
    'review/original-auditor.mjs': '209fa004fb9d60ef25820bfefd6e7da4d1b46510232bc368c775a02a20885769',
    'hosted/validation.zip': '19adec2fae01b3b0358686e0fcf790c27fb67baa717ec76fcba4b20e92c0ea1d',
    'hosted/original-manifest.json': '64e53612567a3f7c85c6c8e0d9b539e30f61867ef2ede65b45cd3269963e7fe2',
    'hosted/job-receipt.json': 'e3c7b3a23dd435994e6c45877a873f17337a0fa2b28a1c6e3f83a80a866409fe',
    'hosted/logs/build.log': 'f1b5a4a0b295eb91df1df0b377d6a3e0fe96bceb13199abbbd6c5c1bbc1b2cda',
    'hosted/logs/json-format.log': 'e739f86f192724afd466e6fd712b8f12d80c11f56c471bab2c5c06d120e33d6a',
    'hosted/logs/native-rebuild.log': '6124d90f35a9775574295dbf01e78c7fbd0dcf111aacf0df6210c8d1491d15b6',
    'hosted/logs/test-types.log': '483be17dfd1c7a790c03be201b26aeac3b7a3dfd7f5d6b5c996f0bf33df1b92c',
    'hosted/logs/unit.log': '4c2327850800a9e3b739562a02e1cdda84cb61385e15d3941f0793816be2ba30',
}
TOTALS = {'observations': 6240, 'valid': 480, 'malformed': 5760, 'emittedRows': 1920,
          'additionalReuse': 353, 'casesWithAdditionalReuse': 353,
          'negativeZeroSequenceCases': 120, 'fusedSuccessValidCases': 436,
          'fallbackValidCases': 44, 'fusedSuccessAdditionalReuse': 319,
          'fallbackAdditionalReuse': 34}
MUTATIONS = ['missing-row-close', 'wrong-row-close', 'extra-field', 'trailing-comma',
             'missing-tag', 'invalid-sequence', 'sequence-null-suffix', 'invalid-tag-escape',
             'non-array-glossary', 'unclosed-glossary', 'missing-field-delimiter', 'junk-after-row']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def deterministic_archive(payloads):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:xz', preset=6, format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(payloads.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            member.uid = member.gid = member.mtime = 0
            member.uname = member.gname = ''
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def load_archive(evidence, manifest):
    require(manifest['schemaVersion'] == 1, 'Unexpected manifest schema')
    require(manifest['baseline'] == BASELINE and manifest['candidate'] == CANDIDATE, 'Changed study source')
    require(manifest['sourceTrees'] == TREES, 'Changed source trees')
    require(manifest['archive']['file'] == 'evidence.tar.xz', 'Unexpected archive name')
    require(manifest['verifier']['sha256'] == sha(Path(__file__).read_bytes()), 'Verifier identity mismatch')
    data = (evidence / manifest['archive']['file']).read_bytes()
    require(len(data) == manifest['archive']['bytes'], 'Archive length mismatch')
    require(sha(data) == manifest['archive']['sha256'], 'Archive hash mismatch')
    require(set(manifest['members']) == set(ORIGINALS), 'Missing or extra declared payload')
    payloads = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        names = []
        for member in archive:
            name = member.name
            logical = PurePosixPath(name)
            require(member.isfile() and not logical.is_absolute() and '..' not in logical.parts,
                    'Unsafe or non-file archive member')
            require(name == logical.as_posix() and name in ORIGINALS and name not in payloads,
                    'Unexpected, duplicate, or noncanonical archive path')
            require((member.mode, member.uid, member.gid, member.mtime, member.uname, member.gname) ==
                    (0o644, 0, 0, 0, '', ''), 'Nondeterministic archive metadata')
            value = archive.extractfile(member).read()
            require(len(value) == member.size == manifest['members'][name]['bytes'], 'Member length mismatch')
            require(sha(value) == ORIGINALS[name] == manifest['members'][name]['sha256'],
                    f'Original payload identity mismatch: {name}')
            payloads[name] = value
            names.append(name)
    require(names == sorted(ORIGINALS), 'Archive payload coverage or order mismatch')
    require(sum(map(len, payloads.values())) == manifest['archive']['uncompressedBytes'], 'Expanded size mismatch')
    return data, payloads


def generated_cases(observer):
    # Decode only five quoted constant strings from the frozen observer. This
    # uses literal_eval, never eval/exec, and does not execute the JS parser.
    section = observer.split('const glossaries = [', 1)[1].split('\n];', 1)[0]
    glossaries = [ast.literal_eval(line.strip().removesuffix(','))
                 for line in section.splitlines() if line.strip().startswith("'")]
    require(len(glossaries) == 5, 'Changed glossary generator')
    glossaries.append(compact([{'type': 'structured-content', 'content':
                               [{'tag': 'div', 'content': 'a' * 4112 + 'X' + 'b' * 4096}]}]))
    for glossary in glossaries:
        json.loads(glossary)
    spaces = ['', ' ', '\r\n\t', '\t \n']
    sequences = ['null', '0', '2147483647', '-0']
    identity = 0
    for distance in range(1, 6):
        for shape, glossary in enumerate(glossaries):
            for whitespace, space in enumerate(spaces):
                for numeric, sequence in enumerate(sequences):
                    tags = r'"tag\u0000value"' if identity % 2 == 0 else r'"\u8272\\tail"'
                    prefix = [r'"\u524d-key"', '"reading"', 'null', '"v1"', '17']
                    tail = [glossary, sequence, tags]
                    rows = [make_row(prefix + tail, space)]
                    for gap in range(1, distance):
                        rows.append(make_row([compact(f'gap{gap}'), '""', '"noun"', '""', str(gap),
                                              compact([f'different{gap}']), '42', '""'],
                                             spaces[(whitespace + gap) % len(spaces)]))
                    target_prefix = [r'"last\\key"', r'"reading\n一"', '"adj"', '"v5"',
                                     '-0' if identity % 11 == 0 else '23']
                    if shape == 5 and identity % 3 == 0:
                        tail = [glossary.replace('X', 'Y'), sequence, tags]
                    fields = target_prefix + tail
                    options = {'id': identity, 'distance': distance, 'shape': shape,
                               'whitespace': whitespace, 'numeric': numeric,
                               'split': len(rows) if identity % 2 == 0 else max(1, len(rows) - 1),
                               'empties': identity % 3 == 0}
                    yield options, rows, fields, make_row(fields, space), space
                    identity += 1
    require(identity == 480, 'Changed case count')


def make_row(fields, space):
    return '[' + space + (space + ',' + space).join(fields) + space + ']'


def source_hash(rows, options, space):
    split = options['split']
    banks = [make_row(rows[:split], space), make_row(rows[split:], space)]
    if options['empties']:
        banks[1:1] = ['[]', '[ \r\n\t ]']
    return sha(compact(banks).encode())


def audit_adversarial(payloads):
    preflight = json.loads(payloads['adversarial/preflight.json'])
    summary = json.loads(payloads['adversarial/summary.json'])
    records = [json.loads(line) for line in payloads['adversarial/observations.jsonl'].splitlines()]
    require(len(records) == 6720, 'Missing or extra observation lines')
    require(summary['status'] == 'passed' and summary['node'] == 'v22.22.0', 'Incomplete or changed runtime replay')
    require(summary['runnerSha256'] == ORIGINALS['adversarial/runner.mjs'], 'Observer hash mismatch')
    require(summary['observationsSha256'] == ORIGINALS['adversarial/observations.jsonl'], 'Receipt hash mismatch')
    require(summary['heads'] == {'A': BASELINE, 'B': CANDIDATE} and summary['wasmHashes'] == WASM,
            'Adversarial source identity mismatch')
    for key in ['startedUtc', 'node', 'runnerSha256', 'heads', 'wasmHashes', 'plannedValidCases',
                'mutationsPerCase', 'scope', 'identities']:
        require(preflight[key] == summary[key], f'Preflight changed: {key}')
    require(summary['plannedValidCases'] == 480 and summary['mutationsPerCase'] == 12, 'Changed replay plan')
    for arm in ['A', 'B']:
        ident = summary['identities'][arm]
        require(ident['head'] == summary['heads'][arm] and ident['wasmSha256'] == WASM[arm], 'Changed arm source')
        require(ident['files'] == {
            'ext/js/dictionary/term-bank-wasm-parser.js': '31854cfb3d20ba60b701ec31cf19de26bd55cc745cc4f998cb33f0554ec83cca',
            'ext/js/dictionary/wasm/term-bank-parser.c': NATIVE_C[arm],
            'ext/js/dictionary/term-bank-experiments.js': 'c3a0302d5ae434267191416cd6848612aeb011e6313731aed39450a44dae84fb'},
            'Changed source-file identities')
    counts = collections.Counter()
    distance_counts = collections.defaultdict(lambda: {'cases': 0, 'additionalReuse': 0})
    errors = collections.Counter()
    cursor = 0
    for options, rows, fields, target, space in generated_cases(payloads['adversarial/runner.mjs'].decode()):
        f, s = fields, space
        mutations = [target[:-1], target[:-1] + '}', make_row(f + ['"extra"'], s), target[:-1] + ',]',
                     make_row(f[:7], s), make_row(f[:6] + ['1e', f[7]], s),
                     make_row(f[:6] + ['null0', f[7]], s), make_row(f[:7] + [r'"\q"'], s),
                     make_row(f[:5] + ['null'] + f[6:], s), make_row(f[:5] + [f[5][:-1]] + f[6:], s),
                     '[' + s + (s + ',' + s).join(f[:5]) + s + (s + ',' + s).join(f[5:]) + s + ']',
                     target + 'x']
        for kind, mutated in [('valid', target)] + list(zip(MUTATIONS, mutations)):
            record = records[cursor]
            cursor += 1
            require(record['kind'] == kind and record['options'] == options, 'Observation order or case mismatch')
            expected_input = source_hash(rows + [mutated], options, space)
            require(record['sourceSha256'] == expected_input, 'Generated source hash mismatch')
            counts['observations'] += 1
            a, b = record['A'], record['B']
            if kind == 'valid':
                require(a['ok'] is True and b['ok'] is True, 'Valid case failed')
                for actual in [a, b]:
                    require(actual['rows'] == options['distance'] + 1 and actual['indexes'] == 1,
                            'Incomplete row/index coverage')
                    require(actual['attempts'] == 1 and actual['fallback'] == int(options['id'] % 11 == 0),
                            'Changed fused or negative-zero fallback behavior')
                    require(actual['bankSpanCount'] == (4 if options['empties'] else 2), 'Changed bank coverage')
                require(re.fullmatch(r'[0-9a-f]{64}', record['aOutputSha256']) is not None and
                        record['aOutputSha256'] == record['bOutputSha256'], 'Output digest mismatch')
                extra = b['reuse'] - a['reuse']
                require(extra in [0, 1], 'Unexpected reuse delta')
                oracle = records[cursor]
                cursor += 1
                require(oracle == {'options': options, 'kind': 'no-reuse-oracle', 'sourceSha256': expected_input,
                                   'ok': True, 'reuse': 0, 'outputSha256': record['aOutputSha256']},
                        'Reuse-disabled oracle mismatch')
                if options['distance'] == 5:
                    require(extra == 0, 'Reuse escaped the four-row window')
                distance_counts[options['distance']]['cases'] += 1
                distance_counts[options['distance']]['additionalReuse'] += extra
                counts['valid'] += 1
                counts['emittedRows'] += a['rows']
                counts['additionalReuse'] += extra
                counts['casesWithAdditionalReuse'] += int(extra > 0)
                counts['negativeZeroSequenceCases'] += int(options['numeric'] == 3)
                fused = b['fallback'] == 0
                counts['fusedSuccessValidCases' if fused else 'fallbackValidCases'] += 1
                counts['fusedSuccessAdditionalReuse' if fused else 'fallbackAdditionalReuse'] += extra
            else:
                for actual in [a, b]:
                    require(actual['ok'] is False and actual['name'] == 'Error' and
                            re.fullmatch(r'(fused )?term-bank parser failed with code -1', actual['message']),
                            'Malformed case is not a parser rejection')
                require(a['message'] == b['message'] and record['aOutputSha256'] is None and
                        record['bOutputSha256'] is None, 'Malformed behavior mismatch')
                errors[a['message']] += 1
                counts['malformed'] += 1
    require(cursor == len(records) and dict(counts) == TOTALS, 'Recomputed totals mismatch')
    for key in ['observations', 'valid', 'malformed', 'emittedRows', 'additionalReuse',
                'casesWithAdditionalReuse', 'negativeZeroSequenceCases']:
        require(preflight[key] == 0 and summary[key] == TOTALS[key], 'Preflight or summary count mismatch')
    invocation = json.loads(payloads['adversarial/invocation.json'])
    require(invocation['returncode'] == 0 and invocation['command'][1] == '--max-old-space-size=512',
            'Failed or changed invocation')
    require(invocation['command'][2].endswith('/adversarial-replay.mjs'), 'Wrong observer invocation')
    stdout = payloads['adversarial/stdout.log'].decode().splitlines()
    require([json.loads(line) for line in stdout[:8]] ==
            [{'completedValid': n, 'completedMalformed': n * 12} for n in range(60, 481, 60)],
            'Progress output mismatch')
    require(json.loads('\n'.join(stdout[8:])) == summary, 'Stdout summary mismatch')
    review = json.loads(payloads['review/independent-audit.json'])
    require(review['status'] == 'PASS_WITH_SCOPE_NOTES' and review['totals'] == TOTALS and
            review['records'] == 6720 and review['auditorSha256'] == ORIGINALS['review/original-auditor.mjs'],
            'Independent audit identity or totals mismatch')
    require(review['observationsSha256'] == summary['observationsSha256'] and
            review['observerSha256'] == summary['runnerSha256'], 'Independent audit inputs mismatch')
    require(review['distanceCounts'] == {str(key): value for key, value in distance_counts.items()},
            'Distance audit mismatch')
    return {'records': len(records), 'totals': dict(counts), 'distanceCounts': dict(distance_counts),
            'malformedErrorCounts': dict(errors), 'scopeNotes': review['scopeNotes']}


def audit_hosted(payloads):
    original = json.loads(payloads['hosted/original-manifest.json'])
    require((original['runId'], original['jobId'], original['artifactId'], original['head']) ==
            (46104813593, 140855069080, 15248253449, CANDIDATE), 'Changed hosted artifact source')
    require(original['archiveBytes'] == len(payloads['hosted/validation.zip']) == 48630 and
            original['archiveSha256'] == ORIGINALS['hosted/validation.zip'], 'Hosted ZIP identity mismatch')
    with zipfile.ZipFile(io.BytesIO(payloads['hosted/validation.zip'])) as archive:
        require(archive.testzip() is None, 'Hosted ZIP CRC error')
        expected = {entry['path']: entry for entry in original['files']}
        require(len(archive.namelist()) == 5 and set(archive.namelist()) == set(expected), 'Hosted ZIP coverage mismatch')
        for name, entry in expected.items():
            data = archive.read(name)
            require(data == payloads['hosted/logs/' + name] and len(data) == entry['bytes'] and
                    sha(data) == entry['sha256'], 'Hosted log differs from original archive')
    unit = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', payloads['hosted/logs/unit.log'].decode())
    require(re.search(r'Test Files\s+669 passed\s+\(669\)', unit) is not None and
            re.search(r'Tests\s+15153 passed\s+\|\s+47 skipped\s+\(15200\)', unit) is not None,
            'Hosted complete unit result missing')
    native_text = payloads['hosted/logs/native-rebuild.log'].decode()
    native = json.loads(native_text[native_text.index('{'):])
    require(native['mode'] == 'check' and native['toolchain'] ==
            {'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8'}, 'Unpinned native check')
    require({target['name']: target['sha256'] for target in native['targets']} ==
            {'term-content-canonical-scan-v1.wasm': SCANNER, 'term-bank-parser.wasm': WASM['B']},
            'Native output mismatch')
    targets = re.findall(r'^Building ([\w-]+)\.\.\.$', payloads['hosted/logs/build.log'].decode(), re.MULTILINE)
    require(targets == ['chrome', 'chrome-dev', 'chrome-playwright', 'firefox', 'firefox-dev',
                        'firefox-android', 'edge'], 'Incomplete build target coverage')
    require('npx tsc --noEmit --project test/jsconfig.typecheck.json' in
            payloads['hosted/logs/test-types.log'].decode(), 'Missing test type command')
    receipt = json.loads(payloads['hosted/job-receipt.json'])
    job = next(item for item in receipt['jobsResponse']['jobs'] if item['id'] == 140855069080)
    require(job['run_id'] == 46104813593 and job['status'] == 'completed' and job['conclusion'] == 'success',
            'Hosted validation job did not succeed')
    require(job['steps'] == receipt['stepsResponse']['steps'] and
            all(step['status'] == 'completed' and step['conclusion'] == 'success' for step in job['steps']),
            'Hosted validation steps did not succeed')
    return {'runId': original['runId'], 'jobId': original['jobId'], 'artifactId': original['artifactId'],
            'source': CANDIDATE, 'testsPassed': 15153, 'testFilesPassed': 669, 'testsSkipped': 47,
            'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8', 'buildTargets': targets,
            'testTypes': 'passed', 'jsonFormat': 'passed', 'scopedTestLint': 'passed'}


def verify_sources(repository, payloads):
    preflight = json.loads(payloads['adversarial/preflight.json'])
    for arm, commit in [('A', BASELINE), ('B', CANDIDATE)]:
        tree = subprocess.check_output(['git', 'rev-parse', commit + '^{tree}'], cwd=repository, text=True).strip()
        require(tree == TREES[arm], 'Source tree mismatch')
        files = dict(preflight['identities'][arm]['files'])
        files['dev/data/dictionary-wasm/term-bank-parser.wasm'] = WASM[arm]
        for name, expected in files.items():
            data = subprocess.check_output(['git', 'show', commit + ':' + name], cwd=repository)
            require(sha(data) == expected, 'Pinned source object mismatch')


def main():
    require(__debug__, 'Do not run this auditor with optimized Python (-O)')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument('--extract', type=Path, help='Write verified original files into a new directory')
    parser.add_argument('--check-repack', action='store_true', help='Recreate the deterministic XZ/USTAR bytes')
    parser.add_argument('--verify-sources', type=Path, help='Git repository containing both frozen source objects')
    args = parser.parse_args()
    manifest = json.loads((args.evidence / 'manifest.json').read_bytes())
    archive, payloads = load_archive(args.evidence, manifest)
    adversarial = audit_adversarial(payloads)
    hosted = audit_hosted(payloads)
    if args.check_repack:
        require(deterministic_archive(payloads) == archive, 'Deterministic repack mismatch')
    if args.verify_sources:
        verify_sources(args.verify_sources, payloads)
    if args.extract:
        require(not args.extract.exists(), 'Extraction directory must not exist')
        args.extract.mkdir(parents=True)
        for name, data in payloads.items():
            target = args.extract / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    print(json.dumps({'status': 'PASS', 'baseline': BASELINE, 'candidate': CANDIDATE,
                      'archiveSha256': sha(archive), 'members': len(payloads),
                      'uncompressedBytes': sum(map(len, payloads.values())),
                      'adversarial': adversarial, 'hostedValidation': hosted,
                      'repackChecked': args.check_repack, 'sourceObjectsChecked': bool(args.verify_sources),
                      'noAcquisition': True}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'FAIL: {error}', file=sys.stderr)
        raise SystemExit(1) from error
