#!/usr/bin/env python3
"""Verify retained phase2B bytes and receipt bindings; never run product code.

The containing Git tree authenticates INVENTORY.json. Original artifact ZIPs,
omitted HTML/package payloads, browser executables and corpus inputs are not
present: their prior verification receipts are checked for consistency only.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def identity(data):
    return {'bytes': len(data), 'sha256': sha(data),
            'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}


def check_identity(data, expected, context):
    actual = identity(data)
    for key in ('bytes', 'sha256', 'gitBlobSha1'):
        if key in expected:
            require(actual[key] == expected[key], context + ': ' + key + ' differs')


def safe_name(name):
    path = PurePosixPath(name)
    require(bool(name) and not path.is_absolute() and '..' not in path.parts and '\\' not in name,
            'Unsafe archive/publication path: ' + name)


def pack(path, files):
    with Path(path).open('xb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for name, data in sorted(files.items()):
                    safe_name(name)
                    info = tarfile.TarInfo(name)
                    info.size, info.mode = len(data), 0o644
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    archive.addfile(info, io.BytesIO(data))


def read_archive(path, expected, retain=(), sorted_members=False):
    retained, names, raw_bytes = {}, [], 0
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            safe_name(member.name)
            require(member.isfile() and member.name not in names and member.name in expected,
                    'Unexpected/duplicate/nonregular member: ' + member.name)
            require((member.uid, member.gid, member.uname, member.gname, member.mtime, member.mode)
                    == (0, 0, '', '', 0, 0o644), 'Archive metadata differs: ' + member.name)
            data = archive.extractfile(member).read()
            check_identity(data, expected[member.name], member.name)
            if retain is True or member.name in retain:
                retained[member.name] = data
            names.append(member.name)
            raw_bytes += len(data)
    require(set(names) == set(expected), 'Archive membership differs: ' + str(path))
    if sorted_members:
        require(names == sorted(names), 'Proof members are not sorted')
    return retained, {'members': len(names), 'uncompressedBytes': raw_bytes}


def read_dependencies(path, expected_archive, wanted):
    check_identity(Path(path).read_bytes(), expected_archive, 'Prior immutable archive')
    result = {}
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            if member.name in wanted:
                require(member.isfile() and member.name not in result, 'Invalid prior dependency member')
                data = archive.extractfile(member).read()
                check_identity(data, wanted[member.name], member.name)
                result[member.name] = data
    require(set(result) == set(wanted), 'Prior dependency missing')
    return result


def verify(folder, phase2a=None, phase1=None, repack=None):
    folder = Path(folder)
    inventory = json.loads((folder / 'INVENTORY.json').read_bytes())
    declared = {r['name']: r for r in inventory['files']}
    require(len(declared) == len(inventory['files']), 'Duplicate outer file')
    actual_names = {p.name for p in folder.iterdir() if p.is_file()}
    require(actual_names == set(declared) | {'INVENTORY.json'}, 'Outer membership differs')
    for name, item in declared.items():
        safe_name(name)
        path = folder / name
        require(path.is_file() and not path.is_symlink(), 'Missing regular publication file ' + name)
        check_identity(path.read_bytes(), item, name)
    freeze = json.loads((folder / 'INPUT-FREEZE.json').read_bytes())
    proof_index = json.loads((folder / 'PROOF-INVENTORY.json').read_bytes())
    expected = {r['path']: r for r in proof_index['files']}
    require(len(expected) == len(proof_index['files']) == len(freeze['proofInputs']), 'Proof count differs')
    require(set(expected) == {r['path'] for r in freeze['proofInputs']}, 'Frozen input/proof membership differs')
    for r in freeze['proofInputs']:
        require(all(expected[r['path']][k] == r[k] for k in ('bytes', 'sha256', 'gitBlobSha1')), 'Frozen proof identity differs')
    proofs, proof_summary = read_archive(folder / 'proofs-and-sources.tar.gz', expected, True, True)
    for target, member in freeze['directOuterProjections'].items():
        require((folder / target).read_bytes() == proofs[member], 'Direct outer projection differs: ' + target)
    status = json.loads((folder / 'STATUS.json').read_bytes())
    require(status['asOfUtc'] == freeze['asOfUtc'] and status['pendingOutcomes'] == freeze['pendingOutcomes'], 'Snapshot status differs')
    require(status['pendingOutcomePayloadsIncluded'] is False and freeze['pendingOutcomePayloadsIncluded'] is False, 'Pending payload included')
    require(not any('/hosted-qualification/wide/' in n or '/hosted-wide-parity-result/' in n or n.startswith('profiling/wide-hosted-qa.') for n in proofs), 'Pending wide payload present')
    decisions = json.loads((folder / 'DECISIONS.json').read_bytes())
    require(decisions['pullRequestsCreated'] == status['pullRequestsCreatedByThisTask'] == 0, 'Unexpected PR claim')
    require(decisions['decisions']['minsize']['decision'] == 'shelved-no-pr', 'Minsize decision differs')
    require(decisions['decisions']['wide']['decision'] == 'pending-hosted-evidence', 'Wide decision differs')
    projection_name = 'profiling/import-experiment-summary/RESULTS.json'
    check_identity(proofs[projection_name], decisions['projection'], 'Root decision projection')

    dependency_index = json.loads((folder / 'DEPENDENCIES.json').read_bytes())
    prior = {}
    dependency_result = {}
    for label, supplied in (('phase2a', phase2a), ('phase1', phase1)):
        spec = dependency_index[label]
        wanted = {r['member']: r for r in spec['members']}
        require(len(wanted) == len(spec['members']), 'Duplicate prior member locator')
        if supplied is not None:
            values = read_dependencies(supplied, spec['archive'], wanted)
            for name, data in values.items():
                require(name not in prior, 'Colliding prior dependency')
                prior[name] = data
            dependency_result[label] = {'archiveVerified': True, 'memberBytesVerified': len(values)}
        else:
            dependency_result[label] = {'archiveVerified': False, 'memberBytesVerified': 0,
                                        'scope': 'Immutable archive/member locators retained; parent archive not supplied'}
    summary = json.loads(proofs[projection_name])
    unavailable_summary_bindings = []
    for candidate in summary['candidates'].values():
        for cell in candidate['cells']:
            for binding in cell.get('sourceBindings', []):
                name = 'profiling/' + binding['path']
                data = proofs.get(name, prior.get(name))
                if data is None:
                    unavailable_summary_bindings.append(name)
                else:
                    check_identity(data, binding, 'Root summary source ' + name)
    if phase2a is not None:
        require(not unavailable_summary_bindings, 'Root summary dependency unresolved')

    index = json.loads((folder / 'CELL-INDEX.json').read_bytes())
    require(len(index['cells']) == 6, 'Expected six minsize cells')
    cells = []
    for cell in index['cells']:
        prefix = 'profiling/hosted-qualification/minsize/' + cell['cell'] + '/'
        retention_bytes = proofs[prefix + 'retention-manifest.json']
        retention = json.loads(retention_bytes)
        github = json.loads(proofs[prefix + 'github-artifact.json'])
        analysis = json.loads(proofs[prefix + 'audit-and-stage-analysis.json'])
        audit = json.loads(proofs[prefix + 'independent-semantics-memory-audit.json'])
        source = retention['sourceArtifact']
        require(source == cell['sourceArtifact'] == audit['sourceArtifact'], 'Original artifact binding differs')
        require(source['id'] == github['id'] and source['bytes'] == github['size_in_bytes']
                and 'sha256:' + source['sha256'] == github['digest'], 'Original artifact identity differs')
        require(source['runId'] == github['workflow_run']['id'] == 46104898097, 'Minsize run differs')
        require(github['workflow_run']['head_sha'] == '0c2a8a75cd0322cc13348b977a7e915b555d5a88', 'Minsize workflow differs')
        raw_path = folder / cell['publicationName']
        check_identity(raw_path.read_bytes(), retention['retainedArchive'], cell['cell'])
        retained_expected = {**retention['included'], **retention['derived']}
        require(len(retention['included']) == 269 and len(retention['derived']) == 1, 'Retained file count differs')
        selected, raw_summary = read_archive(raw_path, retained_expected,
                                            {'registered-plan.json', 'source-identities.json', 'derived-package-audit.json'})
        require(raw_summary['members'] == retention['retainedArchive']['verifiedFileCount'] == 270, 'Raw member count differs')
        plan = json.loads(selected['registered-plan.json'])
        original_identity = json.loads(selected['source-identities.json'])
        packages = json.loads(selected['derived-package-audit.json'])
        require(plan['baseline'] == freeze['baseCommit'] and plan['candidate'] == status['minsize']['source'], 'Source pin differs')
        require(plan['dictionary'] + '-' + plan['initialOrder'] == cell['cell'], 'Cell plan label differs')
        require(plan['pairs'] == 12 and len(plan['schedule']) == 36, 'Frozen schedule differs')
        omitted = retention['omittedRedundant']
        require(len(omitted) == 44 and sum(n.endswith('.html') for n in omitted) == 42, 'Omission count differs')
        require({n for n in omitted if not n.endswith('.html')} == {'package-A.zip', 'package-B.zip'}, 'Unexpected omission')
        require(packages['passes'] is True, 'Original package rehash did not pass')
        for arm, pin in (('A', plan['baseline']), ('B', plan['candidate'])):
            packaged, identified = packages['arms'][arm], original_identity['arms'][arm]
            require(packaged['sourceSha'] == identified['sha'] == pin, 'Nested source differs')
            require(packaged['entries'] == identified['entries'] and packaged['entryCount'] == len(packaged['entries']) == 554,
                    'Nested package member proof differs')
            require(packaged['packageSha256'] == identified['packageSha256'] == omitted[f'package-{arm}.zip']['sha256'],
                    'Omitted package digest differs')
        a, b = packages['arms']['A']['entries'], packages['arms']['B']['entries']
        require(a.keys() == b.keys(), 'Package name sets differ')
        changes = sorted(n for n in a if a[n] != b[n])
        require(changes == sorted(plan['expectedPackageEntries']) == sorted(packages['changedPackageEntries'])
                == sorted(original_identity['changedPackageEntries'])
                == ['js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm'], 'Package delta differs')
        require(analysis['checksPassed'] and analysis['allImportCount'] == 42 and analysis['checkCount'] == 585, 'Stage/native/source audit differs')
        require(audit['passed'] and not audit['failedChecks'] and audit['semanticSummary']['observations'] == 42, 'Independent audit differs')
        require(audit['archiveSha256'] == retention['retainedArchive']['sha256']
                and audit['retentionManifestSha256'] == sha(retention_bytes), 'Independent byte binding differs')
        memory = audit['memorySummary']
        if cell['cell'] == 'vndb-AB':
            require(memory['everyObservationQualified'] is False and memory['passesProspectiveMemoryScreen'] is False, 'Failed coverage was lost')
            require(all(v is None for metric in memory['metrics'].values() for v in metric.values()), 'Unqualified memory metrics are not null')
        else:
            require(memory['everyObservationQualified'] and memory['passesProspectiveMemoryScreen'], 'Qualified memory receipt differs')
        cells.append({'cell': cell['cell'], **raw_summary, 'allImportCount': 42,
                      'sourceNativeStageChecks': analysis['checkCount'], 'independentChecks': audit['checkCount'],
                      'rawMemoryScans': memory['rawScanCount'], 'memoryQualified': memory['everyObservationQualified'],
                      'omittedPayloadsRehashedByThisVerifier': False})
    require(sum(c['rawMemoryScans'] for c in cells) == decisions['decisions']['minsize']['rawMemoryScans'] == 2152, 'Memory scan total differs')
    require(sum(c['memoryQualified'] for c in cells) == 5, 'Memory qualification total differs')
    require(sum(c['allImportCount'] for c in cells) == 252, 'Import count differs')
    publication = json.loads(proofs['profiling/jmdict-group-diagnostic/remote-publication.json'])
    manifest = json.loads(proofs['profiling/jmdict-group-diagnostic/publication-files.final.json'])
    require(publication['publishedCommit'] == status['coordinatorDiagnostic']['source']
            == 'b66020e0def759142ab2106a3f634a970ad807d7', 'Diagnostic source differs')
    require(publication['tree'] == 'dad39eefe469361fc5f74a14446b352b431bc77f' and publication['remoteAllNineBlobIdsVerified'], 'Diagnostic tree proof differs')
    for f in manifest['files']:
        data = proofs['frozen-diagnostic-source/' + f['path']]
        check_identity(data, {'bytes': f['sizeBytes'], 'sha256': f['sha256'], 'gitBlobSha1': f['gitBlob']}, f['path'])
    alignment = proofs['profiling/jmdict-group-diagnostic/remote-alignment.json']
    require(sha(alignment) == '8e01668d76b50ba371e71499c7c4459d9e134fb4825ddd863b3deca6df167abb', 'Alignment receipt differs')
    repack_equal = None
    if repack is not None:
        pack(repack, proofs)
        repack_equal = sha(Path(repack).read_bytes()) == sha((folder / 'proofs-and-sources.tar.gz').read_bytes())
        require(repack_equal, 'Deterministic repack differs')
    return {'passed': True, 'scope': 'Retained bytes, original receipt bindings and dependency identities; no new imports/tests/timing or omitted-payload rehash',
            'asOfUtc': status['asOfUtc'], 'outerFilesVerified': len(declared), 'proofArchive': proof_summary,
            'proofSha256': sha((folder / 'proofs-and-sources.tar.gz').read_bytes()), 'cells': cells,
            'rawArchiveMembersVerified': sum(c['members'] for c in cells), 'originalImportReceiptsBound': 252,
            'dependencies': dependency_result, 'unresolvedSummaryBindings': unavailable_summary_bindings,
            'pendingOutcomePayloadsIncluded': False, 'deterministicRepackEqual': repack_equal}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, nargs='?', default=Path(__file__).resolve().parent)
    parser.add_argument('--phase2a', type=Path, help='Optional immutable phase2A proof archive')
    parser.add_argument('--phase1', type=Path, help='Optional immutable phase1 archive')
    parser.add_argument('--repack', type=Path, help='Create one new deterministic proof archive at this absent path')
    args = parser.parse_args()
    print(json.dumps(verify(args.directory, args.phase2a, args.phase1, args.repack), indent=2, sort_keys=True))
