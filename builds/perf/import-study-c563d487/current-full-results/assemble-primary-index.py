#!/usr/bin/env python3
"""Index immutable current-cohort primary audits; never acquire or alter observations."""
import collections
import datetime
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
TOOLING = ROOT.parent / 'numeric-suffix-972-full-qualification/published-faf6d9d9'
AUDITOR_SHA = '0a90d65ebda54d584a120ba0a9d1f5780ad550481f3aa7a08666307b7bd82656'
EXPECTED_SHA = 'bfeeb222b68ece3ea10240a3350471962d8281b023a1391a58ad20844d9dc912'
JOBS = {
    'jmdict-AB': 140933489138, 'jmdict-BA': 140933489203,
    'jitendex-AB': 140933489159, 'jitendex-BA': 140933489153,
    'vndb-AB': 140933489168, 'vndb-BA': 140933489131,
}
PRIMARY = re.compile(r'\bMANABITAN_QUALIFICATION_JSON (\{.*\})\s*$')
ARCHIVE = re.compile(r'MANABITAN_EVIDENCE_ARCHIVE_COMPLETE (\{.*\})\s*$')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def identity(path):
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT.parent)), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    output = ROOT / 'combined-primary-index.json'
    require(not output.exists(), 'Refusing to overwrite an existing final index')
    expected_path = TOOLING / 'independent-complete-import-expected.json'
    auditor_path = TOOLING / 'independent-complete-import-audit.js'
    require(identity(expected_path)['sha256'] == EXPECTED_SHA, 'Expected binding changed')
    require(identity(auditor_path)['sha256'] == AUDITOR_SHA, 'Frozen auditor changed')
    expected = read_json(expected_path)
    missing = [name for name in JOBS if not (ROOT / name / 'primary-log-audit.json').exists()]
    require(not missing, 'Six terminal primary audits required; pending: ' + ', '.join(missing))
    cells = {}
    source_entry_maps = {'A': set(), 'B': set()}
    semantics = collections.defaultdict(set)
    totals = collections.Counter()
    for name, job_id in JOBS.items():
        directory = ROOT / name
        audit_path = directory / 'primary-log-audit.json'
        records_path = directory / 'primary-records.jsonl'
        log_path = directory / 'primary-job.log'
        audit = read_json(audit_path)
        log = log_path.read_text(encoding='utf-8')
        matches = [PRIMARY.search(line) for line in log.splitlines()]
        exact_records = ''.join('MANABITAN_QUALIFICATION_JSON ' + m.group(1) + '\n' for m in matches if m)
        require(records_path.read_text(encoding='utf-8') == exact_records, name + ': original record bytes differ')
        records = [json.loads(m.group(1)) for m in matches if m]
        observations = [r['value'] for r in records if r['kind'] == 'observation']
        result_files = {r['value']['path']: r['value']['value'] for r in records if r['kind'] == 'result-file'}
        memory = result_files.get('memory/observations.json', [])
        dictionary, order = name.rsplit('-', 1)
        require(audit['jobId'] == job_id and audit['runId'] == expected['runId'], name + ': job/run mismatch')
        require(audit['dictionary'] == dictionary and audit['order'] == order, name + ': cell mismatch')
        require(audit['auditorSha256'] == AUDITOR_SHA and audit['expectedSha256'] == EXPECTED_SHA, name + ': auditor binding mismatch')
        require(audit['primaryLogSha256'] == identity(log_path)['sha256'], name + ': log hash mismatch')
        require(audit['rawTaggedRecordsSha256'] == identity(records_path)['sha256'], name + ': records hash mismatch')
        require(audit['observations'] == len(observations), name + ': report count mismatch')
        for key in ('baseline', 'candidate', 'workflowCommit', 'workflowSha256', 'observerSha256', 'fixtureLockSha256'):
            require(audit['cohort'][key] == expected[key], name + ': ' + key + ' mismatch')
        require(audit['cohort']['fixture'] == expected['fixtures'][dictionary], name + ': fixture mismatch')
        require(audit['browser'] == expected['browser'], name + ': browser mismatch')
        for arm, source in audit['sourceIdentities'].items():
            require(source['tree'] == expected['sourceTrees'][arm], name + ': source tree mismatch')
            require(source['sha'] == expected['baseline' if arm == 'A' else 'candidate'], name + ': source commit mismatch')
            require(source['changedPackageEntryHashes'] == expected['packageHashes'][arm], name + ': native package entry mismatch')
            require(source['packageEntryCount'] == expected['packageEntryCount'], name + ': package entry count mismatch')
            for path, sha in expected['sourceHashes'].items():
                require(source['sourceHashes'][path] == sha, name + ': harness source mismatch: ' + path)
            source_entry_maps[arm].add(source['packageEntriesSha256'])
        semantics[dictionary].add(audit['lookupSemanticSha256'])
        require(audit['storageBytes'] == expected['storageBytes'][dictionary], name + ': storage mismatch')
        roles = collections.Counter(o['role']['kind'] for o in observations)
        require(all(o['requestedFlags'] == {} for o in observations), name + ': production default flags changed')
        candidate, control = audit['candidateVsBaseline'], audit['identicalCodeControl']
        qualified = sum(m['qualifiedForWholeTreePss'] is True for m in memory)
        coverage = [{key: m[key] for key in (
            'name', 'arm', 'pair', 'qualifiedForWholeTreePss', 'qualificationFailures',
            'maximumCoveredSampleGapMs', 'preImportBracketGapMs', 'postImportBracketGapMs',
            'stableFullyReadImportSampleCount', 'maxSampledPssKiB', 'maxSampledPrivateKiB')}
            for m in memory]
        terminals = [json.loads(m.group(1)) for line in log.splitlines() if (m := ARCHIVE.search(line))]
        require(len(terminals) == 1, name + ': expected one lossless archive completion')
        archive = terminals[0]
        require(archive['complete'] is True and archive['acquisitionOrObservationsChanged'] is False, name + ': incomplete archive')
        cells[name] = {
            'jobId': job_id, 'jobUrl': f'https://github.com/ManabiIO/manabitan/actions/runs/{expected["runId"]}/job/{job_id}',
            'primaryLog': identity(log_path), 'primaryRecords': identity(records_path),
            'primaryAudit': identity(audit_path), 'records': len(records), 'observations': len(observations),
            'observationKinds': dict(roles), 'allPrimaryChecksPass': audit['allChecksPass'], 'errors': audit['errors'],
            'candidateVsBaseline': candidate, 'identicalCodeControl': control,
            'identicalCodeChangePercentRange': audit['identicalCodeChangePercentRange'],
            'largestAbsoluteControlChangePercent': max(abs(100 * (r - 1)) for r in control['ratios']),
            'mechanicalTargetThresholdPass': audit['mechanicalTargetThresholdPass'],
            'mechanicalNonTargetHoldSignal': audit['mechanicalNonTargetHoldSignal'],
            'storageBytes': audit['storageBytes'], 'lookupSemanticSha256': audit['lookupSemanticSha256'],
            'memoryPass': audit['recomputedMemoryPass'], 'memoryMetrics': audit['recomputedMemoryMetrics'],
            'memoryObservationCount': len(memory), 'qualifiedMemoryObservationCount': qualified,
            'memoryCoverage': coverage, 'rawScanCount': audit['memoryAudit']['rawScanCount'],
            'losslessArchive': archive,
        }
        totals.update(primaryRecords=len(records), reports=len(observations),
                      candidatePairs=candidate['count'], identicalCodePairs=control['count'],
                      memoryObservations=len(memory), qualifiedMemoryObservations=qualified,
                      rawScans=audit['memoryAudit']['rawScanCount'])
    require(all(len(v) == 1 for v in source_entry_maps.values()), 'Cross-host same-arm package entry maps differ')
    require(all(len(v) == 1 for v in semantics.values()), 'Cross-host same-corpus persisted semantic digests differ')
    complete_plan = dict(totals)
    complete_plan_pass = all(complete_plan[k] == v for k, v in {
        'primaryRecords': 330, 'reports': 252, 'candidatePairs': 72,
        'identicalCodePairs': 24, 'memoryObservations': 24}.items())
    target = [cells['vndb-' + order] for order in ('AB', 'BA')]
    non_target_hold = {dictionary: all(cells[dictionary + '-' + order]['mechanicalNonTargetHoldSignal']
                                     for order in ('AB', 'BA')) for dictionary in ('jmdict', 'jitendex')}
    result = {
        'schemaVersion': 1, 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Terminal primary-log reconciliation of the separately frozen current-dcfc full-import cohort; no new observations.',
        'runId': expected['runId'], 'baseline': expected['baseline'], 'candidate': expected['candidate'],
        'workflowCommit': expected['workflowCommit'], 'workflowSha256': expected['workflowSha256'],
        'criteriaSha256': expected['criteriaSha256'], 'auditor': identity(auditor_path),
        'expected': identity(expected_path), 'assembler': identity(pathlib.Path(__file__).resolve()),
        'correctnessBindingAudit': identity(ROOT / 'validation/independent-primary-audit.json'),
        'cells': cells, 'totals': complete_plan, 'completeRegisteredPlanPresent': complete_plan_pass,
        'sameArmPackageEntryMapsAcrossSixJobs': {k: sorted(v) for k, v in source_entry_maps.items()},
        'sameCorpusPersistedSemanticsAcrossBothJobs': {k: sorted(v) for k, v in semantics.items()},
        'allPrimaryChecksPass': all(c['allPrimaryChecksPass'] for c in cells.values()),
        'allMemoryGatesPass': all(c['memoryPass'] for c in cells.values()),
        'bothTargetMechanicalThresholdsPass': all(c['mechanicalTargetThresholdPass'] for c in target),
        'replicatedNonTargetMechanicalHoldSignals': non_target_hold,
        'decisionScope': 'No automatic promotion. Root must review per-host effects against controls, every correctness/storage/package/memory gate, the separate original raw archive audit, and non-target uncertainty under the frozen criteria. Failed target thresholds cannot be rescued by pooling hosts or older-baseline evidence.',
        'limits': ['No host pooling, control subtraction, outlier removal, retry, or source/threshold changes.',
                   'Distinct Actions jobs establish separate provisioning, not independently verified physical hardware.',
                   'Memory is sampled whole-process-tree PSS/private usage, not an exact peak.',
                   'Inconclusive non-target timings are not equivalence or proof of no regression.',
                   'Exact source-tree reuse binds earlier correctness; it does not claim the old CI ran at the published product commit.'],
        'originalObservationsChanged': False,
    }
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': identity(output), 'totals': complete_plan,
                      'bothTargetMechanicalThresholdsPass': result['bothTargetMechanicalThresholdsPass'],
                      'allPrimaryChecksPass': result['allPrimaryChecksPass'],
                      'allMemoryGatesPass': result['allMemoryGatesPass']}))


if __name__ == '__main__':
    main()
