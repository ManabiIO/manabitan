#!/usr/bin/env python3
"""Independent byte/scope audit of sealed phase2A; never executes product code."""
import argparse
import collections
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import traceback

ROOT = Path('/workspace/scratch/9bb32f82fa3b')
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
FP = '178ee43328141693e88b90b4b518d483c87b2fac'
WIDE = 'ebf4278afc59d83f191692bd587f0e1f7e8682b3'
WIDE_TREE = '611b6e1591ffbbc9c978c33dee9af72a7b618536'
PROOF_SHA = 'c00ef090f0e0177361f78306b29b3beb4824b766c9d787fbaea83079a9c8ffc1'
OUTER_SHA = 'c3adf3be0ff375465e7c24cd539f008b5f74fcb8512bc0fc7a9451f5070653a0'
PHASE1_SHA = '050a01b9994034c0e070d66e17d1f879b20d724772e8c187af354a879936d161'
V1 = 'a367bc360aa97881aa879eaf8f5b53952a579f5d0e7dd72996749df4f08bb5f7'
V2 = '6b2d688e79c4f97c3f04729fed534c4abf731c6489f5fad098bd4ed37ba0101a'
CELLS = {
    'jmdict-AB': ('60ddeb398d3eb6aed7664fb142a88a44fbd501554cb8263e0c9a75d1595b04a6', 810, 253),
    'jmdict-BA': ('ff38faf1cd25801cd556b79c69d3b7ba7bb12e5109c4902d173400d472ce25d1', 810, 262),
    'jitendex-AB': ('18d2cc66d6a49e30e4ff7460a9acb6419cabf41215342210ac8684658f7125f3', 810, 290),
    'jitendex-BA': ('16514b0ab3859b04cd6442ae153a8b0e1efe6ebeff0cc4ec2774dfe3e574e6dd', 810, 358),
    'vndb-AB': ('d894e7f47ef6790803576b85b87b0f4193551dee50b1a4bfbeaf77fd04d3cd01', 813, 507),
    'vndb-BA': ('4be32703ff50f259c6113a8405f3136d6d5e8924020e507f7762c3eba2b4d706', 813, 507),
}
CHANGES = {
    'js/dictionary/dictionary-database.js',
    'js/dictionary/term-content-canonical-layout.js',
    'js/dictionary/term-content-metadata-arena.js',
    'js/dictionary/wasm/term-content-canonical-scan-v1.c',
    'lib/term-content-canonical-scan-v1.wasm',
}
CHECKS = []


def check(name, condition, detail=None):
    item = {'name': name, 'passed': bool(condition)}
    if detail is not None:
        item['detail'] = detail
    CHECKS.append(item)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def identity(data):
    return {'bytes': len(data), 'sha256': sha(data),
            'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}


def match(data, expected, name):
    actual = identity(data)
    check(name, all(actual[k] == expected[k] for k in actual if k in expected),
          None if all(actual[k] == expected[k] for k in actual if k in expected) else {'actual': actual, 'expected': expected})


def safe(name):
    p = PurePosixPath(name)
    return bool(name) and not p.is_absolute() and '..' not in p.parts and '\\' not in name


def read_tar(path, expected, retain_all=False, sorted_members=False):
    names, keep, total = [], {}, 0
    with tarfile.open(path, 'r|gz') as archive:
        for entry in archive:
            name = entry.name
            check(f'{path.name}: safe regular member {name}', safe(name) and entry.isfile() and name not in names)
            check(f'{path.name}: canonical metadata {name}',
                  (entry.mode, entry.uid, entry.gid, entry.uname, entry.gname, entry.mtime) == (0o644, 0, 0, '', '', 0))
            if not entry.isfile():
                continue
            data = archive.extractfile(entry).read()
            check(f'{path.name}: declared member {name}', name in expected)
            if name in expected:
                match(data, expected[name], f'{path.name}: member byte identity {name}')
            names.append(name)
            total += len(data)
            if retain_all or name.endswith('.json'):
                keep[name] = data
    check(f'{path.name}: exact member set', len(names) == len(expected) and set(names) == set(expected))
    if sorted_members:
        check(f'{path.name}: sorted members', names == sorted(names))
    return keep, {'members': len(names), 'uncompressedBytes': total}


def audit(folder, publication_path):
    publication_bytes = publication_path.read_bytes()
    publication = json.loads(publication_bytes)
    outer_data = (folder / 'INVENTORY.json').read_bytes()
    check('final outer inventory pinned', sha(outer_data) == OUTER_SHA)
    outer = json.loads(outer_data)
    published = {x['name']: x for x in publication['files']}
    declared = {x['name']: x for x in outer['files']}
    check('exact 22 publication files, no implicit files', len(published) == 22 and set(published) == {x.name for x in folder.iterdir()})
    check('outer inventory lists 21 others exactly once', len(declared) == 21 and len(outer['files']) == 21 and set(declared) == set(published) - {'INVENTORY.json'})
    for name, item in published.items():
        path = folder / name
        check(f'outer regular path {name}', safe(name) and path.is_file() and not path.is_symlink())
        match(path.read_bytes(), item, f'publication identity {name}')
        check(f'publication destination {name}', item['path'] == str(path) and item['proposedRepositoryPath'] == 'dev/perf/import-optimization-9bb32/phase2a/' + name)
        if name in declared:
            match(path.read_bytes(), declared[name], f'outer manifest identity {name}')

    initial = json.loads((folder / 'INITIAL-SEAL-INVENTORY.json').read_bytes())
    check('first seal inventory identity preserved', sha((folder / 'INITIAL-SEAL-INVENTORY.json').read_bytes()) == 'af75f47935f56ef70549684c7e3ecb6d548de844115ac8d1bb637a3ef72dcf57')
    check('all original 16 content items preserved', len(initial['files']) == 16)
    for item in initial['files']:
        match((folder / item['name']).read_bytes(), item, f'initial seal unchanged {item["name"]}')
    ip = json.loads((folder / 'INITIAL-SEAL-PUBLICATION.json').read_bytes())
    check('initial publication contains original 17 files', len(ip['files']) == 17)
    for item in ip['files']:
        name = 'INITIAL-SEAL-INVENTORY.json' if item['name'] == 'INVENTORY.json' else item['name']
        match((folder / name).read_bytes(), item, f'initial publication preserved {item["name"]}')
    iv = json.loads((folder / 'INITIAL-SEAL-VERIFICATION.json').read_bytes())
    check('original verifier receipt remains passing', iv['passed'] and iv['proofSha256'] == PROOF_SHA)

    proof_raw = (folder / 'proofs-and-sources.tar.gz').read_bytes()
    check('proof archive frozen identity', len(proof_raw) == 1092904 and sha(proof_raw) == PROOF_SHA)
    pi_raw = (folder / 'PROOF-INVENTORY.json').read_bytes()
    check('proof inventory independently pinned', sha(pi_raw) == '7e28a37793a6901ec98ce4b22707867f9f11759c76fe89964727a80ba0a48a9c')
    pi = json.loads(pi_raw)
    expected = {x['path']: x for x in pi['files']}
    check('166 unique manifest entries plus manifest itself', len(pi['files']) == len(expected) == 166)
    expected['PROOF-INVENTORY.json'] = identity(pi_raw)
    proofs, ps = read_tar(folder / 'proofs-and-sources.tar.gz', expected, retain_all=True, sorted_members=True)
    check('proof member and raw byte totals', ps == {'members': 167, 'uncompressedBytes': 7396442})
    for name in ['README.md', 'STATUS.json', 'EXCLUSIONS.json', 'CELL-INDEX.json', 'PHASE1-DEPENDENCIES.json', 'PROOF-INVENTORY.json', 'build-phase2a-checkpoint.py', 'verify-phase2a-checkpoint.py']:
        check('outer matches historical archived original ' + name, proofs[name] == (folder / name).read_bytes())

    origins = collections.Counter()
    for item in pi['files']:
        origin = item['origin']; origins[origin['kind']] += 1
        if origin['kind'] == 'local-retained-file':
            source = Path(origin['path'])
            check('local proof origin exists ' + item['path'], source.is_file())
            if source.is_file():
                check('local proof origin bytes ' + item['path'], source.read_bytes() == proofs[item['path']])
        elif origin['kind'] == 'git-object':
            result = subprocess.run(['git', '-C', str(ROOT / 'manabitan'), 'show', origin['commit'] + ':' + origin['path']], capture_output=True)
            check('immutable Git origin ' + item['path'], result.returncode == 0 and result.stdout == proofs[item['path']] and identity(result.stdout)['gitBlobSha1'] == origin['gitBlobSha1'])
    check('declared origin counts', dict(origins) == {'generated-checkpoint-metadata': 6, 'published-git-blob': 1, 'local-retained-file': 137, 'git-object': 22})

    repacked = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=repacked, mtime=0, compresslevel=9) as zipped:
        with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.PAX_FORMAT) as tar:
            for name in sorted(proofs):
                entry = tarfile.TarInfo(name)
                entry.size = len(proofs[name]); entry.mode = 0o644
                entry.uid = entry.gid = entry.mtime = 0; entry.uname = entry.gname = ''
                tar.addfile(entry, io.BytesIO(proofs[name]))
    check('independent complete deterministic proof repack', repacked.getvalue() == proof_raw)

    def pj(name):
        return json.loads(proofs[name])

    deps = pj('PHASE1-DEPENDENCIES.json')
    old_archive = ROOT / 'profiling/checkpoint-phase1/checkpoint-phase1.tar.gz'
    match(old_archive.read_bytes(), deps['archive'], 'phase1 immutable archive binding')
    check('phase1 SHA and published commit pins', deps['archive']['sha256'] == PHASE1_SHA and deps['commit'] == '35069bdeb7a904fb9a39c919717b61021af9e78b')
    old_inv_bytes = proofs[deps['fullPriorInventoryCopy']]
    match(old_inv_bytes, deps['inventory'], 'complete prior inventory byte identity')
    old_inv = json.loads(old_inv_bytes)
    old_entries = {x['path']: x for x in old_inv['files']}
    dependency_names = {x['path'] for x in deps['members']}
    check('exact 93 unique phase1 dependencies', len(deps['members']) == len(dependency_names) == 93)
    with tarfile.open(old_archive) as old:
        for item in deps['members']:
            check('phase1 dependency original inventory ' + item['path'], item['phase1InventoryEntry'] == old_entries[item['path']])
            match(old.extractfile(item['path']).read(), item['phase1InventoryEntry'], 'phase1 dependency retained bytes ' + item['path'])

    index = pj('CELL-INDEX.json')
    check('exact six cells', {x['cell'] for x in index['cells']} == set(CELLS) and len(index['cells']) == 6)
    totals = {'imports': 0, 'rawMembers': 0, 'rawMemoryScans': 0, 'independentChecks': 0}
    cell_summaries = []
    for cell in index['cells']:
        name = cell['cell']; prefix = cell['proofDirectory'] + '/'
        retention_data = proofs[prefix + 'retention-manifest.json']; retention = json.loads(retention_data)
        raw_path = folder / cell['publicationName']; raw_data = raw_path.read_bytes()
        match(raw_data, cell, name + ': cell index byte binding')
        match(raw_data, retention['retainedArchive'], name + ': retention byte binding')
        check(name + ': independently known raw SHA', sha(raw_data) == CELLS[name][0])
        check(name + ': unchanged copied original raw archive', raw_data == Path(cell['originalPath']).read_bytes())
        members = {**retention['included'], **retention['derived']}
        check(name + ': complete retained and omitted counts', len(retention['included']) == 269 and len(retention['derived']) == 1 and len(retention['omittedRedundant']) == 44)
        check(name + ': exclusions are only two ZIP and 42 HTML payloads', collections.Counter(Path(n).suffix for n in retention['omittedRedundant']) == {'.zip': 2, '.html': 42})
        raw, rs = read_tar(raw_path, members)
        check(name + ': exact 270 raw member count', rs['members'] == 270)
        get = lambda n: json.loads(raw[n])
        plan = get('registered-plan.json'); source = get('source-identities.json'); browser = get('browser-identity.json'); package = get('derived-package-audit.json')
        check(name + ': fixed baseline/candidate/options/order', plan['baseline'] == BASE and plan['candidate'] == FP and plan['flags'] == {} and name == plan['dictionary'] + '-' + plan['initialOrder'])
        check(name + ': exact prospective package differences', set(plan['expectedPackageEntries']) == CHANGES == set(source['changedPackageEntries']) == set(package['changedPackageEntries']) and package['passes'])
        check(name + ': fixed 12 candidate pairs, four controls, two warmups', plan['pairs'] == 12 and collections.Counter(x['kind'] for x in plan['schedule']) == {'candidate': 24, 'control': 8, 'warmup': 4})
        for arm, source_pin in [('A', BASE), ('B', FP)]:
            a = source['arms'][arm]; b = package['arms'][arm]
            check(name + ': package/source ' + arm, a['sha'] == b['sourceSha'] == source_pin and a['entries'] == b['entries'] and len(a['entries']) == 554 and a['packageSha256'] == b['packageSha256'])
        ea, eb = source['arms']['A']['entries'], source['arms']['B']['entries']
        check(name + ': every package member difference reconstructed', set(ea) == set(eb) and {n for n in ea if ea[n] != eb[n]} == CHANGES)
        check(name + ': frozen Chromium identity', browser['version'] == '153.0.8010.12' and browser['sha256'] == '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e')
        github = pj(prefix + 'github-artifact.json'); artifact = retention['sourceArtifact']
        check(name + ': GitHub original artifact binding', github['id'] == artifact['id'] == cell['sourceArtifact']['id'] and github['size_in_bytes'] == artifact['bytes'] and github['digest'] == 'sha256:' + artifact['sha256'] and artifact == cell['sourceArtifact'])
        check(name + ': authoritative hosted workflow/run', github['workflow_run']['id'] == artifact['runId'] == 46104243724 and github['workflow_run']['head_sha'] == 'b64b3d0423d758252fce9333ceef6e98431de47b')
        independent = pj(prefix + 'independent-semantics-memory-audit.json')
        stage = pj(prefix + 'audit-and-stage-analysis.json')
        check(name + ': independent audit identity and result', independent['passed'] and independent['failedChecks'] == [] and independent['checkCount'] == CELLS[name][1] and independent['archiveSha256'] == sha(raw_data) and independent['retentionManifestSha256'] == sha(retention_data))
        check(name + ': correct unchanged semantic/memory auditor', independent['auditScriptSha256'] == (V2 if name.startswith('vndb') else V1))
        check(name + ': source/native stage audit binding', stage['checksPassed'] and stage['failedChecks'] == [] and stage['checkCount'] == 585 and stage['allImportCount'] == 42 and stage['artifact'] == artifact)
        check(name + ': complete frozen timing analysis preserved', stage['frozenHarnessAnalysis'] == cell['frozenHarnessAnalysis'] == get('analysis.json'))
        canonical_names = {n for n in raw if n.endswith('/canonical-receipt.json')}
        expected_canonical = {x['id'] + '/canonical-receipt.json' for x in plan['schedule']} | {'exhaustive-media-A/canonical-receipt.json', 'exhaustive-media-B/canonical-receipt.json'} | {'memory/' + x['name'] + '/canonical-receipt.json' for x in plan['memorySchedule']}
        check(name + ': all 42 prescribed import receipts retained', len(canonical_names) == 42 and canonical_names == expected_canonical)
        for receipt_name in sorted(canonical_names):
            receipt = get(receipt_name); common = receipt['common']; validation = common['validation']
            observations = validation['lookup']['observations']
            check(name + ': retained receipt scope ' + receipt_name, receipt['browserVersion'] == browser['version'] and common['dictionary'] == plan['dictionary'] and len(observations) == 72 and len({o['term'] for o in observations}) == 12 and {o['pass'] for o in observations} == set(range(6)) and validation['outputDigestSha256'] == independent['semanticSummary']['outputDigestSha256'])
        check(name + ': two exhaustive media receipts', all(get(n)['media']['mode'] == 'all' for n in ['exhaustive-media-A/canonical-receipt.json', 'exhaustive-media-B/canonical-receipt.json']))
        ms = independent['memorySummary']; slots = independent['memorySlots']
        check(name + ': independent raw sampled memory result', ms['rawScanCount'] == CELLS[name][2] and ms['everyObservationQualified'] and ms['passesProspectiveMemoryScreen'] and len(slots) == 4 and all(s['benchmarkExitCode'] == 0 and s['qualifiedForWholeTreePss'] and not s['qualificationFailures'] and s['maximumCoveredSampleGapMs'] <= 250 for s in slots))
        check(name + ': cell aggregate bindings', cell['rawMemoryScans'] == ms['rawScanCount'] and cell['independentChecks'] == independent['checkCount'] and cell['allImportCount'] == 42)
        totals['imports'] += 42; totals['rawMembers'] += rs['members']; totals['rawMemoryScans'] += ms['rawScanCount']; totals['independentChecks'] += independent['checkCount']
        cell_summaries.append({'cell': name, 'archiveSha256': sha(raw_data), 'members': rs['members'], 'imports': 42, 'independentAuditSha256': sha(proofs[prefix + 'independent-semantics-memory-audit.json'])})

    check('all six aggregate evidence counts', totals == {'imports': 252, 'rawMembers': 1620, 'rawMemoryScans': 2177, 'independentChecks': 4866})
    status = pj('STATUS.json')
    check('snapshot is separate and no PR claim', status['asOfUtc'] == '2026-11-28T05:16:45Z' and status['pullRequestsCreatedByThisTask'] == 0 and status['supersedesPhase1'] is False)
    check('fingerprint shelf and limits', 'SHELVE' in status['fingerprint']['decision'] and status['fingerprint']['totalImports'] == totals['imports'] and status['fingerprint']['rawMemoryScansAudited'] == totals['rawMemoryScans'] and status['fingerprint']['independentSemanticsMemoryChecks'] == totals['independentChecks'])
    check('wide pending scope, no performance run or speed claim', status['wideKeyword']['source'] == WIDE and status['wideKeyword']['tree'] == WIDE_TREE and status['wideKeyword']['sourceQaRun'] == 46110109833 and status['wideKeyword']['untimedParityRun'] == 46111036970 and not status['wideKeyword']['speedupClaim'] and not status['wideKeyword']['performanceRunLaunched'])
    snapshot = pj('source-snapshots/wide-keyword/SNAPSHOT.json')
    check('wide exact five-file source snapshot', snapshot['remoteCommit'] == WIDE and snapshot['tree'] == WIDE_TREE and snapshot['baseCommit'] == BASE and len(snapshot['files']) == 5 and snapshot['sameCompleteTree'])
    for item in snapshot['files']:
        match(proofs['source-snapshots/wide-keyword/' + item['path']], item, 'wide frozen source binding ' + item['path'])
    qa = pj('profiling/minsize-hosted-qa.json')
    check('minsize QA exact source/run success', qa['runId'] == 46104779877 and qa['sourceSha'] == '2907ba1bad0958c22fe363f88d7cceb4d4bc604e' and qa['conclusion'] == 'success')
    qa_log = proofs['profiling/minsize-hosted-qa.log'].decode()
    check('minsize full QA counts retained', all(s in qa_log for s in ['380 passed', '669 passed', '15135 passed', '47 skipped', 'test:ts:main', 'test:ts:dev', 'test:ts:test', 'test:ts:bench', 'test:build']))
    correctness = 'profiling/long-keyword-correctness-phase2/'
    initial_test = pj(correctness + 'new-keyword-tests-receipt.json'); passed_test = pj(correctness + 'new-keyword-tests-r2-receipt.json')
    check('new tests failed setup and corrected 56-case pass retained', initial_test['exitCode'] == 1 and '--minWorkers=1' in initial_test['command'] and passed_test['exitCode'] == 0 and passed_test['summary']['numPassedTests'] == passed_test['summary']['numTotalTests'] == 56 and passed_test['summary']['numFailedTests'] == 0 and initial_test['beforeHashes'] == passed_test['afterHashes'])
    match(proofs[correctness + 'new-keyword-tests.log'], {'sha256': initial_test['logSha256']}, 'initial failed test log bound')
    match(proofs[correctness + 'new-keyword-tests-r2.log'], {'sha256': passed_test['logSha256']}, '56-case passing test log bound')
    lint = pj(correctness + 'new-keyword-eslint-receipt.json'); focused = pj(correctness + 'focused-existing-run.json')
    check('both SIGKILL no-verdict receipts retained', lint['exitCode'] == -9 and focused['exitCode'] == -9 and focused['status'] == 'failed-no-retry')
    match(proofs[correctness + 'new-keyword-eslint.log'], {'sha256': lint['logSha256']}, 'SIGKILL lint log bound')
    check('failed compiler wrapper and later assembly/link both retained', pj('profiling/long-keyword-wide-static-phase2/compile-attempt.json')['exitCode'] == 1 and 'profiling/long-keyword-wide-static-phase2/assembly-link-completion.json' in proofs)
    alignment = pj(correctness + 'remote-alignment.json')
    check('outage and guarded same-tree alignment retained', alignment['initialAlignmentAttempt']['executed'] is False and 'exec-server transport disconnected' in alignment['initialAlignmentAttempt']['toolFailure'] and alignment['successfulAlignmentCommands'] == 1 and alignment['alignmentExitCode'] == 0 and alignment['tree'] == WIDE_TREE and alignment['clean'] and alignment['frozenReceiptUnmodified'])
    parity = pj('profiling/hosted-wide-parity-spec/independent-review.json')
    check('reviewed full-output parity remains separate', parity['allChecksPassed'] and parity['checkCount'] == 57 and parity['candidateCommit'] == WIDE and parity['nodeVersion'] == 'v24.20.0' and not parity['execution']['importsOrCorrectnessProcessesRun'])
    for key, name in [('helper', 'import-wide-keyword-parity-9bb32.py'), ('workflow', 'import-wide-keyword-parity-9bb32.yml')]:
        match(proofs['profiling/hosted-wide-parity-spec/' + name], parity[key], 'parity spec binding ' + key)
    check('no deferred minsize raw cells in phase2A', not any('/hosted-qualification/minsize/' in n for n in proofs))
    check('no runtime/dependency/corpus bulk in proof archive', not any(n.endswith(('.zip', '.groups', '.pyc')) or '/node_modules/' in n or '/runtime/node/' in n or '/native-toolchain/' in n for n in proofs))
    check('only expected small diagnostic/native binary suffixes', all(n.startswith(('profiling/long-keyword-wide-static-phase2/', 'source-snapshots/')) for n in proofs if n.endswith(('.wasm', '.bc', '.o'))))

    correction = json.loads((folder / 'METADATA-CORRECTION.json').read_bytes())
    read_first = (folder / 'READ-FIRST.md').read_bytes()
    match(read_first, correction['clarification'], 'additive READ-FIRST identity')
    check('correction has no content mutation or verifier exception', all(correction[k] is False for k in ['changesToAnyBinaryArchive', 'changesToOriginalProofsOrObservations', 'changesToOriginalVerifier']))
    for topic in correction['corrections']:
        for evidence in topic['evidence']:
            match(proofs[evidence['path']], evidence, 'clarification evidence ' + evidence['path'])
    check('precise BA one-projection scope correction', b'one JMdict BA stage projection and its companion' in read_first and b'no separate AB stage projection' in read_first)
    check('precise hosted runtime scope correction', b'Node 22.22.0' in read_first and b'Node 24.20.0' in read_first and b'untimed full-parser-output parity' in read_first)
    check('fixed snapshot preserved by correction', correction['snapshotAsOfUtc'] == status['asOfUtc'])
    check('metadata correction original 16 items bind', len(correction['originalOuterFilesPreserved']) == 16)
    for item in correction['originalOuterFilesPreserved']:
        match((folder / item['name']).read_bytes(), item, 'correction original identity ' + item['name'])
    return {'snapshotAsOfUtc': status['asOfUtc'], 'outerInventory': identity(outer_data), 'publicationList': identity(publication_bytes),
            'proofArchive': identity(proof_raw), 'proofSummary': ps, 'proofOrigins': dict(origins), 'totals': totals,
            'phase1Dependencies': 93, 'deterministicProofRepackEqual': repacked.getvalue() == proof_raw,
            'cells': cell_summaries, 'outerFiles': len(published), 'contentClarifications': ['One BA stage projection plus its binding; no AB projection in this snapshot.', 'Completed source QA/browser Node22.22.0; separately pending full-parser parity Node24.20.0.'],
            'claimLimits': ['Fingerprint is shelved; gate success is not complete-import performance gain.',
                            'Hosted persisted receipt coverage is 12 fixed terms / 72 cold-warm observations, with separate all-referenced-media slots; not all persisted rows.',
                            'Full parser logical-output digests have a distinct, broader worker-output scope and do not establish browser-store parity.',
                            'Previous independent memory audits reprocessed 2177 raw scans; this checkpoint audit verifies their immutable receipts and all raw member bytes, without re-running product execution.',
                            'Package ZIP/browser/media payloads omitted by the original retention policy are not rehashed here; original verification/member records are retained.',
                            'Minsize raw cohorts and later audits are deferred; wide QA/parity were pending at frozen snapshot.']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--folder', type=Path, default=ROOT / 'profiling/checkpoint-phase2a')
    parser.add_argument('--publication', type=Path, default=ROOT / 'profiling/checkpoint-phase2a-publication-files.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Refusing to replace a previous independent receipt')
    result = {'scope': 'Independent complete byte/member, source/run binding, failure-retention and claim-scope audit. No product tests, import executions, benchmarks, network mutations, or sealed-file edits.'}
    try:
        result.update(audit(args.folder, args.publication))
    except Exception:
        result['auditSetupException'] = traceback.format_exc()
        check('audit completed without setup exception', False)
    result['scriptSha256'] = sha(Path(__file__).read_bytes())
    result['checkCount'] = len(CHECKS)
    result['failedChecks'] = [c for c in CHECKS if not c['passed']]
    result['passed'] = not result['failedChecks']
    result['checks'] = CHECKS
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result.get(k) for k in ['passed', 'checkCount', 'failedChecks', 'auditSetupException', 'totals', 'outerFiles']}, indent=2))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
