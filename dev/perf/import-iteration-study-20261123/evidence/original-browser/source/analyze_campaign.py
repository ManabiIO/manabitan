"""Recompute every fixed pair and audit the original 45110694360 artifacts."""

from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import zipfile

ROOT = Path(__file__).resolve().parent
HARNESS = '088d9c22ccd2b0dc05b240355c76320c9660ce3e'
OVERLAY = {
    'test/perf/dictionaries.lock.json',
    'dev/perf/dictionary-fixtures.js',
    'dev/perf/benchmark-support.js',
    'dev/perf/import-benchmark.js',
    'test/chromium/extension-two-dictionary-import.e2e.js',
}


def load(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def schedule_for(replication):
    schedule = [('warmup', 0, arm) for arm in ('AB' if replication == 1 else 'BA')]
    for pair in range(2):
        schedule += [('control-before', pair, 'A'), ('control-before', pair, 'A')]
    for pair in range(8):
        schedule += [('candidate', pair, arm) for arm in ('AB' if (pair + replication) % 2 == 1 else 'BA')]
    for pair in range(2):
        schedule += [('control-after', pair, 'A'), ('control-after', pair, 'A')]
    return schedule


def pair_summary(pairs):
    if not pairs:
        return None
    changes = [p['changePercent'] for p in pairs]
    return {
        'pairs': pairs,
        'pairCount': len(pairs),
        'medianChangePercent': statistics.median(changes),
        'medianDeltaMs': statistics.median(p['comparisonMs'] - p['baselineMs'] for p in pairs),
        'baselineMedianMs': statistics.median(p['baselineMs'] for p in pairs),
        'comparisonMedianMs': statistics.median(p['comparisonMs'] for p in pairs),
        'minChangePercent': min(changes),
        'maxChangePercent': max(changes),
        'fasterPairs': sum(p['comparisonMs'] < p['baselineMs'] for p in pairs),
    }


def calculate_pairs(observations, kind):
    groups = defaultdict(list)
    for row in observations:
        if row['kind'] == kind:
            groups[row['pair']].append(row)
    pairs = []
    for number, rows in sorted(groups.items()):
        if len(rows) != 2:
            continue
        if kind == 'candidate':
            arms = {row['arm']: row for row in rows}
            if set(arms) != {'A', 'B'}:
                continue
            first, second = arms['A'], arms['B']
        else:
            first, second = rows
        a, b = first['totalImportMs'], second['totalImportMs']
        if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in (a, b)):
            continue
        pairs.append({
            'pair': number, 'order': ''.join(row['arm'] for row in rows),
            'observationIndexes': [row['index'] for row in rows],
            'baselineMs': a, 'comparisonMs': b, 'changePercent': 100 * (b / a - 1),
        })
    return pair_summary(pairs)


def analyze_artifact(directory, job, references):
    candidate, dictionary, replication_text = directory.name.rsplit('-', 2)
    replication = int(replication_text)
    evidence = directory / candidate / dictionary / replication_text
    manifest = load(directory / 'artifact-manifest.json')
    failures = Counter()

    def check(condition, description):
        if not condition:
            failures[description] += 1

    check(manifest is not None, 'Missing verified archive manifest')
    if manifest is None:
        return {'candidate': candidate, 'dictionary': dictionary, 'replication': replication, 'guardFailures': dict(failures)}
    artifact = manifest['artifact']
    api_artifact = references['apiArtifacts'].get(artifact['id'])
    check(api_artifact is not None and all(artifact.get(key) == api_artifact.get(key) for key in ['id', 'name', 'digest', 'size_in_bytes', 'workflow_run']), 'Artifact manifest differs from final API metadata')
    check(artifact.get('name') == 'import-iteration-20261123-' + directory.name, 'Artifact name differs from matrix cell')
    workflow = artifact.get('workflow_run', {})
    check(workflow.get('id') == 45110694360 and workflow.get('head_sha') == HARNESS and workflow.get('repository_id') == 1165902460 and workflow.get('head_repository_id') == 1165902460, 'Artifact workflow/repository/head identity mismatch')
    check(digest(directory / 'artifact.zip') == manifest['verifiedZipSha256'] == manifest['artifact']['digest'].removeprefix('sha256:'), 'Archive digest guard failed')
    check((directory / 'artifact.zip').stat().st_size == manifest['verifiedZipBytes'] == manifest['artifact']['size_in_bytes'], 'Archive size guard failed')
    rebuilt_inventory = []
    with zipfile.ZipFile(directory / 'artifact.zip') as archive:
        canonical_names = [Path(entry.filename).as_posix() for entry in archive.infolist()]
        check(len(canonical_names) == len(set(canonical_names)), 'ZIP member aliases collide')
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            data = archive.read(entry)
            rebuilt_inventory.append({'path': entry.filename, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    check(rebuilt_inventory == manifest['members'], 'Rebuilt ZIP inventory differs from manifest')
    listed_paths = {member['path'] for member in manifest['members']}
    extracted_paths = {str(path.relative_to(directory)) for path in evidence.rglob('*') if path.is_file()}
    check(extracted_paths == listed_paths, 'Extracted evidence has missing or unlisted raw files')
    for member in manifest['members']:
        path = directory / member['path']
        check(path.exists() and path.stat().st_size == member['bytes'] and digest(path) == member['sha256'], 'Extracted artifact member hash guard failed')

    plan = load(evidence / 'plan.json', {})
    specification = references['candidates'][candidate]
    expected_schedule = schedule_for(replication)
    check(plan.get('harness') == HARNESS, 'Wrong campaign harness commit')
    check(plan.get('candidateName') == candidate and plan.get('dictionary') == dictionary and plan.get('replication') == replication, 'Wrong plan matrix identity')
    check(plan.get('specification') == specification, 'Wrong frozen candidate specification')
    check(plan.get('baseline') == specification['baseline'] and plan.get('candidate') == specification['candidate'], 'Wrong baseline/candidate SHA')
    check(plan.get('schedule') == [list(item) for item in expected_schedule], 'Plan differs from fixed counterbalanced schedule')
    check(plan.get('node') == 'v22.22.0', 'Unexpected pinned Node version')
    check(plan.get('overlaidHarnessFiles') == {name: references['hashes'][name] for name in OVERLAY}, 'Harness overlay hashes differ from frozen source')
    expected_shas = {'A': specification['baseline'], 'B': specification['candidate']}
    identities = {arm: load(evidence / f'{arm}-identity.json', {}) for arm in 'AB'}
    packages = {arm: load(evidence / f'{arm}-package-entries.json', {}) for arm in 'AB'}
    for arm in 'AB':
        identity = identities[arm]
        check(identity.get('sha') == expected_shas[arm], 'Package source SHA differs from plan')
        changed_paths = {line.split(maxsplit=1)[1] for line in identity.get('statusWithHarnessOverlay', '').splitlines() if len(line.split(maxsplit=1)) == 2}
        check(changed_paths <= OVERLAY | {'node_modules'}, 'Unexpected worktree changes beyond harness overlay')
        check(bool(packages[arm]), 'Missing package member hashes')
    package_differences = sorted(name for name in set(packages['A']) | set(packages['B']) if packages['A'].get(name) != packages['B'].get(name))
    check(package_differences == sorted(specification['expectedPackageDifferences']), 'Packaged differences exceed frozen candidate scope')
    check(load(evidence / 'package-differences.json') == package_differences, 'Recorded package differences do not match member hashes')

    observations = load(evidence / 'observations.json', [])
    check(len(observations) == len(expected_schedule), 'Incomplete 26-observation schedule')
    fixture = references['fixtures'][dictionary]
    validations = []
    source_signatures = defaultdict(set)
    browser_versions = set()
    for index, observation in enumerate(observations):
        check(index < len(expected_schedule), 'Extra observation outside schedule')
        if index >= len(expected_schedule):
            break
        kind, pair, arm = expected_schedule[index]
        check((observation.get('index'), observation.get('kind'), observation.get('pair'), observation.get('arm')) == (index, kind, pair, arm), 'Observation order differs from fixed schedule')
        output = evidence / f'{index:02d}-{kind}-{pair}-{arm}'
        summary = load(output / 'summary.json', {})
        report = load(output / 'run-1.json', {})
        results = summary.get('runs', [])
        check(len(results) == 1, 'Missing or multiple raw run summaries')
        if len(results) != 1:
            continue
        result = results[0]
        browser_versions.add(report.get('browserVersion'))
        check(report.get('browserVersion') == summary.get('browserVersion') == result.get('browserVersion') and isinstance(report.get('browserVersion'), str), 'Browser version differs between report/summary/result')
        expected_package = identities[arm].get('packageSha256')
        check(summary.get('gitSha') == summary.get('source', {}).get('gitSha') == expected_shas[arm], 'Raw source SHA guard failed')
        check(observation.get('packageSha256') == result.get('packageSha256') == report.get('packageSha256') == expected_package, 'Raw package SHA guard failed')
        source_hashes = summary.get('source', {}).get('sha256', {})
        check(source_hashes.get('builds/manabitan-chrome.zip') == expected_package, 'Source package hash differs from run package')
        check(all(source_hashes.get(name) == value for name, value in references['hashes'].items()), 'Raw harness/dependency/source hashes differ from frozen reference')
        source_signatures[arm].add(json.dumps(source_hashes, sort_keys=True))
        check(summary.get('authoritativeTiming') is True and summary.get('traceEnabled') is False and summary.get('importFlags') is None, 'Timing summary is instrumented or nonproduction')
        benchmark = report.get('benchmark', {})
        check(benchmark.get('dictionary') == dictionary and benchmark.get('authoritativeTiming') is True and benchmark.get('pinnedDictionaries') is True and benchmark.get('productionImportDefaults') is True, 'Raw benchmark mode guard failed')
        check(all(benchmark.get(key) is False for key in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling']) and benchmark.get('importFlags') is None, 'Timing observation has diagnostic instrumentation')
        check(report.get('status') == 'success' and report.get('skippedVerification') is False, 'Raw browser test failed or skipped verification')
        check(summary.get('buildTarget') == report.get('buildTarget') == 'chrome', 'Unexpected browser build target')
        check(summary.get('dictionary') == dictionary, 'Summary dictionary mismatch')
        observed_fixture = summary.get('fixture', {})
        check(all(observed_fixture.get(key) == fixture[key] for key in ['cacheFile', 'release', 'url', 'sha256', 'sizeBytes', 'expectedTitle', 'revision', 'termRows']), 'Pinned fixture identity mismatch')
        check(observation.get('totalImportMs') == result.get('totalImportMs'), 'Observation total differs from raw summary')
        timing_phases = [phase['data']['browserTiming'] for phase in report.get('phases', []) if isinstance(phase.get('data'), dict) and phase['data'].get('kind') == 'dictionary-import']
        check(len(timing_phases) == 1, 'Missing authoritative browser timing witness')
        if len(timing_phases) == 1:
            timing = timing_phases[0]
            check(timing.get('trigger') == 'file-input-change' and timing.get('errorCount') == 0, 'Browser timing trigger or error guard failed')
            check(timing['completedAtMs'] - timing['startedAtMs'] == result.get('totalImportMs'), 'Import time differs from raw browser completion boundary')
        validation = observation.get('validation', {})
        check(validation == result.get('validation') == benchmark.get('validation'), 'Observation validation differs from raw summary/report')
        restart = validation.get('restart', {})
        check(validation.get('contentReadable') is True and restart.get('contentReadable') is True, 'Content readback failed')
        check(validation.get('termRows') == restart.get('termRows') == fixture['termRows'], 'Term count or restart count mismatch')
        check(validation.get('title') == restart.get('title') == fixture['expectedTitle'] and str(validation.get('revision')) == str(restart.get('revision')) == fixture['revision'], 'Dictionary identity or restart identity mismatch')
        check(isinstance(validation.get('mediaRows'), int) and validation.get('mediaRows') == restart.get('mediaRows'), 'Media count or restart media count mismatch')
        if 'mediaRows' in fixture:
            check(validation.get('mediaRows') == fixture['mediaRows'], 'Pinned media count mismatch')
        check(validation.get('probeCount') == restart.get('probeCount') == 12 and len(validation.get('probeTerms', [])) == 12, 'Probe count mismatch')
        debug = result.get('importDebug', {})
        check(debug.get('errorCount') == 0 and debug.get('addSettingsErrorCount') == 0 and debug.get('hasResult') is True and debug.get('usesFallbackStorage') is False, 'Import debug indicates failure or fallback storage')
        validations.append({'arm': arm, **validation})
    check(all(len(values) == 1 for values in source_signatures.values()), 'Source hashes changed within an arm')
    check(len(browser_versions) == 1, 'Browser version changed across timing observations')
    digests_by_arm = {arm: sorted({v.get('outputDigestSha256') for v in validations if v['arm'] == arm}) for arm in 'AB'}
    cross_arm_digests = {value for values in digests_by_arm.values() for value in values}
    check(all(len(values) == 1 for values in digests_by_arm.values()), 'Readback digest changed within an arm or arm is absent')
    check(len(cross_arm_digests) == 1, 'Sampled readback digest differs across arms')
    check(all(isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value) for value in cross_arm_digests), 'Invalid readback digest')
    check(len({v.get('mediaRows') for v in validations}) == 1, 'Media counts changed across observations')
    check(len({json.dumps(v.get('probeTerms')) for v in validations}) == 1, 'Readback probe terms changed across observations')

    pairs = {kind: calculate_pairs(observations, kind) for kind in ['candidate', 'control-before', 'control-after']}
    controls = [p for kind in ['control-before', 'control-after'] if pairs[kind] for p in pairs[kind]['pairs']]
    pairs['controls-all'] = pair_summary(controls)
    reported_results = load(evidence / 'results.json')
    if reported_results is not None:
        for kind in ['candidate', 'control-before', 'control-after']:
            recomputed = pairs[kind]
            reported = reported_results.get(kind, {})
            check(recomputed is not None and recomputed['medianChangePercent'] == reported.get('medianChangePercent') and recomputed['fasterPairs'] == reported.get('fasterPairs'), 'Published pair aggregates differ from raw observations')
            if recomputed is not None:
                stripped = [{key: p[key] for key in ['pair', 'baselineMs', 'comparisonMs', 'changePercent']} for p in recomputed['pairs']]
                check(stripped == reported.get('pairs'), 'Published pairs differ from raw observations')
    else:
        check(False, 'Campaign did not publish qualified results.json')
    timing_guards_passed = not failures
    workflow_succeeded = job is not None and job.get('status') == 'completed' and job.get('conclusion') == 'success'
    memory_observations = load(evidence / 'memory-observations.json', [])
    memory_failures = Counter()

    def check_memory(condition, description):
        if not condition:
            memory_failures[description] += 1

    if candidate == 'owned-shared' and workflow_succeeded:
        check_memory(len(memory_observations) == 4, 'Missing fixed four-run memory diagnostic sequence')
    memory_order = 'ABBA' if replication == 1 else 'BAAB'
    for index, observation in enumerate(memory_observations):
        check_memory(index < 4 and observation.get('index') == index and observation.get('arm') == memory_order[index], 'Memory diagnostic order changed')
        arm = observation['arm']
        output = evidence / f'memory-{index:02d}-{arm}'
        raw_memory = load(output / 'chromium-memory.json', {})
        samples = raw_memory.get('samples', [])
        covered = [sample for sample in samples if sample['processes'] and not sample['unavailablePids'] and sample['stableObservedProcessSet']]
        check_memory(raw_memory.get('sampleCount') == len(samples) and raw_memory.get('stableFullyReadSampleCount') == len(covered), 'Memory sample counts do not recompute')
        check_memory(raw_memory.get('maxSampledPssKiB') == max((sample['pssKiB'] for sample in covered), default=None) and raw_memory.get('maxSampledPrivateKiB') == max((sample['privateKiB'] for sample in covered), default=None), 'Memory sampled maxima do not recompute')
        for sample in samples:
            check_memory(sample['pssKiB'] == sum(process['pssKiB'] for process in sample['processes']) and sample['privateKiB'] == sum(process['privateKiB'] for process in sample['processes']), 'Memory process sums do not recompute')
        summary = load(output / 'summary.json', {})
        report = load(output / 'run-1.json', {})
        result = summary.get('runs', [{}])[0]
        check_memory({key: value for key, value in observation.items() if key not in ['index', 'arm']} == {key: value for key, value in raw_memory.items() if key != 'samples'}, 'Memory summary differs from raw sample report')
        check_memory(observation.get('authoritativeTiming') is False and observation.get('benchmarkExitCode') == 0, 'Memory diagnostic failed or marked as timing')
        check_memory(summary.get('gitSha') == expected_shas[arm] and result.get('packageSha256') == identities[arm].get('packageSha256') == report.get('packageSha256'), 'Memory diagnostic source/package guard failed')
        check_memory(report.get('status') == 'success' and result.get('validation') == report.get('benchmark', {}).get('validation'), 'Memory diagnostic raw readback guard failed')
        check_memory(result.get('validation', {}).get('outputDigestSha256') in cross_arm_digests, 'Memory diagnostic readback digest changed')
    memory = None
    if memory_observations:
        memory = {'observations': memory_observations, 'excludedFromTiming': True, 'byArm': {}}
        for arm in 'AB':
            selected = [row for row in memory_observations if row['arm'] == arm]
            if selected:
                memory['byArm'][arm] = {
                    'runs': len(selected),
                    'medianMaxSampledPssKiB': statistics.median(row['maxSampledPssKiB'] for row in selected),
                    'medianMaxSampledPrivateKiB': statistics.median(row['maxSampledPrivateKiB'] for row in selected),
                }
        memory['wholeTreeCoverageEstablished'] = False
        memory['suitableForMemoryNonRegressionClaim'] = False
        memory['limitation'] = 'Original cmdline-basename filter can omit Chromium processes with rewritten argv[0]; nearly every sample contains only one PID. These readings do not establish whole-tree/import-worker coverage, peak memory or memory non-regression. See memory-coverage-audit.json.'
    return {
        'candidate': candidate, 'dictionary': dictionary, 'replication': replication,
        'artifactId': manifest['artifact']['id'], 'artifactSha256': manifest['verifiedZipSha256'],
        'directory': directory.name, 'source': {'baseline': specification['baseline'], 'candidate': specification['candidate'], 'harness': HARNESS},
        'workflowJob': job, 'workflowSucceeded': workflow_succeeded,
        'timingGuardsPassed': timing_guards_passed,
        'qualified': timing_guards_passed and workflow_succeeded and not memory_failures,
        'statisticsScope': 'qualified fixed-pair timing' if timing_guards_passed and workflow_succeeded and not memory_failures else 'descriptive observations only; not performance acceptance',
        'guardFailures': dict(failures), 'observations': len(observations), 'expectedObservations': 26,
        'memoryGuardFailures': dict(memory_failures),
        'packageDifferences': package_differences, 'packageSha256': {arm: identities[arm].get('packageSha256') for arm in 'AB'},
        'fixture': fixture, 'digestsByArm': digests_by_arm,
        'browserVersions': sorted(browser_versions),
        'mediaRows': sorted({v.get('mediaRows') for v in validations}),
        'pairs': pairs, 'memory': memory,
    }


def main():
    metadata = load(ROOT / 'metadata-latest.json', load(ROOT / 'metadata-initial.json'))
    references = {
        'candidates': load(ROOT / 'reference-candidates.json'),
        'fixtures': load(ROOT / 'reference-fixtures.json')['dictionaries'],
        'hashes': load(ROOT / 'reference-harness-hashes.json')['files'],
        'apiArtifacts': {item['id']: item for item in metadata['artifacts']},
    }
    jobs = {job['name']: job for job in metadata['jobs']}
    rows = []
    for candidate in references['candidates']:
        for dictionary in ['jmdict', 'jitendex', 'vndb']:
            for replication in [1, 2]:
                directory = ROOT / f'{candidate}-{dictionary}-{replication}'
                job = jobs.get(f'compare ({candidate}, {dictionary}, {replication})')
                if not (directory / 'artifact-manifest.json').exists():
                    rows.append({'candidate': candidate, 'dictionary': dictionary, 'replication': replication, 'artifactAvailable': False, 'workflowJob': job})
                    continue
                try:
                    rows.append(analyze_artifact(directory, job, references))
                except Exception as error:
                    manifest = load(directory / 'artifact-manifest.json', {})
                    rows.append({
                        'candidate': candidate, 'dictionary': dictionary, 'replication': replication,
                        'artifactId': manifest.get('artifact', {}).get('id'), 'qualified': False,
                        'workflowJob': job, 'guardFailures': {'Artifact analysis raised an exception': 1},
                        'analysisException': type(error).__name__ + ': ' + str(error),
                    })
    groups = []
    for candidate in references['candidates']:
        for dictionary in ['jmdict', 'jitendex', 'vndb']:
            selected = [row for row in rows if row['candidate'] == candidate and row['dictionary'] == dictionary]
            available = [row for row in selected if 'pairs' in row]
            all_qualified = len(available) == 2 and all(row['qualified'] for row in available)
            combined = []
            controls = []
            for row in available:
                if row['pairs']['candidate']:
                    combined += [{'replication': row['replication'], **p} for p in row['pairs']['candidate']['pairs']]
                if row['pairs']['controls-all']:
                    controls += [{'replication': row['replication'], **p} for p in row['pairs']['controls-all']['pairs']]
            groups.append({
                'candidate': candidate, 'dictionary': dictionary, 'replicationsAvailable': len(available),
                'qualified': all_qualified, 'combinedCandidatePairs': pair_summary(combined), 'combinedBaselineControlPairs': pair_summary(controls),
                'interpretation': 'Both replications passed the original campaign guards; assess paired effect against controls.' if all_qualified else 'Incomplete or failed qualification; combined numbers are descriptive only.',
            })
    job_counts = Counter(job.get('conclusion') or job['status'] for job in metadata['jobs'])
    analysis = {
        'runId': 45110694360, 'runUrl': 'https://github.com/ManabiIO/manabitan/actions/runs/45110694360',
        'harness': HARNESS, 'analyzedAt': datetime.now(timezone.utc).isoformat(),
        'metadataCapturedAt': metadata.get('capturedAt'),
        'all24JobsCompleted': len(metadata['jobs']) == 24 and all(job['status'] == 'completed' for job in metadata['jobs']),
        'jobCounts': dict(job_counts), 'artifactsAvailable': sum('artifactId' in row for row in rows),
        'qualifiedReplications': sum(row.get('qualified', False) for row in rows),
        'method': 'Per-replication eight AB/BA candidate pairs; two AA pairs before and two after; two excluded warmups. Median of paired percentage changes, negative is faster. All observations retained; no filtering. Memory diagnostics excluded from timing.',
        'readbackLimit': 'Original browser harness samples 12 terms plus restart/count checks. Its digest can encode physical content references; a failed cross-arm digest is never accepted as performance qualification here. Separate corrective semantic readback is outside this original campaign.',
        'packageHashLimit': 'Actions artifact ZIP hashes are independently recomputed. Extension ZIPs are not included in these artifacts; their recorded hashes are cross-checked against every raw observation, source identity and complete package-member hash manifests.',
        'memoryCoverageLimit': 'Original post-timing memory sampler did not establish whole-tree/import-worker coverage. Preserve its observations, but do not use them to claim memory non-regression. Authoritative import timings are independent; see memory-coverage-audit.json.',
        'rows': rows, 'groups': groups,
    }
    (ROOT / 'analysis.json').write_text(json.dumps(analysis, indent=2) + '\n')
    lines = ['# Original browser import campaign', '', analysis['runUrl'], '', analysis['method'], '', analysis['readbackLimit'], '',
             analysis['memoryCoverageLimit'], '',
             f"Jobs: {dict(job_counts)}. Verified artifacts: {analysis['artifactsAvailable']}/24. Replications passing original timing guards: {analysis['qualifiedReplications']}.", '',
             'Passing the guards establishes comparable timing evidence; it does not by itself establish a speed improvement.', '',
             '| Candidate | Dictionary | Replication | Timing guards pass | Candidate median change | Faster pairs | AA median (range) |',
             '|---|---|---:|---|---:|---:|---:|']
    for row in rows:
        if 'pairs' not in row:
            continue
        candidate = row['pairs']['candidate']
        control = row['pairs']['controls-all']
        change = f"{candidate['medianChangePercent']:+.2f}%" if candidate else 'incomplete'
        faster = f"{candidate['fasterPairs']}/{candidate['pairCount']}" if candidate else 'incomplete'
        noise = f"{control['medianChangePercent']:+.2f}% ({control['minChangePercent']:+.2f}% to {control['maxChangePercent']:+.2f}%)" if control else 'incomplete'
        lines.append(f"| {row['candidate']} | {row['dictionary']} | {row['replication']} | {'yes' if row['qualified'] else 'NO'} | {change} | {faster} | {noise} |")
    failures = [row for row in rows if row.get('guardFailures')]
    if failures:
        lines += ['', '## Qualification failures', '']
        for row in failures:
            lines.append(f"- {row['candidate']} / {row['dictionary']} / {row['replication']}: {json.dumps(row['guardFailures'], sort_keys=True)}")
    (ROOT / 'analysis.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
