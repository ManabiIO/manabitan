#!/usr/bin/env python3
"""Audit frozen latest-metadata JV artifact receipts without running imports."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

def sha(data):
    return hashlib.sha256(data).hexdigest()

def identity(path):
    data = path.read_bytes()
    return {'bytes': len(data), 'sha256': sha(data)}

def read(path):
    return json.loads(path.read_bytes())

def save(path, data):
    with path.open('x') as output:
        json.dump(data, output, indent=2, sort_keys=True, allow_nan=False)
        output.write('\n')

def tap(path, expected):
    text = path.read_text()
    for key, value in {'tests': expected, 'pass': expected, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}.items():
        assert re.findall(r'^# ' + key + r' (\d+)$', text, re.M) == [str(value)], (path, key)
    assert len(re.findall(r'^ok \d+ - ', text, re.M)) == expected
    assert not re.search(r'^not ok |^Bail out!', text, re.M)
    return [json.loads(line[2:]) for line in text.splitlines() if line.startswith('# {')]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['artifacts', 'helpers', 'oracle-archive', 'pins', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    if not __debug__:
        raise SystemExit('Assertions must remain enabled')
    pins = read(args.pins)
    args.output.mkdir(exist_ok=False)
    assert identity(args.oracle_archive) == {k: pins['oracleArchive'][k] for k in ['bytes', 'sha256']}
    with tarfile.open(args.oracle_archive, 'r:gz') as archive:
        oracle_files = {}
        for member in archive.getmembers():
            parts = PurePosixPath(member.name)
            assert member.isfile() and not member.issym() and not member.islnk()
            assert not parts.is_absolute() and '..' not in parts.parts and member.name not in oracle_files
            oracle_files[member.name] = archive.extractfile(member).read()
    assert len(oracle_files) == pins['oracleArchive']['members'] == 8
    helper_pins = {PurePosixPath(item['path']).name: item for item in pins['helpers']}
    for name in ['common.mjs', 'compare-results-with-legacy-context.mjs']:
        assert identity(args.helpers / name) == {k: helper_pins[name][k] for k in ['bytes', 'sha256']}
    assert all(job['status'] == 'completed' and job['conclusion'] == 'success' for job in pins['jobs'])
    assert all(step['status'] == 'completed' and step['conclusion'] == 'success' for job in pins['jobs'] for step in job['steps'])
    cells = []
    for artifact in pins['artifacts']:
        assert artifact['runId'] == pins['runId'] and artifact['toolingCommit'] == pins['toolingCommit']
        corpus = artifact['corpus']
        zip_path = args.artifacts / (artifact['name'] + '.zip')
        assert identity(zip_path) == {k: artifact[k] for k in ['bytes', 'sha256']}
        directory = args.output / corpus
        directory.mkdir()
        inventory = []
        with zipfile.ZipFile(zip_path) as archive:
            names = [item.filename for item in archive.infolist() if not item.is_dir()]
            assert len(names) == len(set(names))
            assert not any('failure' in name for name in names)
            for name in names:
                parts = PurePosixPath(name)
                assert not parts.is_absolute() and '..' not in parts.parts
                data = archive.read(name)
                target = directory / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                inventory.append({'path': name, 'bytes': len(data), 'sha256': sha(data)})
        save(directory / 'independent-members.json', inventory)
        preflight = read(directory / 'preflight.json')
        assert preflight['status'] == 'verified' and preflight['timingEligible'] is False
        assert preflight['toolingCommit'] == pins['toolingCommit'] and preflight['toolingTree'] == pins['toolingTree']
        for name, field in [('verification-manifest.json', 'manifestSha256'), ('protocol.json', 'protocolSha256'), ('source-profile-transition.json', 'transitionSha256')]:
            assert identity(directory / name) == pins['files'][name]
            assert preflight[field] == pins['files'][name]['sha256']
        assert preflight['orchestratorSha256'] == pins['orchestratorSha256']
        assert preflight['workflowSha256'] == pins['workflowSha256']
        assert preflight['source'] == {arm: {key: value[key] for key in ['commit', 'tree']} for arm, value in pins['source'].items()}
        assert preflight['helperFiles'] == [{'path': item['path'], 'gitBlob': item['sha'], 'sha256': item['sha256']} for item in pins['helpers']]
        manifest = read(directory / 'verification-manifest.json')
        assert preflight['node']['version'] == manifest['recordedNodeVersion'] == 'v22.22.0'
        assert preflight['node']['sha256'] == manifest['recordedLinuxX64NodeSha256'] == '1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31'
        oracle_index = read(directory / 'verification-oracles-index.json')
        assert preflight['oracleArchive'] == oracle_index
        assert oracle_index['sha256'] == pins['oracleArchive']['sha256'] and oracle_index['memberCount'] == 8
        assert set(oracle_index['members']) == set(oracle_files)
        for name, data in oracle_files.items():
            assert oracle_index['members'][name] == {'bytes': len(data), 'sha256': sha(data)}
        assert read(directory / 'pipeline-negative-control.json') == {'expectedExit': 37, 'actualExit': 37, 'passed': True}
        assert read(directory / 'arm-exits.json') == {'A': 0, 'B': 0}
        tap(directory / 'contracts.log', 26)
        fixture = pins['fixtures'][corpus]
        assert preflight['fixture'] == fixture
        assert preflight['archive'] == {'bytes': fixture['sizeBytes'], 'sha256': fixture['sha256']}
        arms = {}
        boundary_checks = {}
        for arm in ['A', 'B']:
            diagnostics = tap(directory / ('legacy-context-contracts-' + arm + '.log'), 15)
            boundaries = [entry for entry in diagnostics if entry.get('name') == 'actual-public-sink-sqlite-boundary']
            assert len(boundaries) == 1
            boundary = boundaries[0]
            assert boundary['sourceCommit'] == pins['source'][arm]['commit']
            assert boundary['actualTermRows'] == 2
            assert all(boundary[key] is True for key in ['coldPersistedExactComparison', 'publicDuplicateExactReuse', 'actualScopedGlossaryInvalidation'])
            assert boundary['initialSqlite'] == boundary['afterEmptyInvalidation']
            assert boundary['emptyGlossaryInvalidationPreservesEverySqliteByte'] is True
            assert boundary['beforeRealInvalidation']['sha256'] != boundary['afterRealInvalidation']['sha256']
            assert all(boundary[key]['userVersion'] == 0 for key in ['initialSqlite', 'afterEmptyInvalidation', 'beforeRealInvalidation', 'afterRealInvalidation'])
            boundary_checks[arm] = boundary
            arm_dir = directory / (corpus + '-' + arm + '-1')
            result = read(arm_dir / 'result.json')
            launcher = read(directory / (corpus + '-' + arm + '-1.launcher.json'))
            assert launcher['status'] == 'complete' and launcher['returncode'] == 0 and launcher['terminatingSignal'] is None
            assert launcher['timingEligible'] is False and launcher['deadlineSeconds'] == 1200
            assert launcher['launcherSha256'] == helper_pins['launch-with-legacy-context.py']['sha256']
            command = launcher['command']
            assert command[1] == '--max-old-space-size=512'
            assert Path(command[2]).name == 'run-with-legacy-context.mjs'
            assert command[command.index('--source-id') + 1] == pins['source'][arm]['commit']
            assert command[command.index('--corpus') + 1] == corpus and command[command.index('--arm') + 1] == arm
            assert command[command.index('--node-sha256') + 1] == manifest['recordedLinuxX64NodeSha256']
            assert result['success'] is True and result['timingEligible'] is False and result['arm'] == arm and result['corpus'] == corpus
            assert result['source']['commit'] == result['source']['runtimeProfileCommit'] == pins['source'][arm]['commit']
            assert result['source']['trees'] == manifest['sourceProfiles'][arm]['trees']
            assert result['source']['canonicalIdentity'] == manifest['sourceProfiles'][arm]['canonicalIdentity']
            assert len(result['source']['canonicalIdentity']) == 42
            assert result['source']['identity'] == result['source']['canonicalIdentity']
            assert result['source']['runtimeDiffSha256'] == sha(b'')
            assert result['fixture'] == fixture and result['rows'] == fixture['termRows']
            assert result['lockSha256'] == pins['dictionaryLock']['sha256']
            assert result['node'] == 'v22.22.0' and result['runtimeIdentity']['sha256'] == manifest['recordedLinuxX64NodeSha256']
            assert result['execArgv'] == ['--max-old-space-size=512']
            assert result['helperIdentity'] == {name: item['sha256'] for name, item in helper_pins.items() if name != 'README.md'}
            assert result['evidenceIdentity']['manifest'] == pins['files']['verification-manifest.json']
            assert result['evidenceIdentity']['protocol'] == pins['files']['protocol.json']
            assert result['evidenceIdentity']['oracles'] == {name: {key: item[key] for key in ['bytes', 'sha256']} for name, item in manifest['oracles'].items()}
            assert result['policy']['capabilities'] == {'hardwareConcurrency': 4, 'deviceMemory': 8}
            assert result['policy']['parserWorkers'] == 3 and result['compression']['codecWorkers'] == 4
            groups = result['groupResults']
            assert len(groups) == result['policy']['groups'] == pins['groupCounts'][corpus]
            assert [group['group'] for group in groups] == list(range(len(groups)))
            assert sum(group['rows'] for group in groups) == result['rows']
            assert sum(group['sourceBytes'] for group in groups) == result['totalBytes']
            assert sum(len(group['banks']) for group in groups) == result['bankCount']
            assert sum(check['rows'] for check in result['sourceChecks']) == result['rows']
            assert all(check['allRowsMatchSource'] is True for check in result['sourceChecks'])
            assert result['summary']['rows'] == result['rows']
            oracle_bytes = (arm_dir / 'final-output-oracle.json').read_bytes()
            assert oracle_bytes == oracle_files['oracles/' + corpus + '-output.json']
            assert result['finalOracle'] == {'bytes': len(oracle_bytes), 'sha256': sha(oracle_bytes)}
            oracle = json.loads(oracle_bytes)
            assert len(oracle['metadata']) == 23 and oracle['persisted']['generationLinkageVerified'] is True
            assert read(arm_dir / 'complete-file-oracle.json') == result['completeFileOracle']
            assert result['completeFileOracle']['allFileBytesMatch'] is True and result['completeFileOracle']['allLogicalMetadataMatches'] is True
            assert result['completeFileOracle']['expectedOracleSha256'] == sha(oracle_bytes)
            raw_files = read(arm_dir / 'raw-final-files.json')
            expected_files = {item['path']: item for item in oracle['persisted']['files']}
            assert {item['path']: item['bytes'] for item in raw_files['files']} == {name: item['bytes'] for name, item in expected_files.items()}
            for entry in raw_files['files']:
                if expected_files[entry['path']]['normalizedGenerationRange'] is None:
                    assert entry['sha256'] == expected_files[entry['path']]['sha256']
            for filename, generation in raw_files['generations']:
                assert generation['record'] == generation['index'] and re.fullmatch(r'[0-9a-f]{32}', generation['record'])
                selected = {entry['path']: entry['generation'] for entry in raw_files['files'] if entry['path'] in [filename, filename + '.mbti']}
                assert selected == {filename: generation['record'], filename + '.mbti': generation['index']}
            allocation_receipt = read(arm_dir / 'metadata-allocation.json')
            assert allocation_receipt == {
                'arm': arm, 'corpus': corpus, 'recordIdRepresentation': result['recordIdRepresentation'],
                'final': result['metadataAllocation'],
                'groups': [dict(group=group['group'], **group['metadataAllocation']) for group in groups],
                'nullPhysicalSignature1EveryGroup': result['nullPhysicalSignature1EveryGroup'],
                'nullPhysicalDictionaryNameIdsEveryGroup': result['nullPhysicalDictionaryNameIdsEveryGroup'],
            }
            for allocation in [group['metadataAllocation'] for group in groups] + [result['metadataAllocation']]:
                assert allocation['ownedArenaAndSignature1Bytes'] == allocation['nativeArenaBytes'] + allocation['externalSignature1Bytes']
                assert allocation['ownedArenaAndOptionalColumnsBytes'] == allocation['ownedArenaAndSignature1Bytes'] + allocation['dictionaryNameIds']['backingBytes']
            arms[arm] = result
        recomputed_path = directory / 'independent-comparison.json'
        command = ['node', str(args.helpers / 'compare-results-with-legacy-context.mjs'), str(directory / (corpus + '-A-1')), str(directory / (corpus + '-B-1')), str(recomputed_path), '--evidence-dir', str(directory)]
        completed = subprocess.run(command, capture_output=True, text=True)
        (directory / 'independent-comparator.stdout.log').write_text(completed.stdout)
        (directory / 'independent-comparator.stderr.log').write_text(completed.stderr)
        save(directory / 'independent-comparator-command.json', {'command': command, 'returncode': completed.returncode, 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'readOnly': True, 'newCorpusAcquisition': False})
        assert completed.returncode == 0, completed.stderr
        comparison = read(recomputed_path)
        original_comparison = read(directory / (corpus + '-comparison.json'))
        for side in ['parent', 'candidate']:
            assert Path(comparison[side]['directory']).name == Path(original_comparison[side]['directory']).name
            comparison[side]['directory'] = original_comparison[side]['directory']
        assert comparison == original_comparison
        assert comparison['finalOwnedBytesAvoided'] == pins['expectedOwnedBytesAvoided'][corpus]
        cells.append({'corpus': corpus, 'artifact': artifact, 'status': 'passed', 'rows': comparison['rows'], 'groups': comparison['groups'], 'ownedBytesAvoided': comparison['finalOwnedBytesAvoided'], 'signatureBytesAvoided': comparison['finalSignatureArenaBytesAvoided'], 'dictionaryNameBytesAvoided': comparison['finalDictionaryNameBytesAvoided'], 'completeOutputOracle': comparison['finalOutputOracle'], 'logicalMetadataColumns': len(comparison['logicalMetadataColumns']), 'sourceHashesPerArm': 42, 'helperFiles': 20, 'unchangedContracts': 26, 'realIoPublicSinkContractsPerArm': 15, 'completeComparatorRecomputed': True, 'publicSinkBoundary': boundary_checks, 'timingEligible': False, 'processMemoryImprovementClaim': False})
    save(args.output / 'independent-audit-index.json', {'schemaVersion': 1, 'runId': pins['runId'], 'toolingCommit': pins['toolingCommit'], 'toolingTree': pins['toolingTree'], 'sources': pins['source'], 'cells': cells, 'readOnlyAudit': True, 'acquisitionNode': 'v22.22.0', 'auditorNode': subprocess.check_output(['node', '--version'], text=True).strip(), 'noNewCorpusAcquisition': True, 'originalFailuresRetainedSeparately': True, 'limitations': ['These are sequential production-group term-sink and independently decoded metadata/file oracles, not browser import timings or process peak-memory measurements.', 'Complete persisted-file hashes are validated against frozen independently retained oracles; the audit reruns the recorded comparator, not the original importer or file-writing pipeline.', 'Media projection/path coverage remains separate from media file persistence, browser UI/restart, lookup and full SQLite publication.'], 'inputs': {'pins': identity(args.pins), 'script': identity(Path(__file__)), 'oracleArchive': identity(args.oracle_archive)}})
    print(json.dumps([{'corpus': item['corpus'], 'status': item['status'], 'rows': item['rows'], 'groups': item['groups'], 'ownedBytesAvoided': item['ownedBytesAvoided']} for item in cells]))

if __name__ == '__main__':
    main()
