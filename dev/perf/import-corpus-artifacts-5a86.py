#!/usr/bin/env python3
"""Review original corpus-proof artifacts without executing an import."""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile

if not __debug__:
    raise SystemExit('Refusing Python -O: evidence checks must remain enabled')

STUDY = '7657938904308d6b08d5ffda78124ee7695f3e14'
STUDY_TREE = '2d06d9a9c5a42a3b1c1d3fd5f48a3199be693c2c'
STUDY_DIR = 'test/perf/import-corpus-20261128-5a86/'
WORKFLOW = '.github/workflows/import-corpus-proof-5a86.yml'
ARMS = ('baseline', 'mask', 'suffix')
VARIABLE = {'validatedGlossaryReuseCount', 'crcScannedBytes', 'crcReusedBytes', 'crcReusedGlossaries'}
COUNTS = {
    'rows', 'stringBytes', 'mediaRows', 'keys', 'aliasedLengthKeys', 'omittedOffsetKeys',
    'preparedBuffers', 'preparedBufferBytes', 'nativeSegments', 'nativeFallbacks',
    'scratchReuseGroups', 'scratchReuseBytes', 'scratchReuseMisses', 'fusedAttempts',
    'fusedFallbacks', 'heapBytes', 'metadataBytes', 'metaCapacity', 'encodedContentBytes',
    'contentCapacity', 'validatedGlossaryReuseCount', 'mediaHintRowsSkipped', 'bankSpanCount',
    'recentContentDedupHitCount', 'escapedKeyDecodeCount', 'fastGlossaryNormalizationCount',
    'fastGlossaryNormalizationFallbackCount', 'crcScannedBytes', 'crcReusedBytes', 'crcReusedGlossaries',
}
FIELDS = COUNTS | {'digest', 'nativePrepared', 'crcDeferred', 'crcVerified'}
TOTALS = ('scratchReuseGroups', 'scratchReuseBytes', 'scratchReuseMisses', 'fusedAttempts',
          'fusedFallbacks', 'metadataBytes', 'validatedGlossaryReuseCount', 'crcScannedBytes',
          'crcReusedBytes', 'crcReusedGlossaries')
ARTIFACTS = {
    'jmdict': {'id': 15249531541, 'bytes': 73578,
               'sha256': '41ce6fd460bdd21a7dabb045969020eeafe35c11faa0888b725f39f4fb39d06a',
               'reportSha256': '13a68d43e272639d045812bde50057a2f38d079bcfd48f795d274ede1a707c03'},
    'vndb': {'id': 15249223884, 'bytes': 101294,
             'sha256': 'b9bb54dbd64f0bdcf097c19977c3f6ef28cf0f8abedcc5a2a9ae0e46729585eb',
             'reportSha256': '1f82eb8ad5cc4a4c2f1bd94717aa10ac53859e558d6945a5e4c5a97f171322c3'},
}

def need(value, message):
    if not value:
        raise ValueError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result

def read_json(data):
    return json.loads(data, object_pairs_hook=pairs)

def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])

def groups_check(result, plan):
    dictionary = result['dictionary']
    fixture = plan['fixtures'][dictionary]
    need(result['archiveSha256'] == fixture['sha256'], 'Fixture SHA drift')
    need(result['rows'] == fixture['termRows'], 'Fixture rows drift')
    need(result['banks'] == plan['expectedBanks'][dictionary], 'Bank total drift')
    groups = result['groups']
    need(len(groups) == plan['expectedGroups'][dictionary], 'Group total drift')
    need(result['totalSourceBytes'] == plan['expectedSourceBytes'][dictionary], 'Source total drift')
    need(result['policy'] == {'mediaHintFastScan': dictionary != 'jmdict',
         'projectImagePaths': dictionary == 'vndb', 'prepareLookupRoute': True}, 'Policy drift')
    need(result['groupsPerWorker'] == (4 if dictionary == 'jmdict' else 3), 'Grouping policy drift')
    need(result['minimumGroups'] == 3 * result['groupsPerWorker'], 'Minimum group drift')
    need(result['nativeSegments'] == result['nativeFallbacks'] == 0, 'Unexpected fallback')
    sums = {a: {k: 0 for k in TOTALS} | {'maxHeapBytes': 0} for a in ARMS}
    extra = {a: {k: 0 for k in ('rows', 'mediaRows', 'stringBytes', 'keys', 'preparedBufferBytes',
             'encodedContentBytes', 'recentContentDedupHitCount')} for a in ARMS}
    first = 1
    source_bytes = 0
    for number, group in enumerate(groups):
        begin = re.fullmatch(r'term_bank_(\d+)\.json', group['firstBank'])
        end = re.fullmatch(r'term_bank_(\d+)\.json', group['lastBank'])
        need(begin and end and int(begin[1]) == first and int(end[1]) >= first, 'Bank ordering/gap')
        bank_count = int(end[1]) - first + 1
        first = int(end[1]) + 1
        need(type(group['sourceBytes']) is int and group['sourceBytes'] > 0, 'Invalid source bytes')
        source_bytes += group['sourceBytes']
        need(set(group['arms']) == set(ARMS), 'Incomplete arms')
        baseline = group['arms']['baseline']
        for arm in ARMS:
            value = group['arms'][arm]
            need(set(value) == FIELDS, 'Unexpected receipt field')
            need(all(type(value[k]) is int and value[k] >= 0 for k in COUNTS), 'Non-integer counter')
            need(value['rows'] > 0 and value['heapBytes'] > 0, 'Empty group')
            need(re.fullmatch('[0-9a-f]{64}', value['digest']), 'Invalid complete-output digest')
            need(value['nativePrepared'] is True and value['crcVerified'] is True, 'Unverified output')
            need(value['crcDeferred'] is (dictionary == 'vndb'), 'CRC policy drift')
            need(value['scratchReuseGroups'] == value['fusedAttempts'] == 1, 'Attempt/reuse drift')
            need(value['bankSpanCount'] == bank_count, 'Bank span coverage drift')
            need(all(value[k] == 0 for k in ('nativeSegments', 'nativeFallbacks', 'scratchReuseMisses',
                                          'fusedFallbacks')), 'Fallback or miss')
            if value['crcDeferred']:
                need(value['crcScannedBytes'] + value['crcReusedBytes'] == group['sourceBytes'], 'CRC gap')
            else:
                need(all(value[k] == 0 for k in ('crcScannedBytes', 'crcReusedBytes', 'crcReusedGlossaries')),
                     'Unexpected deferred CRC counters')
            allowed = VARIABLE if arm == 'suffix' else set()
            need(all(value[k] == baseline[k] for k in FIELDS - allowed), f'Output/work drift: {arm}/{number}')
            if arm == 'suffix':
                need(value['crcScannedBytes'] <= baseline['crcScannedBytes'], 'CRC scan regression')
                need(all(value[k] >= baseline[k] for k in VARIABLE - {'crcScannedBytes'}), 'Reuse regression')
            for key in TOTALS:
                sums[arm][key] += value[key]
            for key in extra[arm]:
                extra[arm][key] += value[key]
            sums[arm]['maxHeapBytes'] = max(sums[arm]['maxHeapBytes'], value['heapBytes'])
    need(first == result['banks'] + 1, 'Incomplete last bank')
    need(source_bytes == result['totalSourceBytes'], 'Recomputed source bytes drift')
    for arm in ARMS:
        need(sums[arm] == result[arm], 'Recomputed totals drift')
        need(extra[arm]['rows'] == fixture['termRows'], 'Recomputed row count drift')
    return {'groupsPerArm': len(groups), 'banksPerArm': result['banks'], 'sourceBytes': source_bytes,
            'arms': sums, 'additionalTotals': extra}

def audit(repo, archive, dictionary):
    identity = ARTIFACTS[dictionary]
    raw = archive.read_bytes()
    need(len(raw) == identity['bytes'] and sha(raw) == identity['sha256'], 'Original ZIP identity drift')
    with zipfile.ZipFile(archive) as z:
        members = z.namelist()
        need(len(members) == len(set(members)), 'Duplicate ZIP member')
        for name in members:
            p = PurePosixPath(name)
            need(not p.is_absolute() and '..' not in p.parts, 'Unsafe ZIP member')
        contents = {name: z.read(name) for name in members}
    base = 'builds/perf/import-corpus-proof-5a86/' + dictionary + '/'
    checked_code = {}
    for name in members:
        source = None
        if name.startswith(STUDY_DIR):
            source = name
        elif name.startswith(base + 'study-code/'):
            short = name.removeprefix(base + 'study-code/')
            source = WORKFLOW if short == 'workflow.yml' else STUDY_DIR + short
        if source:
            expected = git(repo, 'show', STUDY + ':' + source)
            need(contents[name] == expected, 'Study code differs from frozen Git: ' + name)
            checked_code[name] = sha(expected)
    need(len(checked_code) == 17, 'Incomplete study code archive')
    report_raw = contents[base + 'report.json']
    need(sha(report_raw) == identity['reportSha256'], 'Report differs from hosted emitted identity')
    report = read_json(report_raw)
    invocation = read_json(contents[base + 'invocation.json'])
    plan = read_json(git(repo, 'show', STUDY + ':' + STUDY_DIR + 'plan.json.txt'))
    provenance = read_json(git(repo, 'show', STUDY + ':' + STUDY_DIR + 'provenance.json.txt'))
    need(report['schema'] == 2 and report['complete'] is True and report['node'] == 'v22.22.0', 'Partial/wrong-runtime report')
    need(report['studyPlan'] == invocation['plan'] == plan, 'Plan drift')
    need(report['runnerSha256'] == provenance['adaptedSha256'], 'Observer drift')
    need(report['planSha256'] == provenance['planSha256'], 'Plan digest drift')
    need(report['upstreamReplay'] == provenance['upstream'], 'Upstream provenance drift')
    need(report['adaptationPatchSha256'] == provenance['patchSha256'], 'Adaptation drift')
    need(report['lockSha256'] == plan['fixtureLockSha256'], 'Fixture lock drift')
    need(report['grouping'] == {'kind': 'component model of lazy byte balancing with an explicit worker count',
         'parserWorkers': 3, 'targetBytes': 25165824, 'executionConcurrency': 1}, 'Grouping drift')
    need(invocation['studyCommit'] == STUDY and invocation['dictionary'] == dictionary, 'Invocation source drift')
    need(invocation['status'] == 'complete' and invocation['exitCode'] == 0 and invocation['retries'] == 0, 'Failed/retried invocation')
    need(invocation['endedUnixSeconds'] > invocation['startedUnixSeconds'], 'Invalid invocation interval')
    need(invocation['command'][:2] == ['node', '--expose-gc'] and invocation['command'][-1] == dictionary, 'Invocation shape drift')
    need(set(report['sources']) == set(ARMS), 'Source arms missing')
    source_hashes = {}
    for arm, value in report['sources'].items():
        source = plan['sources'][arm]
        need(value['git'] == {'sha': source['commit'], 'tree': source['tree'], 'status': ''}, 'Dirty/unexpected source')
        need(git(repo, 'rev-parse', source['commit'] + '^{tree}').decode().strip() == source['tree'], 'Source tree mismatch')
        checked = {}
        for path, digest in value['hashes'].items():
            git_path = 'dev/data/dictionary-wasm/term-bank-parser.wasm' if path == 'ext/lib/term-bank-parser.wasm' else path
            actual = sha(git(repo, 'show', source['commit'] + ':' + git_path))
            need(actual == digest, 'Source file identity drift: ' + arm + '/' + path)
            checked[path] = actual
        need(len(checked) == 19, 'Incomplete source manifest')
        source_hashes[arm] = checked
    result, = report['dictionaries']
    need(result['dictionary'] == dictionary, 'Wrong dictionary')
    checks = groups_check(result, plan)
    audit_lines = contents[base + 'audit.log'].decode().splitlines()
    receipt_lines = [line.removeprefix('CORPUS_PROOF ') for line in audit_lines if line.startswith('CORPUS_PROOF ')]
    need(len(receipt_lines) == 1, 'Missing/duplicate hosted audit receipt')
    hosted = read_json(receipt_lines[0])
    need(hosted['status'] == 'PASS' and hosted['dictionary'] == dictionary, 'Hosted audit failure')
    need(hosted['arms'] == checks['arms'] and hosted['rowsPerArm'] == result['rows']
         and hosted['groupsPerArm'] == checks['groupsPerArm'] and hosted['sourceBytes'] == checks['sourceBytes']
         and hosted['reportSha256'] == identity['reportSha256'], 'Hosted/recomputed audit differs')
    negatives = []
    for label, mutate in [
        ('changed complete output digest', lambda r: r['groups'][0]['arms']['suffix'].__setitem__('digest', 'f'*64)),
        ('changed mask work', lambda r: r['groups'][0]['arms']['mask'].__setitem__('validatedGlossaryReuseCount', 0)),
        ('missing last group', lambda r: r['groups'].pop()),
        ('changed media row', lambda r: r['groups'][0]['arms']['suffix'].__setitem__('mediaRows', 99999999)),
        ('changed suffix allocation', lambda r: r['groups'][0]['arms']['suffix'].__setitem__('heapBytes', 1)),
        ('changed CRC policy', lambda r: r['groups'][0]['arms']['suffix'].__setitem__('crcDeferred', not (dictionary == 'vndb'))),
        ('changed bank coverage', lambda r: r['groups'][0].__setitem__('lastBank', 'term_bank_999.json')),
    ]:
        invalid = copy.deepcopy(result)
        mutate(invalid)
        try:
            groups_check(invalid, plan)
        except ValueError:
            negatives.append(label)
        else:
            raise ValueError('Negative guard accepted: ' + label)
    return {'dictionary': dictionary, 'status': 'PASS', 'artifact': identity,
            'archiveMembers': {n: {'bytes': len(b), 'sha256': sha(b)} for n, b in contents.items()},
            'sourceHashesCheckedAgainstGit': source_hashes, 'studyCodeCheckedAgainstGit': checked_code,
            'counterAudit': checks, 'negativeGuardsRejected': negatives,
            'limitations': ['Every row canonical byte range is hashed live; complete-group SHA-256 digests and counters are compared, not retained byte arrays.',
                'Per-group projected media-row counts can repeat references across groups; they are not installed unique media rows.',
                'This replay does not rehash owned outputs after later heap reuse.',
                'Independent zlib verifies source CRC/length; no direct zlib/native preloaded-source byte comparison.',
                'No direct comparison of all raw metadata flag bits.',
                'No browser, storage, exhaustive media-payload, process peak-memory, or performance claim.']}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--archives', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    need(git(args.repo, 'rev-parse', STUDY + '^{tree}').decode().strip() == STUDY_TREE, 'Study tree mismatch')
    result = {'schema': 1, 'kind': 'Independent review of original hosted corpus artifacts; no acquisition',
              'studyCommit': STUDY, 'studyTree': STUDY_TREE,
              'auditorSha256': sha(Path(__file__).read_bytes()),
              'corpora': [audit(args.repo, args.archives / (d + '.zip'), d) for d in ARTIFACTS]}
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'status': 'PASS', 'output': str(args.out), 'sha256': sha(args.out.read_bytes()),
                     'corpora': [{k: r[k] for k in ('dictionary', 'status', 'counterAudit', 'negativeGuardsRejected')}
                                 for r in result['corpora']]}, sort_keys=True))

if __name__ == '__main__':
    main()
