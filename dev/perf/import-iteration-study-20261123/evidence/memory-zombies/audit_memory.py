"""Independently audit the fixed confirmed-zombie campaign, without sampling."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

RUN = 45116158450
HEAD = '00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9'
BASELINE = '1e235059a4c05c2509e8757fccba43a2d60222df'
CANDIDATE = '51f095912b11ddd158ac173698eb322e2be99d12'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def identity(path, root):
    data = path.read_bytes()
    return {'path': path.relative_to(root).as_posix(), 'bytes': len(data), 'sha256': digest(data)}


def signature(tree):
    return [[p[key] for key in ['pid', 'startTimeTicks', 'parentPid', 'executable', 'comm', 'argv', 'role']]
            for p in tree['processes']]


def confirmed_zombie(before, after):
    if after is None or before.get('smapsReadError', {}).get('errno') != 3:
        return False
    if any(type(before.get(key)) is not int or type(after.get(key)) is not int or before[key] != after[key]
           for key in ['pid', 'startTimeTicks']):
        return False
    for process in [before, after]:
        if process.get('state') != 'Z' or type(process.get('threadCount')) is not int or process['threadCount'] != 1:
            return False
        if process.get('executable', 'unknown') is not None:
            return False
        if not any(value.get('field') == 'executable' and value.get('errno') == 2 for value in process.get('metadataReadErrors', [])):
            return False
    return True


def preview_count(probe):
    previews = [row['rawContentPreview'] for row in probe['rowSample']]
    require(all(value is None or isinstance(value, str) for value in previews), 'Invalid raw preview type')
    return sum(isinstance(value, str) and len(value) > 0 and value not in ('<read-null>', '<read-failed>') for value in previews)


def differences(a, b, location=''):
    if type(a) is not type(b):
        return [{'path': location, 'baseline': a, 'candidate': b}]
    if isinstance(a, dict):
        require(a.keys() == b.keys(), 'Different physical shape')
        return [item for key in a for item in differences(a[key], b[key], location + '/' + key)]
    if isinstance(a, list):
        require(len(a) == len(b), 'Different physical array length')
        return [item for i, (x, y) in enumerate(zip(a, b)) for item in differences(x, y, location + '/' + str(i))]
    return [] if a == b else [{'path': location, 'baseline': a, 'candidate': b}]


def audit(root, node):
    expected_trees = {'harness': (HEAD, '4d03a978213da80b70dd80bf07ad2c479712346b'),
                      'baseline': (BASELINE, 'fadeef3883aab50ce5ecaa753d824982f6e52760'),
                      'candidate': (CANDIDATE, '00d52a720a494dfcdd85262f658fedc3d7c5f3fb')}
    for role, (commit, tree) in expected_trees.items():
        git_commit = read(root / 'api' / (role + '-commit.json'))
        require(git_commit['sha'] == commit and git_commit['tree']['sha'] == tree, 'Wrong immutable source tree')
    run_api = read(root / 'api/run-final.json')
    require(run_api['id'] == RUN and run_api['head_sha'] == HEAD and run_api['status'] == 'completed', 'Wrong final workflow identity')
    source = read(root / 'source-manifest.json')
    git_checks = read(root / 'source-git-verification.json')
    source_hashes = {}
    for row in source['files']:
        actual = identity(root / row['path'], root)
        require(all(actual[key] == row[key] for key in ['path', 'bytes', 'sha256']), 'Source snapshot differs')
        git_row = next(value for value in git_checks['files'] if value['path'] == row['path'])
        require(all(git_row[key] == row[key] for key in ['path', 'bytes', 'sha256']), 'Immutable source check differs')
        role = row['path'].split('/')[1]
        require(git_row['commit'] == {'harness': HEAD, 'baseline': BASELINE, 'candidate': CANDIDATE}[role], 'Wrong measured source commit')
        source_hashes[row['path']] = row['sha256']
    api_artifacts = read(root / 'api/artifacts-final.json')['artifacts']
    api_jobs = read(root / 'api/jobs-final.json')['jobs']
    require(len(api_artifacts) == len(api_jobs) == 6, 'Incomplete matrix metadata')
    fixtures = read(root / 'source/harness/test/perf/dictionaries.lock.json')['dictionaries']
    result = {'schemaVersion': 1, 'runId': RUN, 'harness': HEAD, 'baseline': BASELINE, 'candidate': CANDIDATE,
              'authoritativeTiming': False, 'qualifiedWholeCampaign': False, 'memoryNonRegressionEstablished': False,
              'status': 'fixed-confirmed-zombie-rule-independently-recomputed', 'observerRule': 'stable-single-thread-zombie-esrch-v1', 'cells': []}
    totals = Counter()
    stable_unreadable_records = []
    confirmed_zombie_records = []
    package_maps = {}
    global_physical = {}
    for corpus in ['jmdict', 'jitendex', 'vndb']:
        fixture = fixtures[corpus]
        for replication in [1, 2]:
            cell_root = root / 'artifacts' / f'{corpus}-{replication}'
            evidence = cell_root / corpus / str(replication)
            collection = read(cell_root / 'artifact-manifest.json')
            advertised = next(value for value in api_artifacts if value['id'] == collection['artifact']['id'])
            require(collection['artifact'] == advertised, 'Artifact API identity differs')
            require(advertised['name'] == f'import-memory-zombies-20261123-{corpus}-{replication}', 'Wrong artifact matrix cell')
            workflow = advertised['workflow_run']
            require(workflow['id'] == RUN and workflow['head_sha'] == HEAD and workflow['repository_id'] == workflow['head_repository_id'] == 1165902460, 'Wrong artifact source workflow')
            require(collection['verifiedZipSha256'] == advertised['digest'].removeprefix('sha256:') and collection['verifiedZipBytes'] == advertised['size_in_bytes'], 'ZIP provenance differs')
            require(collection['safeExtraction'] is True and collection['memberCount'] == len(collection['members']), 'Collection inventory differs')
            for member in collection['members']:
                actual = identity(cell_root / member['path'], cell_root)
                require(actual == member, 'Raw member bytes differ')
            listed = {value['path'] for value in collection['members']}
            actual = {path.relative_to(cell_root).as_posix() for path in cell_root.rglob('*') if path.is_file() and path.name not in ['artifact.zip', 'artifact-manifest.json']}
            require(actual == listed, 'Unlisted or missing original member')
            archive = cell_root / 'artifact.zip'
            if archive.exists():
                data = archive.read_bytes()
                require(len(data) == advertised['size_in_bytes'] and digest(data) == collection['verifiedZipSha256'], 'Original ZIP differs')
                with zipfile.ZipFile(archive) as zipped:
                    rebuilt = [{'path': entry.filename, 'bytes': entry.file_size, 'sha256': digest(zipped.read(entry))}
                               for entry in zipped.infolist() if not entry.is_dir()]
                require(rebuilt == collection['members'], 'ZIP inventory differs')
            plan = read(evidence / 'plan.json')
            schedule = list('ABBA' if replication == 1 else 'BAAB')
            require(plan['baseline'] == BASELINE and plan['candidate'] == CANDIDATE and plan['harnessCommit'] == HEAD, 'Wrong plan source')
            require(plan['dictionary'] == corpus and plan['replication'] == replication and plan['schedule'] == schedule and plan['authoritativeTiming'] is False, 'Wrong plan scope/schedule')
            require(plan['observerRule'] == result['observerRule'], 'Wrong frozen observer rule')
            require(plan['fixture'] == fixture and plan['node'] == 'v22.22.0', 'Wrong fixture/runtime')
            for name, value in plan['overlaidHarnessFiles'].items():
                require(source_hashes['source/harness/' + name] == value, 'Harness overlay differs')
            for name, value in plan['studySourceHashes'].items():
                require(source_hashes['source/harness/dev/perf/import-memory-zombies-study-20261123/' + name] == value, 'Sampler source differs')
            identities = {arm: read(evidence / f'{arm}-identity.json') for arm in 'AB'}
            packages = {arm: read(evidence / f'{arm}-package-entries.json') for arm in 'AB'}
            package_differences = sorted(name for name in set(packages['A']) | set(packages['B']) if packages['A'].get(name) != packages['B'].get(name))
            require(package_differences == sorted(plan['expectedPackageDifferences']) == read(evidence / 'package-differences.json'), 'Unexpected packaged runtime difference')
            for arm in 'AB':
                if arm in package_maps:
                    require(package_maps[arm] == packages[arm], 'Packaged bytes changed across cells')
                package_maps[arm] = packages[arm]
                for name in package_differences:
                    require(packages[arm][name] == source_hashes['source/' + ('baseline' if arm == 'A' else 'candidate') + '/ext/' + name], 'Packaged runtime differs from measured source')
            observations = read(evidence / 'observations.json')
            require(len(observations) == 4, 'Incomplete fixed observation set')
            cell = {'dictionary': corpus, 'replication': replication, 'artifactId': advertised['id'],
                    'artifactZipSha256': collection['verifiedZipSha256'], 'artifactZipBytes': collection['verifiedZipBytes'],
                    'observations': [], 'packageDifferences': package_differences}
            for index, observation in enumerate(observations):
                arm = schedule[index]
                directory = evidence / f'memory-{index:02d}-{arm}'
                require(observation['index'] == index and observation['arm'] == arm and observation['authoritativeTiming'] is False, 'Observation schedule/mode differs')
                require(observation == read(directory / 'observation.json'), 'Original observation differs from aggregate')
                require(observation['failure'] is None, 'Unexpected public-readback failure')
                require(observation['sourceCommit'] == (BASELINE if arm == 'A' else CANDIDATE), 'Observation source differs')
                for name, value in observation['receiptHashes'].items():
                    require(digest((directory / name).read_bytes()) == value, 'Per-observation receipt hash differs')
                raw = read(directory / 'chromium-memory.json')
                require(raw['schemaVersion'] == 2 and raw['observerRule'] == result['observerRule'] and raw['authoritativeTiming'] is False, 'Wrong raw observer rule')
                require({key: value for key, value in raw.items() if key != 'samples'} == observation['memory'], 'Memory summary differs from raw receipt')
                identity_record = read(directory / 'identity.json')
                require(identity_record['index'] == index and identity_record['arm'] == arm and identity_record['authoritativeTiming'] is False, 'Observation identity differs')
                require(identity_record['sourceCommit'] == observation['sourceCommit'] and identity_record['fixtureSha256'] == fixture['sha256'], 'Observation source/fixture guard differs')
                require(identity_record['planSha256'] == digest((evidence / 'plan.json').read_bytes()), 'Plan hash differs')
                require(identity_record['overlaidHarnessFiles'] == plan['overlaidHarnessFiles'], 'Identity overlay differs')
                summary = read(directory / 'summary.json')
                report = read(directory / 'run-1.json')
                require(len(summary['runs']) == 1 and summary['gitSha'] == summary['source']['gitSha'] == observation['sourceCommit'], 'Wrong raw summary source')
                run = summary['runs'][0]
                package_hash = identities[arm]['packageSha256']
                require(run['packageSha256'] == report['packageSha256'] == observation['packageSha256'] == identity_record['packageSha256'] == package_hash, 'Wrong package identity')
                require(summary['source']['sha256']['builds/manabitan-chrome.zip'] == package_hash, 'Wrong source package hash')
                for name, value in plan['overlaidHarnessFiles'].items():
                    require(summary['source']['sha256'][name] == value, 'Raw harness source hash differs')
                require(run['validation'] == observation['validation'] == report['benchmark']['validation'], 'Raw semantic validation differs')
                require(summary['browserVersion'] == report['browserVersion'] == run['browserVersion'], 'Browser identity differs')
                require(report['status'] == 'success' and report['skippedVerification'] is False, 'Browser readback failed')
                for state in report['benchmark']['readbackDiagnostics'].values():
                    for outer in state['physicalProbes']:
                        for probe in outer['probes']:
                            require(probe['rowSampleCount'] == len(probe['rowSample']) and probe['readablePreviewRowCount'] == preview_count(probe), 'Derived physical counter differs')
                            totals['checkedPhysicalCounters'] += 1
                key = (corpus, arm)
                physical = observation['validation']['physicalProbes']
                if key in global_physical:
                    require(global_physical[key] == physical, 'Physical layout changed within package')
                global_physical[key] = physical
                samples = raw['samples']
                covered = []
                stable_unavailable = []
                denied = []
                incomplete_identity = False
                for sample_index, sample in enumerate(samples):
                    before, after = sample['discoveryBefore'], sample['discoveryAfter']
                    stable = signature(before) == signature(after)
                    require(sample['stableObservedProcessTree'] == stable, 'Original process stability differs')
                    values, unavailable = sample['processes'], sample['unavailableProcesses']
                    after_by_pid = {value['pid']: value for value in after['processes']}
                    zombies = [{**value, 'confirmationAfter': after_by_pid[value['pid']],
                                'exclusionReason': 'same-identity-single-thread-Z-to-Z-exe-ENOENT-smaps-ESRCH'}
                               for value in unavailable if confirmed_zombie(value, after_by_pid.get(value['pid']))]
                    require(sample['confirmedExitedZombies'] == zombies, 'Confirmed zombie exception differs from frozen rule')
                    excluded = {value['pid'] for value in zombies}
                    unreadable = [value for value in unavailable if value['pid'] not in excluded]
                    require(sample['unreadableAddressSpaces'] == unreadable, 'Unqualified address-space partition differs')
                    for value in zombies:
                        confirmed_zombie_records.append({'dictionary': corpus, 'replication': replication, 'observation': index, 'arm': arm,
                            'sample': sample_index, 'process': value})
                    before_by_pid = {value['pid']: value for value in before['processes']}
                    require(set(before_by_pid) == {value['pid'] for value in values + unavailable} and len(before_by_pid) == len(values) + len(unavailable), 'Discovered process partition differs')
                    for process in values + unavailable:
                        require(all(process[key] == value for key, value in before_by_pid[process['pid']].items()), 'Read process identity differs from discovery')
                    roles = sorted({value['role'] for value in values})
                    require(roles == sample['observedRoles'], 'Observed roles differ')
                    persistent = [item for item in before['inventoryIdentityReadErrors'] + after['inventoryIdentityReadErrors'] if item['errno'] not in (2, 3)]
                    failures = []
                    if not before['browserSeedPids']: failures.append('no-browser-seed')
                    if len(values) < 2: failures.append('no-multiple-process-coverage')
                    if 'browser' not in roles: failures.append('no-readable-browser-process')
                    if 'renderer' not in roles: failures.append('no-readable-renderer-process')
                    if not stable: failures.append('process-tree-changed-during-scan')
                    if unreadable: failures.append('unreadable-discovered-process-smaps')
                    if persistent: failures.append('incomplete-process-identity-inventory')
                    require(sample['qualificationFailures'] == failures and sample['qualifiedForWholeTreePss'] == (not failures), 'Original sample qualification differs')
                    pss = sum(value['pssKiB'] for value in values)
                    private = sum(value['privateKiB'] for value in values)
                    require(pss == sample['readableProcessPssKiB'] and private == sample['readableProcessPrivateKiB'], 'Readable process sums differ')
                    if not failures: covered.append(sample)
                    if stable and unreadable:
                        stable_unavailable.append(sample)
                        for process in unreadable:
                            stable_unreadable_records.append({'dictionary': corpus, 'replication': replication, 'observation': index, 'arm': arm, 'sample': sample_index,
                                'pid': process['pid'], 'state': process['state'], 'threadCount': process['threadCount'], 'executable': process['executable'], 'argv': process['argv'], 'smapsReadError': process['smapsReadError']})
                    denied.extend(value for value in unreadable if value['smapsReadError']['errno'] not in (2, 3))
                    incomplete_identity |= bool(persistent)
                failures = []
                if raw['benchmarkExitCode'] != 0: failures.append('benchmark-command-failed')
                if not covered: failures.append('no-stable-fully-read-browser-renderer-tree')
                if stable_unavailable or denied: failures.append('process-smaps-coverage-unqualified')
                if incomplete_identity: failures.append('process-identity-coverage-unqualified')
                qualified = not failures
                require(raw['qualifiedForWholeTreePss'] == qualified and raw['qualificationFailures'] == failures, 'Original observation qualification differs')
                require(raw['sampleCount'] == len(samples) and raw['stableFullyReadTreeSampleCount'] == len(covered), 'Original sample counts differ')
                require(raw['samplesWithUnavailableSmaps'] == sum(bool(value['unavailableProcesses']) for value in samples), 'Unavailable sample count differs')
                require(raw['samplesWithUnreadableAddressSpaces'] == sum(bool(value['unreadableAddressSpaces']) for value in samples), 'Unqualified address-space sample count differs')
                require(raw['confirmedExitedZombieObservationCount'] == sum(len(value['confirmedExitedZombies']) for value in samples), 'Zombie observation count differs')
                require(raw['confirmedExitedZombieIdentityCount'] == len({(p['pid'], p['startTimeTicks']) for value in samples for p in value['confirmedExitedZombies']}), 'Zombie identity count differs')
                require(raw['observedProcessCountRange'] == [min((len(value['processes']) for value in covered), default=0), max((len(value['processes']) for value in covered), default=0)], 'Process count range differs')
                for output_key, input_key in [('maxSampledPssKiB', 'readableProcessPssKiB'), ('maxSampledPrivateKiB', 'readableProcessPrivateKiB')]:
                    expected = max((value[input_key] for value in covered), default=None) if qualified else None
                    require(raw[output_key] == expected, 'Original qualified maximum differs')
                totals['observations'] += 1
                totals['samples'] += len(samples)
                totals['eligibleStableFullyReadSamples'] += len(covered)
                totals['unqualifiedObservations'] += not qualified
                totals['stableUnreadableSamples'] += len(stable_unavailable)
                totals['stableUnreadableProcessRecords'] += sum(len(value['unreadableAddressSpaces']) for value in stable_unavailable)
                totals['confirmedExitedZombieObservations'] += raw['confirmedExitedZombieObservationCount']
                totals['confirmedExitedZombieIdentitiesWithinObservations'] += raw['confirmedExitedZombieIdentityCount']
                cell['observations'].append({'index': index, 'arm': arm, 'sourceCommit': observation['sourceCommit'], 'packageSha256': package_hash,
                    'qualifiedForWholeTreePss': qualified, 'qualificationFailures': failures, 'samples': len(samples), 'eligibleSamples': len(covered),
                    'stableUnreadableSamples': len(stable_unavailable), 'memoryReceipt': identity(directory / 'chromium-memory.json', root),
                    'confirmedExitedZombieObservations': raw['confirmedExitedZombieObservationCount'],
                    'maxSampledPssKiB': raw['maxSampledPssKiB'], 'maxSampledPrivateKiB': raw['maxSampledPrivateKiB']})
            changes = differences(global_physical[(corpus, 'A')], global_physical[(corpus, 'B')])
            for change in changes:
                if re.fullmatch(r'/\d+/probes/\d+/rowSample/\d+/(rawEntryContentOffset|rawContentPreview)', change['path']): continue
                match = re.fullmatch(r'/(\d+)/probes/(\d+)/readablePreviewRowCount', change['path'])
                require(match is not None, 'Unexpected physical difference')
                a = global_physical[(corpus, 'A')][int(match[1])]['probes'][int(match[2])]
                b = global_physical[(corpus, 'B')][int(match[1])]['probes'][int(match[2])]
                require(any(x['rawContentPreview'] != y['rawContentPreview'] for x, y in zip(a['rowSample'], b['rowSample'])), 'Derived counter difference has unchanged inputs')
            comparison = read(evidence / 'memory-comparison.json')
            expected_failures = [f'observation-{row["index"]}-unqualified' for row in cell['observations'] if not row['qualifiedForWholeTreePss']]
            require(comparison['authoritativeTiming'] is False and comparison['schedule'] == schedule and comparison['qualificationFailures'] == expected_failures, 'Original comparison status differs')
            require(comparison['qualifiedMemoryMeasurement'] == (not expected_failures), 'Original job qualification differs')
            pairs = []
            if not expected_failures:
                for start in [0, 2]:
                    arms = {value['arm']: value for value in cell['observations'][start:start + 2]}
                    metrics = {}
                    for key in ['maxSampledPssKiB', 'maxSampledPrivateKiB']:
                        a, b = arms['A'][key], arms['B'][key]
                        metrics[key] = {'baseline': a, 'candidate': b, 'changePercent': 100 * (b / a - 1) if a else None}
                    pairs.append({'indices': [start, start + 1], 'metrics': metrics})
            require(comparison['pairs'] == pairs, 'Original memory pair arithmetic differs')
            job = next(value for value in api_jobs if value['name'] == f'memory ({corpus}, {replication})')
            require(job['status'] == 'completed' and job['head_sha'] == HEAD and job['run_id'] == RUN, 'Wrong workflow job identity')
            require(job['conclusion'] == ('failure' if expected_failures else 'success'), 'Job outcome differs from original guards')
            cell.update({'jobId': job['id'], 'jobConclusion': job['conclusion'], 'qualifiedMemoryMeasurement': not expected_failures, 'qualificationFailures': expected_failures, 'pairs': pairs,
                         'physicalDifferenceCount': len(changes)})
            result['cells'].append(cell)
    require(totals['observations'] == 24, 'Incomplete fixed campaign')
    result['qualifiedWholeCampaign'] = all(cell['qualifiedMemoryMeasurement'] for cell in result['cells'])
    require(run_api['conclusion'] == ('success' if result['qualifiedWholeCampaign'] else 'failure'), 'Final workflow qualification differs')
    semantic = subprocess.run([node, str(root / 'verify_semantics.mjs'), str(root)], check=True, capture_output=True, text=True, timeout=120)
    semantic_audit = json.loads(semantic.stdout)
    require(semantic_audit == read(root / 'semantic-audit.json') and semantic_audit['passed'] is True and semantic_audit['reportCount'] == 24, 'Full public/restart audit differs')
    result['totals'] = dict(totals)
    result['stableUnreadableProcessRecords'] = stable_unreadable_records
    result['confirmedExitedZombieRecords'] = confirmed_zombie_records
    result['semanticAudit'] = identity(root / 'semantic-audit.json', root)
    result['sourceGitVerification'] = identity(root / 'source-git-verification.json', root)
    result['limitation'] = 'This independently reproduces the separately frozen stable-single-thread-zombie-esrch-v1 rules. Every failed read and exclusion remains preserved; multithreaded or unknown zombies remain unqualified. No sample, observation, pair, or job is removed or replaced. No elapsed time is authoritative. Non-atomic sampling can miss short-lived or already-reparented processes and does not establish a complete peak.'
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--node', default='node')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    value = audit(args.root.resolve(), args.node)
    encoded = json.dumps(value, indent=2) + '\n'
    if args.output:
        with args.output.open('x') as stream:
            stream.write(encoded)
        print(json.dumps({'output': str(args.output), 'totals': value['totals'], 'qualifiedWholeCampaign': value['qualifiedWholeCampaign']}, indent=2))
    else:
        print(encoded, end='')
