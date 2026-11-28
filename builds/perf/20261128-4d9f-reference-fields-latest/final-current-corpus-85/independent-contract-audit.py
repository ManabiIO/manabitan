#!/usr/bin/env python3
"""Read-only final-format contract and actual previous-reader receipt audit."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

def identity(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

def main():
    if not __debug__:
        raise SystemExit('Python assertions must remain enabled')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--pins', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    pins = json.loads(args.pins.read_bytes())
    data = args.artifact.read_bytes()
    assert identity(data) == {'bytes': pins['artifactBytes'], 'sha256': pins['artifactSha256']}
    with zipfile.ZipFile(args.artifact) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        assert len(set(names)) == len(names)
        assert all(not item.is_dir() for item in entries)
        assert all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts for n in names)
        files = {name: archive.read(name) for name in names}
    read = lambda name: json.loads(files[name])
    manifest = pins['manifest']
    candidate = manifest['sourceProfiles']['B']['runtimeCommit']
    reader = manifest['sourceProfiles']['A']['runtimeCommit']
    assert candidate == '85a8aa49f76fbabd2dc494aad247f74774ff2573'
    assert reader == 'a300da36d00df8e353c5679b1528b50a1299b75f'
    exits = {}
    for name in names:
        if name.endswith('.exit.json'):
            item = read(name)
            assert item['returncode'] == 0 and item['timingEligible'] is False, name
            assert item['finishedEpoch'] >= item['startedEpoch']
            exits[name] = {'returncode': 0, 'deadlineSeconds': item['deadlineSeconds']}
    assert len(exits) == 26
    assert len([n for n in exits if re.fullmatch(r'contracts/syntax-\d\d.exit.json', n)]) == 22
    helper_prefix = 'test/perf/record-reference-table-verification/'
    evidence_prefix = 'builds/perf/20261128-4d9f-reference-fields-latest/'
    for directory, phase in [('contracts', 'contracts'), ('previous-reader', 'old-reader')]:
        complete = read(directory + '/complete.json')
        assert complete == {'success': True, 'timingEligible': False, 'phase': phase, 'candidateCommit': candidate, 'corpus': None}
        invocation = read(directory + '/invocation.json')
        assert invocation['candidateCommit'] == candidate and invocation['readerCommit'] == reader
        assert invocation['arguments']['phase'] == phase and invocation['timingEligible'] is False
        assert invocation['driverSha256'] == pins['sourceFiles'][helper_prefix + 'hosted-qualification.py']['sha256']
        assert invocation['nodeSha256'] == manifest['recordedLinuxX64NodeSha256']
    tap = files['contracts/node-contracts.stdout.log'].decode()
    for key, value in {'tests':35, 'suites':0, 'pass':35, 'fail':0, 'cancelled':0, 'skipped':0, 'todo':0}.items():
        assert re.findall(r'^# ' + key + r' (\d+)$', tap, re.M) == [str(value)]
    case_names = re.findall(r'^ok \d+ - (.*)$', tap, re.M)
    assert len(case_names) == 35 and not re.search(r'^not ok |^Bail out!', tap, re.M)
    assert files['contracts/node-contracts.stderr.log'] == b''
    python = files['contracts/python-contracts.stderr.log'].decode()
    assert re.search(r'^Ran 5 tests in \d+(?:\.\d+)?s$', python, re.M)
    assert python.rstrip().endswith('OK') and not re.search(r'FAILED|ERROR|Traceback', python)
    diagnostics = {item['name']:item for line in tap.splitlines() if line.startswith('# {') for item in [json.loads(line[2:])]}
    boundary = diagnostics['actual-public-sink-sqlite-boundary']
    assert boundary['sourceCommit'] == candidate
    assert boundary['initialSqlite'] == boundary['afterEmptyInvalidation']
    assert boundary['initialSqlite']['bytes'] == 311296 and boundary['initialSqlite']['userVersion'] == 0
    assert boundary['beforeRealInvalidation']['sha256'] != boundary['afterRealInvalidation']['sha256']
    root = {'epoch':0,'logicalHighWater':0,'rootId':'legacy-root-v0','manifest':{'version':1,'legacy':True,'regions':[]}}
    assert boundary['root'] == root and boundary['actualTermRows'] == 2
    for key in ['emptyGlossaryInvalidationPreservesEverySqliteByte','coldPersistedExactComparison','publicDuplicateExactReuse','actualScopedGlossaryInvalidation']:
        assert boundary[key] is True
    assert diagnostics['actual-public-sink-cleanup'] == {'name':'actual-public-sink-cleanup','errors':[]}
    persisted = diagnostics['actual-public-sink-persisted-records']
    assert persisted['expectedCount'] == persisted['dictionaryCount'] == persisted['size'] == 2
    assert persisted['ids'] == [1,2]
    assert persisted['state']['importSessionActive'] is False
    assert persisted['expectedContentBytes'] == 600024
    for ordinal, row in persisted['rows']:
        assert ordinal in [1,2] and row['id'] == ordinal
        assert row['score'] == row['sequence'] == ordinal
        assert row['expression'] == row['reading'] == 'public-term-' + str(ordinal)
        assert row['entryContentLength'] == 600024
        assert row['entryContentOffset'] == persisted['meta']['offset']
        assert row['entryContentDictName'] == persisted['meta']['dictName']
    preflight = read('previous-reader/acquisition/preflight.json')
    assert preflight['timingEligible'] is False
    empty_sha = hashlib.sha256(b'').hexdigest()
    for key, arm in [('candidate','B'),('reader','A')]:
        actual = preflight[key]
        expected = manifest['sourceProfiles'][arm]
        assert actual['commit'] == actual['runtimeProfileCommit'] == expected['runtimeCommit']
        assert actual['trees'] == expected['trees']
        assert actual['canonicalIdentity'] == expected['canonicalIdentity']
        assert len(actual['canonicalIdentity']) == len(actual['identity']) == 42
        assert actual['runtimeDiffSha256'] == empty_sha
        changed = [name for name in actual['identity'] if actual['identity'][name] != actual['canonicalIdentity'][name]]
        assert changed in [[],['ext/lib/zip.js']]
        normalization = actual['generatedZipComments']
        assert normalization == {'commentLines':24,'rawSha256':actual['identity']['ext/lib/zip.js'],'canonicalSha256':actual['canonicalIdentity']['ext/lib/zip.js']}
    assert preflight['manifestIdentity'] == pins['sourceFiles'][evidence_prefix + 'verification-manifest.json']
    assert preflight['evidence']['manifest'] == preflight['manifestIdentity']
    assert preflight['evidence']['protocol'] == pins['sourceFiles'][evidence_prefix + 'protocol.json']
    assert preflight['evidence']['oracles'] == {key:{k:v for k,v in value.items() if k in ['bytes','sha256']} for key,value in manifest['oracles'].items()}
    assert preflight['node']['sha256'] == manifest['recordedLinuxX64NodeSha256']
    assert preflight['fixture'] == pins['sourceFiles'][helper_prefix + 'previous-reader.fixture.mjs']
    assert preflight['adapter'] == pins['sourceFiles'][helper_prefix + 'node-opfs-bounded.mjs']
    child = read('previous-reader/acquisition/exit.json')
    assert child['status'] == 0 and child['signal'] is None and child['error'] is None and child['deadlineMs'] == 60000
    assert files['previous-reader/acquisition/stderr.log'] == b''
    result = read('previous-reader/acquisition/result.json')
    verified = read('previous-reader/acquisition/verified.json')
    assert verified == {'success':True,'timingEligible':False,'result':identity(files['previous-reader/acquisition/result.json']),'unchangedCandidateAndPreviousReader':True,'rejectedBeforeAnyRecoveryOrOpfsPreparation':True}
    assert result['success'] is True and result['candidateCommit'] == candidate and result['readerCommit'] == reader
    assert result['readerDatabaseSha256'] == manifest['sourceProfiles']['A']['canonicalIdentity']['ext/js/dictionary/dictionary-database.js']
    assert result['userVersion'] == 13 and result['actualFormat4Chunks'] == 1
    assert result['databaseBytes'] == 16384 and result['beforeDatabaseSha256'] == result['afterDatabaseSha256']
    hooks = ['recoveryCalls','contentPrepareCalls','contentActivateRootCalls','persistentPurgeCalls','recordPrepareCalls','schemaCalls','runtimePragmaCalls','healthRestoreCalls']
    assert {key:result[key] for key in hooks} == {key:0 for key in hooks}
    assert result['beforeFiles'] == result['afterFiles'] and len(result['beforeFiles']) == 2
    assert sorted(item['bytes'] for item in result['beforeFiles']) == [26,3640]
    report = {
        'schemaVersion':1, 'status':'passed', 'readOnlyAudit':True,'newAcquisition':False,
        'runId':pins['runId'],'toolingCommit':pins['toolingCommit'],'toolingTree':pins['toolingTree'],
        'artifact':{'id':pins['artifactId'],**identity(data)},'candidate':candidate,'previousReader':reader,
        'acquisitionNodeVersion':manifest['recordedNodeVersion'],'nodeBinarySha256':manifest['recordedLinuxX64NodeSha256'],
        'sourceHashesPerArm':42,'publicSourcePins':pins['sourceFiles'],
        'gates':{'nodeContracts':{'pass':35,'fail':0,'skip':0},'pythonContracts':{'pass':5,'fail':0},'syntaxCommands':22,'scopedEslintReturncode':0,'actualPreviousReaderReturncode':0},
        'previousReader':{'candidateCommit':candidate,'readerCommit':reader,'floor':13,'readerMaximumFloor':12,'actualFormat4Chunks':1,'unreachedHooks':{key:result[key] for key in hooks},'sqlite':{'bytes':result['databaseBytes'],'beforeSha256':result['beforeDatabaseSha256'],'afterSha256':result['afterDatabaseSha256']},'opfsBefore':result['beforeFiles'],'opfsAfter':result['afterFiles'],'resultIdentity':verified['result'],'unchangedCandidateAndReaderAfterTest':True},
        'publicSinkControl':{'sourceCommit':candidate,'actualRows':2,'singleRecordSession':True,'coldPersistedExactComparison':True,'publicDuplicateExactReuse':True,'actualScopedGlossaryInvalidation':True,'root':root,'emptyGlossaryPreservesWholeSqlite':True,'seededGlossaryDeletionChangesSqlite':True,'cleanupErrors':[]},
        'cleanupEvidence':'Actual public-sink control reports errors: []. The pinned previous-reader fixture closes SQLite, restores spies/globals and awaits bounded OPFS disposal in finally; the child exited0 with no signal/error, then the launcher removed its temporary test and rechecked both source receipts.',
        'limits':['This audit reads the completed contracts artifact; it reruns no contract, importer, worker or browser.','The actual a300 database reader rejection is not an older-browser restart test. OPFS preparation/recovery hooks are spies and are required to remain unreached.','The whole SQLite preservation claim applies to the early-rejection test and the empty-glossary control; the separately seeded real glossary invalidation correctly changes SQLite bytes.','No timing or process-memory conclusion is drawn from diagnostic durations.'],
        'contractNames':case_names,'memberInventory':[{'path':name,**identity(files[name])} for name in sorted(files)],
        'auditor':identity(Path(__file__).read_bytes()),'pinsIdentity':identity(args.pins.read_bytes())
    }
    with args.output.open('x') as handle:
        json.dump(report,handle,indent=2,sort_keys=True,allow_nan=False);handle.write('\n')
    print(json.dumps({'status':'passed','contracts':35,'pythonContracts':5,'previousReader':'rejected-before-all-eight-hooks','artifactId':pins['artifactId']}))

if __name__ == '__main__':
    main()
