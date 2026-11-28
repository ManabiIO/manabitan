#!/usr/bin/env python3
"""Read the original CRC artifact and reconcile every retained observation."""
import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import statistics
import subprocess
import zipfile

SOURCE = '887884769ad1b7d54872975920fc0f8fd43a56ee'
TREE = '2dc2cfa2a858ca7cea7ee8317abc2c14fd3f34af'
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
ARCHIVE_SHA = '7f48f3a5957a0de458455086e7babb22b876278f62dda934d0a5906d5719c59d'
H = 'dev/perf/crc-no-unroll-20261128-beb5/'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def close(a, b, tolerance=1e-9):
    assert isinstance(a, (int, float)) and not isinstance(a, bool)
    assert isinstance(b, (int, float)) and not isinstance(b, bool)
    assert math.isfinite(a) and math.isfinite(b) and abs(a - b) <= tolerance, (a, b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('archive', type=Path)
    ap.add_argument('--repo', type=Path, required=True)
    ap.add_argument('--logged-audit', type=Path, required=True)
    ap.add_argument('--reference-capture', type=Path)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    assert not args.out.exists()
    raw = args.archive.read_bytes()
    assert len(raw) == 641405 and sha(raw) == ARCHIVE_SHA
    git = lambda *parts: subprocess.check_output(['git', *parts], cwd=args.repo)
    assert git('rev-parse', SOURCE + '^{tree}').decode().strip() == TREE
    assert git('rev-list', '--parents', '-n', '1', SOURCE).decode().split() == [SOURCE, BASE]
    logged = json.loads(args.logged_audit.read_text())
    assert logged['completeArmTotals'] == 24 and logged['independentRawGroupAudit'] is False

    with zipfile.ZipFile(args.archive) as archive:
        infos = archive.infolist()
        assert len(infos) == 327
        assert len({i.filename for i in infos}) == len(infos)
        assert all(not i.is_dir() and not PurePosixPath(i.filename).is_absolute()
                   and '..' not in PurePosixPath(i.filename).parts for i in infos)
        files = {i.filename: archive.read(i) for i in infos}
        read = lambda name: files['jmdict/' + name]
        obj = lambda name: json.loads(read(name))
        lines = lambda name: [json.loads(line) for line in read(name).decode().splitlines()]
        assert read('source-sha.txt').decode().strip() == SOURCE
        assert read('source-tree.txt').decode().strip() == TREE
        registration = obj('registration.json')
        assert read('registration.json') == git('show', SOURCE + ':' + H + 'registration.json')
        assert registration['baselineCommit'] == BASE
        source_count = 0
        for path, digest in registration['sourceFiles'].items():
            assert sha(git('show', SOURCE + ':' + path)) == digest
            source_count += 1

        build = obj('build.json')
        assert build['passed'] and build['baselineReproducedByteExactly']
        assert build['sourceCommit'] == SOURCE and build['sourceTree'] == TREE
        assert build['soleParent'] == BASE
        assert build['registrationSha256'] == sha(read('registration.json'))
        for path, digest in build['nativeSourceSha256'].items():
            assert sha(git('show', SOURCE + ':' + path)) == digest
            source_count += 1
        baseline_c = git('show', BASE + ':ext/js/dictionary/wasm/term-bank-parser.c')
        pragma = b'        #pragma clang loop unroll(disable)\n'
        assert read('modules/baseline.c') == baseline_c
        candidate_c = read('modules/candidate.c')
        assert candidate_c.count(pragma) == 1 and candidate_c.replace(pragma, b'', 1) == baseline_c
        module_rows = {}
        for variant in ('baseline', 'candidate'):
            item = build['variants'][variant]
            for suffix, field in (('.c', 'sourceSha256'), ('.wasm', 'wasmSha256'),
                                  ('-test.wasm', 'testWasmSha256'), ('.s', 'assemblySha256')):
                assert sha(read('modules/' + variant + suffix)) == item[field]
            assert item['sourceSha256'] == registration[variant + 'SourceSha256']
            assert item['wasmSha256'] == registration[variant + 'WasmSha256']
            assert item['wasmBytes'] == len(read('modules/' + variant + '.wasm'))
            assert '-DTERM_BANK_CRC_TEST' not in item['command']
            assert '-DTERM_BANK_CRC_TEST' in item['testCommand']
            module_rows[variant] = {'sha256': item['wasmSha256'], 'bytes': item['wasmBytes']}
        assert read('modules/baseline.wasm') == git('show', BASE + ':dev/data/dictionary-wasm/term-bank-parser.wasm')

        capture = obj('capture/manifest.json')
        assert capture['baseline'] == BASE
        assert capture['wasmSha256'] == registration['baselineWasmSha256']
        assert capture['captureSha256'] == registration['sourceFiles'][H + 'capture.mjs']
        fixture = registration['fixture']
        for key in ('archiveSha256', 'archiveBytes', 'lockSha256'):
            assert capture[key] == fixture[key]
        assert len(capture['groups']) == 12
        assert sum(len(g['banks']) for g in capture['groups']) == 53
        assert capture['totalRows'] == 528299
        assert capture['compressedBytes'] == 15632849
        assert capture['decodedBytes'] == 171617523
        for index, group in enumerate(capture['groups']):
            assert group['groupIndex'] == index
            assert group['crcReuseEligible'] is False
            assert group['decodedBytes'] >= 4 * 1024 * 1024
            assert group['compressedBytes'] > group['decodedBytes'] // 32
            for key, bank_key in (('rows', 'rows'), ('compressedBytes', 'compressedSize'), ('decodedBytes', 'uncompressedSize')):
                assert sum(bank[bank_key] for bank in group['banks']) == group[key]
        reference = None
        if args.reference_capture:
            reference_bytes = args.reference_capture.read_bytes()
            reference_obj = json.loads(reference_bytes)
            assert reference_obj['groups'] == capture['groups']
            assert reference_obj['archiveSha256'] == capture['archiveSha256']
            reference = {'sha256': sha(reference_bytes), 'allGroupAndBankDescriptorsEqual': True,
                         'scope': 'Matches the separately completed current-baseline source-output oracle; no native code is executed by this auditor.'}

        conformance = obj('capture/conformance.json')
        assert conformance['nativeWasmSha256'] == registration['baselineWasmSha256']
        assert len(conformance['cases']) == 157 and len(conformance['formats']) == 14
        checked_payloads = set()
        for case in conformance['cases']:
            for entry in case['sources']:
                payload = read('capture/' + entry['filename'])
                assert len(payload) == entry['byteLength'] and sha(payload) == entry['sha256']
                checked_payloads.add(entry['filename'])

        verification = obj('verify.json')
        assert verification['passed'] is True and 'failure' not in verification
        assert verification['registrationSha256'] == sha(read('registration.json'))
        assert verification['buildSha256'] == sha(read('build.json'))
        assert verification['captureManifestSha256'] == sha(read('capture/manifest.json'))
        assert verification['verifySha256'] == registration['sourceFiles'][H + 'verify.mjs']
        assert verification['conformanceCaptureSha256'] == sha(read('capture/conformance.json'))
        assert verification['nodeVersion'] == 'v22.22.0' and verification['execArgv'] == []
        vector_order = [('published', 9, 0), ('empty', 0, 0)]
        vector_order += [('short', length, 0) for length in range(257)]
        boundaries = [63,64,65,127,128,129,65535,65536,65537,131071,131072,131073,
                      262143,262144,262145,262207,262208,262209,1048576,1048639]
        vector_order += [('boundary', length, alignment) for length in boundaries for alignment in range(16)]
        vector_order += [('all-braid-tails', 262144 + tail, alignment) for tail in range(64) for alignment in (0,1,7,15)]
        vector_order += [('large', 4 * 1024 * 1024 + 63, alignment) for alignment in (0,15)]
        assert len(vector_order) == len(verification['vectors']) == 837
        for row, expected_order in zip(verification['vectors'], vector_order):
            assert row['stage'] == 'crc-vector'
            assert (row['label'], row['length'], row['alignment']) == expected_order
            assert isinstance(row['expected'], int) and 0 <= row['expected'] <= 0xffffffff
            assert row['actual'] == {'baseline': row['expected'], 'candidate': row['expected']}
        assert verification['vectors'][0]['expected'] == 0xcbf43926
        assert verification['vectors'][1]['expected'] == 0
        assert len(verification['conformance']) == 157
        for row, case in zip(verification['conformance'], conformance['cases']):
            assert row['stage'] == 'production-conformance' and row['name'] == case['name']
            assert row['expected'] == case['expected']
            assert row['actual'] == {'baseline': case['expected'], 'candidate': case['expected']}
        assert len(verification['groups']) == 12
        for row, group in zip(verification['groups'], capture['groups']):
            assert row['stage'] == 'full-jmdict-production-inflate'
            assert row['groupIndex'] == group['groupIndex'] and row['rows'] == group['rows']
            assert row['actual']['baseline'] == row['actual']['candidate']
            assert row['actual']['baseline']['decodedSha256'] == group['decodedSha256']
            assert row['actual']['baseline']['bankCount'] == len(group['banks'])
            assert row['actual']['baseline']['memoryShared'] is True
        verification_journal = lines('verify.observations.jsonl')
        assert verification_journal == verification['vectors'] + verification['conformance'] + verification['groups']

        plan = obj('campaign/registered-plan.json')
        identities = {'registrationSha256': sha(read('registration.json')),
                      'buildSha256': sha(read('build.json')),
                      'captureManifestSha256': sha(read('capture/manifest.json')),
                      'correctnessReceiptSha256': sha(read('verify.json'))}
        for key, digest in identities.items():
            assert plan[key] == digest
        schedule = []
        for pair in range(6):
            for scenario in (('treatment','control') if pair % 2 == 0 else ('control','treatment')):
                labels = ['A', 'B' if scenario == 'treatment' else 'C']
                if pair % 2: labels.reverse()
                for label in labels:
                    schedule.append({'pair': pair, 'scenario': scenario, 'label': label,
                                     'variant': 'candidate' if label == 'B' else 'baseline',
                                     'armId': f'{scenario}-{pair + 1:02}-{label}'})
        assert plan['schedule'] == schedule and plan['armTimeoutMs'] == 180000
        arms = lines('campaign/arms.jsonl')
        assert len(arms) == 24
        by_id = {}
        pids = set()
        journal_count = 0
        capacity_sets = {}
        logged_by_id = {row['value']['armId']: row['value'] for row in logged['loggedArms']}
        for arm, expected in zip(arms, schedule):
            prefix = 'campaign/' + expected['armId'] + '/'
            assert {key: arm[key] for key in expected} == expected
            assert obj(prefix + 'identity.json') == expected
            assert arm['exit'] == {'code': 0, 'signal': None}
            assert arm['timedOut'] is False and arm['spawnError'] is None
            report = obj(prefix + 'report.json')
            assert arm['report'] == report and report['passed'] is True
            assert report['armId'] == expected['armId'] and report['variant'] == expected['variant']
            assert report['nodeVersion'] == 'v22.22.0' and report['execArgv'] == [] and report['nodeOptions'] == ''
            assert report['moduleSha256'] == module_rows[expected['variant']]['sha256']
            for key, digest in identities.items(): assert report[key] == digest
            assert report['pid'] not in pids
            pids.add(report['pid'])
            assert len(report['workers']) == len(report['prepared']) == 3
            worker_threads = {}
            for index, worker in enumerate(report['workers']):
                assert worker == {'type':'initialized','workerIndex':index,'threadId':worker['threadId'],'execArgv':[]}
                worker_threads[index] = worker['threadId']
                assert report['prepared'][index] == {'type':'prepared','workerIndex':index,'threadId':worker['threadId'],'groups':list(range(index,12,3))}
            assert len(set(worker_threads.values())) == 3
            assert len(report['groups']) == 24 and len(report['phases']) == 2
            journal = lines(prefix + 'observations.jsonl')
            journal_count += len(journal)
            assert len(journal) == 57
            assert sorted([item['message'] for item in journal[:3]], key=lambda x:x['workerIndex']) == report['workers']
            assert sorted([item['message'] for item in journal[3:6]], key=lambda x:x['workerIndex']) == report['prepared']
            assert all(item['event'] == 'worker-message' and item['workerIndex'] == item['message']['workerIndex'] for item in journal[:6])
            assert journal[6] == {'event':'ready','initializationWallMs':report['initializationWallMs'],'compilationMs':report['compilationMs'],'inputPreparationWallMs':report['inputPreparationWallMs']}
            cursor = 7
            for phase_index, phase in enumerate(('first-pass','second-pass')):
                selected = report['groups'][phase_index * 12:(phase_index + 1) * 12]
                for index, (group, observed) in enumerate(zip(capture['groups'], selected)):
                    assert observed['type'] == 'group-result' and observed['phase'] == phase
                    assert observed['groupIndex'] == index and observed['workerIndex'] == index % 3
                    assert observed['threadId'] == worker_threads[index % 3]
                    assert observed['invocation'] == phase_index * 4 + index // 3 + 1
                    assert observed['firstInvocation'] is (phase_index == 0 and index < 3)
                    assert observed['passed'] is True and observed['stage'] == 'complete' and observed['memoryShared'] is True
                    for key in ('rows','compressedBytes','decodedBytes','decodedSha256'): assert observed[key] == group[key]
                    assert observed['inputCopiedBytes'] == group['compressedBytes']
                    assert observed['bankCount'] == len(group['banks'])
                    assert math.isfinite(observed['owningMs']) and observed['owningMs'] > 0
                    assert 0 <= observed['nativeInflateAndCrcMs'] <= observed['owningMs'] + 0.001
                    assert observed['wasmCapacityBytes'] > 0 and observed['wasmCapacityBytes'] % 65536 == 0
                    capacity_sets.setdefault((phase,index),set()).add(observed['wasmCapacityBytes'])
                    assert journal[cursor] == {'event':'group-dispatch','phase':phase,'groupIndex':index,'workerIndex':index%3}
                    assert journal[cursor+1] == {'event':'worker-message','workerIndex':index%3,'message':observed}
                    cursor += 2
                summary = report['phases'][phase_index]
                assert summary['phase'] == phase and summary['groupCount'] == 12
                for key in ('owningMs','nativeInflateAndCrcMs','compressedBytes','decodedBytes','rows'):
                    close(summary[key], sum(row[key] for row in selected))
                close(summary['firstInstanceInvocationMs'],sum(row['owningMs'] for row in selected if row['firstInvocation']))
                close(summary['subsequentInvocationMs'],sum(row['owningMs'] for row in selected if not row['firstInvocation']))
                assert summary['maximumInstanceCapacityBytes'] == max(row['wasmCapacityBytes'] for row in selected)
                assert journal[cursor] == {'event':'phase-complete',**summary}
                cursor += 1
            assert cursor == len(journal)
            close(report['startupPlusFirstPassOwningMs'],report['initializationWallMs']+report['phases'][0]['owningMs'])
            logged_arm = logged_by_id[expected['armId']]
            close(logged_arm['firstPassMs'],report['phases'][0]['owningMs'])
            close(logged_arm['secondPassMs'],report['phases'][1]['owningMs'])
            close(logged_arm['initializationWallMs'],report['initializationWallMs'])
            by_id[expected['armId']] = report

        analysis = obj('campaign/analysis.json')
        assert analysis['passed'] is True and analysis['observations'] == 24 and analysis['measuredGroups'] == 576
        for key in ('registrationSha256','buildSha256','captureManifestSha256'): assert analysis[key] == identities[key]
        computed = []
        for scenario in ('treatment','control'):
            for phase in ('first-pass','second-pass','startup-plus-first-pass'):
                pairs = []
                for pair in range(6):
                    aid=f'{scenario}-{pair+1:02}-A'; bid=f'{scenario}-{pair+1:02}-' + ('B' if scenario=='treatment' else 'C')
                    value=lambda r:r['startupPlusFirstPassOwningMs'] if phase=='startup-plus-first-pass' else r['phases'][phase=='second-pass']['owningMs']
                    a=value(by_id[aid]); b=value(by_id[bid])
                    pairs.append({'pair':pair,'baselineArmId':aid,'comparedArmId':bid,'baselineMs':a,'comparedMs':b,'ratio':b/a,'deltaMs':b-a})
                cell={'scenario':scenario,'phase':phase,'pairs':pairs,'medianRatio':statistics.median(p['ratio'] for p in pairs),'equalWorkRatio':sum(p['comparedMs'] for p in pairs)/sum(p['baselineMs'] for p in pairs),'fasterPairs':sum(p['ratio']<1 for p in pairs)}
                expected_cell=next(x for x in analysis['cells'] if x['scenario']==scenario and x['phase']==phase)
                assert expected_cell['pairs'] == pairs
                for key in ('medianRatio','equalWorkRatio'): close(cell[key],expected_cell[key],1e-12)
                assert cell['fasterPairs']==expected_cell['fasterPairs']
                logged_cell=next(x for x in logged['cells'] if x['scenario']==scenario and x['phase']==phase)
                for key in ('medianRatio','equalWorkRatio'): close(cell[key],logged_cell[key],1e-12)
                computed.append(cell)
        assert len(analysis['cells'])==6
        result={'complete':True,'scope':'Independent read-only reconciliation of original source-bound CRC component artifact, all raw groups, all journals and logged totals. No timing or native code rerun; no browser or process-memory qualification.',
                'run':46120623371,'source':SOURCE,'tree':TREE,'baseline':BASE,'artifactId':15255386235,
                'archiveSha256':ARCHIVE_SHA,'archiveBytes':len(raw),'members':len(files),
                'sourceFilesRehashedAgainstGit':source_count,'modules':module_rows,
                'crcVectorRecords':837,'sourceConformanceRecords':157,'untestedStandaloneDsFormatEntries':14,
                'conformancePayloadFilesRehashed':len(checked_payloads),'untimedCompleteGroups':12,
                'verificationJournalEntries':len(verification_journal),'timedArms':24,'freshProcessIds':len(pids),
                'rawGroups':576,'armJournalEntries':journal_count,'allGroupCapacitiesEqualAcrossArms':all(len(v)==1 for v in capacity_sets.values()),
                'nativeCapacityScope':'Reserved WASM buffer sizes only; not whole-process peak memory.',
                'referenceCapture':reference,'cells':computed,
                'memberInventory':[{'path':name,'bytes':len(data),'sha256':sha(data)} for name,data in sorted(files.items())]}
    args.out.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key not in ('cells','memberInventory')},indent=2))


if __name__ == '__main__':
    main()
