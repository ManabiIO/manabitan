#!/usr/bin/env python3
"""Revalidate one complete corrected compression artifact without changing it.

This separate reader retains the original source, package, clock, schedule,
receipt, media and memory checks. It additionally binds the raw additive proof,
its labeled comparison copy, the symmetric harness and both physical families.
It cannot qualify an original failed artifact that lacks the new proof.
"""
import argparse
import hashlib
import io
import json
import pathlib
import random
import re
import statistics
import subprocess
import sys
import zipfile


BASELINE_SHA = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
PRODUCT_ORIGIN_SHA = 'f7980e638ea1808701ac28339987663fd8b3dc4e'
PREDICTION_BASELINE_SHA = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
HARNESS = 'test/chromium/extension-two-dictionary-import.e2e.js'
ORIGINAL_HARNESS_SHA256 = 'd0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf'
STUDY_DIRECTORY = 'dev/perf/import-compression-proof-20261128-1b47'
PRODUCT_BLOBS = {
    'ext/js/dictionary/zstd-term-content.js': '9a63ef28bcf862108c407c5636eb492009ba815f',
    'test/zstd-compression-worker-context.test.js': 'c9b3006765f6ed3b51ba39622d5a370f46409bc0',
    'test/zstd-term-content-startup-overlap.test.js': '301c4ba0d8a0d1d1842479868ef44ffb878d9d49',
}
SOURCE_CONTEXT = {
    'commonBaselineSha': BASELINE_SHA,
    'compressionProductOriginSha': PRODUCT_ORIGIN_SHA,
    'historicalStoragePredictionBaselineSha': PREDICTION_BASELINE_SHA,
    'historicalPredictionRole': 'Original 9e10 byte predictions remain fixed fail-closed predicates; no recalibration for the current common baseline',
    'productDeltaPaths': sorted(PRODUCT_BLOBS),
    'supersededPreparation': 'The unacquired 9e10 corrected preparation was preserved before choosing this current common baseline; no old observation or warmup is reused',
}
DISPOSITION_POLICY = {
    'scope': 'One bounded correction; no further optimization variants, replacement cohorts, old-warmup reuse or pooling',
    'activeCorpora': ['jmdict', 'jitendex'],
    'requiredBeforeAnyProvisionalDraft': 'Both active-corpus semantic, exact-storage and memory gates qualify; at least one has candidate paired median and equal-work changes below zero, descriptive upper bound below zero, and both changes more favorable than the corresponding identical-code controls',
    'otherCorpus': 'Reject a compression PR if its descriptive lower bound is above zero, or if at least five of six pairs are slower and both paired median and equal-work changes are above zero; otherwise retain all ambiguity',
    'reviewRuleScope': 'Review triage, not statistical significance, merge readiness or a latency non-regression claim from semantic/memory success',
    'noControlSubtraction': True,
    'oldComponentReplayAloneJustifiesPr': False,
    'noQualifyingCorpus': 'Close the compression mechanism without a product PR',
    'oneHostLimitation': 'Even a qualifying result permits only a provisional draft review, not merge-ready evidence',
    'decisionOwner': 'Parent review of both complete fixed cohorts; no automatic publication',
}
ORIGINAL_TOOLING_HASHES = {
    'dev/perf/import-qualification-20261125-a7f7.py': 'cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef',
    'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py': '4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51',
}
PREVIOUS_TOOLING_HASHES = {
    'dev/perf/import-compression-level-20261128-1b47.py': '7fe216453d56094cb94a2504915efcbc64e08b5a3c99be25ca206b435b094d98',
    'dev/perf/import-compression-level-20261128-1b47/compression_receipts.py': '7512dd8f4422fc01fe094eb49dcccc4a3f8a80cb9dbf8fc2e37b8b00e1f68bb8',
    'dev/perf/import-compression-level-20261128-1b47/test_compression_receipts.py': 'ffc48b76a565eccb100fc0fa1a9f7d5f355b087bc6c6199ad2a58639ca47789d',
}
STUDY_FILES = (
    'dev/perf/import-compression-proof-20261128-1b47.py',
    STUDY_DIRECTORY + '/compression_proof_receipts.py',
    STUDY_DIRECTORY + '/test_compression_proof_receipts.py',
    STUDY_DIRECTORY + '/compression_harness_overlay.py',
    STUDY_DIRECTORY + '/test_compression_harness_overlay.py',
    STUDY_DIRECTORY + '/test_driver_boundaries.py',
    STUDY_DIRECTORY + '/audit_artifact.py',
    STUDY_DIRECTORY + '/test_audit_artifact.py',
    STUDY_DIRECTORY + '/README.md',
    '.github/workflows/compression-proof-screen-1b47.yml',
)
PROVENANCE_PATHS = (
    'package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/benchmark-support.js',
    'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js',
    'test/chromium/import-flags-ab-benchmark.js', HARNESS, 'test/e2e/import-timing.js',
    'ext/js/pages/settings/dictionary-import-controller.js',
    'builds/manabitan-chrome-dev.zip', 'builds/manabitan-chrome.zip',
)
OBSERVATION_FILES = (
    'summary.json', 'run-1.json', 'canonical-receipt.json', 'compression-proof.json',
    'comparison-receipt.json', 'compression-proof-policy.json', 'compression-storage-policy.json',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require_equal(actual, expected, label):
    # JSON comparison also distinguishes true from 1 and rejects nonfinite data.
    if json.dumps(actual, sort_keys=True, allow_nan=False) != json.dumps(expected, sort_keys=True, allow_nan=False):
        raise ValueError(label + ' differs from the required value')


def require_source_context(plan, identities, candidate_sha):
    require_equal(plan['baseline'], BASELINE_SHA, 'active common baseline')
    require_equal(plan['candidate'], candidate_sha, 'independently supplied candidate commit')
    for value in (plan, identities):
        require_equal(value['sourceContext'], SOURCE_CONTEXT, 'source context')
        require_equal(value['frozenProductBlobs'], PRODUCT_BLOBS, 'original product blobs')
    require_equal(identities['arms']['A']['sha'], BASELINE_SHA, 'baseline source identity')
    require_equal(identities['arms']['B']['sha'], candidate_sha, 'candidate source identity')
    require_equal(sorted(identities['arms']), ['A', 'B'], 'source arms')


def overlay_manifest(original, proof, memory):
    require_equal(sha(original.encode()), ORIGINAL_HARNESS_SHA256, 'original harness source')
    return {
        'path': HARNESS,
        'originalSha256': ORIGINAL_HARNESS_SHA256,
        'proofSha256': sha(proof.encode()),
        'memorySha256': sha(memory.encode()),
        'allowedDirtyPaths': [HARNESS],
        'symmetry': 'Same proof source on A/B/C; memory markers compose on that same proof source',
        'boundary': 'Additive physical/decoded evidence after the unchanged import endpoint; no product overlay',
    }


def require_overlay_sources(root, plan, identities, original, proof, memory):
    expected = overlay_manifest(original, proof, memory)
    require_equal(plan['proofOverlay'], expected, 'registered proof overlay')
    require_equal(identities['proofOverlay'], expected, 'source identity proof overlay')
    for relative, source in (
        ('proof-overlay/harness-original.js', original),
        ('proof-overlay/harness-proof.js', proof),
        ('proof-overlay/harness-memory.js', memory),
        ('memory/harness-original.js', proof),
        ('memory/harness-instrumented.js', memory),
    ):
        if (root / relative).read_bytes() != source.encode():
            raise ValueError('Emitted overlay source differs: ' + relative)
    return expected


def require_observation_members(inventory, dictionary, items):
    expected_names = {dictionary + '/' + item[0] for item in items}
    if len(items) != 26 or len(expected_names) != 26:
        raise ValueError('Expected exactly 26 distinct observation directories')
    for filename in OBSERVATION_FILES:
        expected = {name + '/' + filename for name in expected_names}
        actual = {item['path'] for item in inventory if pathlib.PurePosixPath(item['path']).name == filename}
        require_equal(sorted(actual), sorted(expected), 'complete member set for ' + filename)


def require_saved_proof(report, receipt, read, *, dictionary, arm, comparison_receipt):
    proof = report['benchmark'].get('compressionProof')
    if type(proof) is not dict:
        raise ValueError('The raw report lacks its additive compression proof')
    require_equal(read('compression-proof.json'), proof, 'raw proof sidecar')
    compared, policy_audit = comparison_receipt(receipt, proof, dictionary=dictionary, arm=arm)
    require_equal(read('comparison-receipt.json'), compared, 'labeled comparison receipt')
    require_equal(read('compression-proof-policy.json'), policy_audit, 'proof policy audit')
    require_equal(read('compression-storage-policy.json'), policy_audit['originalStorageAudit'], 'original exact-storage audit')
    return proof, policy_audit


def require_physical_family(anchors, receipt, proof, *, dictionary, arm, media, matcher):
    family = 'B' if arm == 'B' else 'A'
    if family in anchors:
        previous_receipt, previous_proof, previous_media = anchors[family]
        matcher(previous_receipt, receipt, dictionary=dictionary,
                reference_arm=family, candidate_arm=arm,
                reference_proof=previous_proof, candidate_proof=proof,
                compare_media=previous_media == media)
    else:
        anchors[family] = (receipt, proof, media)


def require_parser_workers(summary):
    actual = summary['runs'][0]['step4Breakdown']['dictionaries'][0]['parserWorkerCount']
    require_equal(actual, 3, 'observed unchanged parser worker policy')


def require_report_pointer(summary, dictionary, observation, acquisition_root):
    value = summary['runs'][0]['reportJsonPath']
    if type(value) is not str:
        raise ValueError('Raw report pointer must be an absolute source path')
    path = pathlib.PurePosixPath(value)
    suffix = (dictionary, *pathlib.PurePosixPath(observation).parts, 'run-1.json')
    if (not path.is_absolute() or '..' in path.parts or str(path) != value
            or len(path.parts) <= len(suffix) or path.parts[-len(suffix):] != suffix):
        raise ValueError('Raw report pointer differs from its artifact observation suffix')
    prefix = str(pathlib.PurePosixPath(*path.parts[:-len(suffix)]))
    if acquisition_root is not None:
        require_equal(prefix, acquisition_root, 'common original acquisition root')
    return prefix


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=pathlib.Path, required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex'), required=True)
    parser.add_argument('--candidate-sha', required=True, help='Known registered study commit; never inferred from the artifact')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--extract', type=pathlib.Path, required=True)
    parser.add_argument('--baseline-root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[3],
        help='Inherited option name: verified study-source checkout with the candidate tooling and baseline/candidate Git objects; a baseline-only checkout is insufficient')
    args = parser.parse_args(argv)
    if re.fullmatch(r'[a-f0-9]{40}', args.candidate_sha) is None or re.fullmatch(r'[a-f0-9]{64}', args.expected_sha256) is None:
        parser.error('Expected a complete lowercase candidate commit and archive SHA-256')
    assert not args.output.exists(), 'Never overwrite an earlier artifact audit'
    assert not args.extract.exists(), 'Never overwrite an earlier artifact extraction'
    blob = args.archive.read_bytes()
    assert sha(blob) == args.expected_sha256

    def git(*command):
        return subprocess.check_output(['git', *command], cwd=args.baseline_root)

    def git_file(commit, relative):
        return git('show', commit + ':' + relative)

    # Check imported validators against both the common baseline and candidate.
    dependency_root = args.baseline_root / 'dev/perf/import-memory-20261125-a7f7'
    dependency_paths = git('ls-tree', '-r', '--name-only', BASELINE_SHA,
                           'dev/perf/import-memory-20261125-a7f7').decode().splitlines()
    expected_dependencies = {relative for relative in dependency_paths if relative.endswith('.py')}
    actual_dependencies = {str(path.relative_to(args.baseline_root)) for path in dependency_root.glob('*.py')}
    require_equal(sorted(actual_dependencies), sorted(expected_dependencies), 'validator dependency inventory')
    dependencies = {}
    for relative in sorted(expected_dependencies):
        data = (args.baseline_root / relative).read_bytes()
        assert data == git_file(BASELINE_SHA, relative) == git_file(args.candidate_sha, relative), relative
        dependencies[relative] = sha(data)
    sys.path.insert(0, str(dependency_root))
    from qualification_receipts import validate_import_summary
    from audit_memory import audit_cell
    from protocol import memory_overlay, schedule as frozen_memory_schedule

    previous_root = args.baseline_root / 'dev/perf/import-compression-level-20261128-1b47'
    for relative, expected_hash in PREVIOUS_TOOLING_HASHES.items():
        data = (args.baseline_root / relative).read_bytes()
        assert sha(data) == expected_hash, relative
        assert data == git_file(PRODUCT_ORIGIN_SHA, relative) == git_file(args.candidate_sha, relative), relative
    sys.path.insert(0, str(previous_root))
    import compression_receipts as original_storage_policy
    study_root = pathlib.Path(__file__).resolve().parent
    assert study_root == (args.baseline_root / STUDY_DIRECTORY).resolve(), 'Reader must use the verified study source tree'
    verified_study_hashes = {}
    for relative in STUDY_FILES:
        data = (args.baseline_root / relative).read_bytes()
        assert data == git_file(args.candidate_sha, relative), relative
        verified_study_hashes[relative] = sha(data)
    sys.path.insert(0, str(study_root))
    import compression_proof_receipts as proof_policy
    from compression_harness_overlay import apply_overlay
    assert proof_policy.BASELINE_SHA == BASELINE_SHA
    assert proof_policy.PRODUCT_SOURCE_SHA == PRODUCT_ORIGIN_SHA
    assert proof_policy.STORAGE_PREDICTION_BASELINE_SHA == PREDICTION_BASELINE_SHA
    assert original_storage_policy.BASELINE_SHA == PREDICTION_BASELINE_SHA

    for relative, expected_hash in ORIGINAL_TOOLING_HASHES.items():
        data = git_file(BASELINE_SHA, relative)
        assert (args.baseline_root / relative).read_bytes() == data == git_file(args.candidate_sha, relative)
        assert sha(data) == expected_hash
    product_change = git('diff', '--name-only', BASELINE_SHA, args.candidate_sha, '--', 'ext', 'dev/data').decode().splitlines()
    assert product_change == ['ext/js/dictionary/zstd-term-content.js']
    assert not git('diff', '--name-only', PREDICTION_BASELINE_SHA, BASELINE_SHA, '--', *PRODUCT_BLOBS)
    for relative, expected_blob in PRODUCT_BLOBS.items():
        assert git('rev-parse', args.candidate_sha + ':' + relative).decode().strip() == expected_blob
        assert git('rev-parse', PRODUCT_ORIGIN_SHA + ':' + relative).decode().strip() == expected_blob
    required_same = {
        'package.json', 'package-lock.json', '.github/actions/setup/action.yml',
        'test/perf/dictionaries.lock.json', 'dev/perf/import-benchmark.js',
        'dev/perf/benchmark-support.js', 'dev/perf/dictionary-fixtures.js', HARNESS,
        'test/e2e/import-timing.js', 'dev/perf/import-media-validation.js',
    }
    required_same.update(relative for relative in git('ls-tree', '-r', '--name-only', BASELINE_SHA,
                         'test/e2e', 'test/chromium', 'dev/perf').decode().splitlines()
                         if relative.endswith(('.js', '.mjs', '.html')))
    for relative in sorted(required_same):
        assert git_file(BASELINE_SHA, relative) == git_file(args.candidate_sha, relative), relative
    original_harness = git_file(BASELINE_SHA, HARNESS).decode()
    proof_harness = apply_overlay(original_harness)
    memory_harness = memory_overlay(proof_harness)

    args.extract.mkdir(parents=True)
    inventory = []
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names))
        for member in archive.infolist():
            path = pathlib.PurePosixPath(member.filename)
            assert not path.is_absolute() and '..' not in path.parts
            if member.is_dir():
                continue
            data = archive.read(member)
            inventory.append({'path': member.filename, 'bytes': len(data), 'sha256': sha(data)})
            if not member.filename.endswith(('.zip', '.html')):
                target = args.extract / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        root = args.extract / args.dictionary
        read = lambda name: json.loads((root / name).read_text())
        plan = read('registered-plan.json')
        identities = read('source-identities.json')
        require_source_context(plan, identities, args.candidate_sha)
        assert plan['dictionary'] == args.dictionary
        assert plan['flags'] == {} and plan['pairs'] == 6 and plan['initialOrder'] == 'AB'
        require_equal(plan['expectedWorkers'], 3, 'registered parser worker observation guard')
        assert plan['vndbSahAllocationPolicy'] is None
        expected_schedule = []
        for pair, order in enumerate(('AB', 'BA'), 1):
            for arm in order:
                expected_schedule.append({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm})
        for pair in range(1, 7):
            for arm in 'AB' if pair % 2 else 'BA':
                expected_schedule.append({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm})
            if pair % 3 == 0:
                control_pair = pair // 3
                for arm in 'AC' if control_pair % 2 else 'CA':
                    expected_schedule.append({'id': f'control-{control_pair:02d}-{arm}', 'kind': 'control', 'pair': control_pair, 'arm': arm})
        assert plan['schedule'] == expected_schedule and len(expected_schedule) == 20
        assert len({item['id'] for item in expected_schedule}) == 20
        assert plan['memorySchedule'] == frozen_memory_schedule(1)
        assert plan['expectedPackageEntries'] == ['js/dictionary/zstd-term-content.js']
        require_equal(plan['storagePolicy'], original_storage_policy.policy_manifest(args.dictionary), 'historical exact-storage policy')
        require_equal(plan['compressionProofPolicy'], proof_policy.policy_manifest(args.dictionary), 'corrected proof policy')
        require_equal(plan['dispositionPolicy'], DISPOSITION_POLICY, 'prospective disposition policy')
        require_equal(plan['previousTrialToolingSha256'], PREVIOUS_TOOLING_HASHES, 'original failed-trial tooling')
        require_equal(plan['studyToolingSha256'], verified_study_hashes, 'corrected study tooling')
        require_equal(plan['originalToolingSha256'], ORIGINAL_TOOLING_HASHES, 'original qualification tooling')
        overlay = require_overlay_sources(root, plan, identities, original_harness, proof_harness, memory_harness)
        require_equal(read('memory/plan.json'), {
            'schedule': plan['memorySchedule'], 'replication': 1, 'dictionary': args.dictionary,
            'authoritativeTiming': False, 'sourceHashes': identities['arms'],
            'overlaySha256': overlay['memorySha256'],
            'baseHarnessKind': 'registered compression-proof overlay', 'proofOverlay': overlay,
        }, 'separate memory plan')
        browser = read('browser-identity.json')
        package_entries = {}
        for arm, commit in (('A', BASELINE_SHA), ('B', args.candidate_sha)):
            identity = identities['arms'][arm]
            assert identity['tree'] == git('rev-parse', commit + '^{tree}').decode().strip()
            data = archive.read(args.dictionary + '/package-' + arm + '.zip')
            assert sha(data) == identity['packageSha256']
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                assert len(package.namelist()) == len(set(package.namelist()))
                entries = {item.filename: sha(package.read(item)) for item in package.infolist() if not item.is_dir()}
                assert package.read('js/dictionary/zstd-term-content.js') == git_file(commit, 'ext/js/dictionary/zstd-term-content.js')
            assert entries == identity['entries']
            package_entries[arm] = entries
            source_hashes = {}
            for relative in PROVENANCE_PATHS:
                if relative == 'builds/manabitan-chrome.zip':
                    source_hashes[relative] = sha(data)
                elif relative == 'builds/manabitan-chrome-dev.zip':
                    source_hashes[relative] = None
                else:
                    source_hashes[relative] = sha(git_file(commit, relative))
            require_equal(identity['sourceHashes'], source_hashes, 'pre-overlay source hashes for ' + arm)
            assert identity['lockSha256'] == source_hashes['package-lock.json']
            assert identity['fixtureLockSha256'] == source_hashes['test/perf/dictionaries.lock.json']
        changed = sorted(name for name in set(package_entries['A']) | set(package_entries['B'])
                         if package_entries['A'].get(name) != package_entries['B'].get(name))
        assert changed == sorted(plan['expectedPackageEntries']) == identities['changedPackageEntries']
        fixture = json.loads(git_file(BASELINE_SHA, 'test/perf/dictionaries.lock.json'))['dictionaries'][args.dictionary]
        reference = reference_arm = reference_proof = None
        full_media_reference = full_media_reference_arm = full_media_reference_proof = None
        physical_references = {}
        acquisition_root = None
        receipts, proof_policy_audits, storage_policy_audits, phase_metrics = [], [], [], []
        all_items = [(item['id'], item['arm'], 'sample', False) for item in plan['schedule']]
        all_items += [('exhaustive-media-' + arm, arm, 'all', False) for arm in ('A', 'B')]
        all_items += [('memory/' + item['name'], item['arm'], 'sample', True) for item in plan['memorySchedule']]
        require_observation_members(inventory, args.dictionary, all_items)
        for name, arm, media, memory in all_items:
            identity = identities['arms']['B' if arm == 'B' else 'A']
            hashes = identity['sourceHashes'].copy()
            hashes[HARNESS] = overlay['memorySha256' if memory else 'proofSha256']
            summary, report = read(name + '/summary.json'), read(name + '/run-1.json')
            acquisition_root = require_report_pointer(summary, args.dictionary, name, acquisition_root)
            receipt = validate_import_summary(summary, report, dictionary=args.dictionary, fixture=fixture,
                source_sha=identity['sha'], package_sha256=identity['packageSha256'],
                browser_version=browser['version'], import_flags=None, source_hashes=hashes,
                source_dirty=True, media_check=media, vndb_sah_allocation_units=None)
            require_parser_workers(summary)
            require_equal(receipt, read(name + '/canonical-receipt.json'), name + ' raw receipt')
            proof, policy_audit = require_saved_proof(report, receipt,
                lambda relative: read(name + '/' + relative), dictionary=args.dictionary, arm=arm,
                comparison_receipt=proof_policy.comparison_receipt)
            proof_policy_audits.append({'path': name, 'arm': arm, 'audit': policy_audit})
            storage_policy_audits.append({'path': name, 'arm': arm, 'audit': policy_audit['originalStorageAudit']})
            require_physical_family(physical_references, receipt, proof, dictionary=args.dictionary,
                arm=arm, media=media, matcher=proof_policy.require_matching_trial_receipts)
            if reference is None:
                reference, reference_arm, reference_proof = receipt, arm, proof
            else:
                proof_policy.require_matching_trial_receipts(reference, receipt, dictionary=args.dictionary,
                    reference_arm=reference_arm, candidate_arm=arm, compare_media=media != 'all',
                    reference_proof=reference_proof, candidate_proof=proof)
            if media == 'all':
                if full_media_reference is None:
                    full_media_reference, full_media_reference_arm, full_media_reference_proof = receipt, arm, proof
                else:
                    proof_policy.require_matching_trial_receipts(full_media_reference, receipt, dictionary=args.dictionary,
                        reference_arm=full_media_reference_arm, candidate_arm=arm,
                        reference_proof=full_media_reference_proof, candidate_proof=proof)
            receipts.append({'path': name, 'arm': arm, 'mediaCheck': media, 'memoryInstrumentation': memory,
                'rawReportStatus': report['status'], 'canonicalReceiptSha256': sha(json.dumps(receipt, sort_keys=True).encode()),
                'rawAdditiveProofSha256': sha(json.dumps(proof, sort_keys=True).encode())})
            if name.startswith('pair-'):
                phase_metrics.append({'path': name, 'arm': arm, 'metrics': summary['runs'][0]['step4Breakdown']['dictionaries'][0]})
        memory_audit = audit_cell(root / 'memory')
        assert memory_audit == read('memory/memory-audit.json')
        assert len(receipts) == len(proof_policy_audits) == len(storage_policy_audits) == 26
        assert not (root / 'memory/memory-audit-failure.json').exists()
        semantic_failures = read('memory/semantic-failures.json')
        assert isinstance(semantic_failures, list)
        observations = read('observations.json')
        assert len(observations) == len(plan['schedule'])
        for original, item in zip(plan['schedule'], observations):
            assert all(item[key] == value for key, value in original.items())
            assert item['totalImportMs'] == read(item['id'] + '/summary.json')['runs'][0]['totalImportMs'], item['id']

        def paired(kind, left, right):
            pairs = {}
            for item in observations:
                if item['kind'] == kind:
                    pairs.setdefault(item['pair'], {})[item['arm']] = item['totalImportMs']
            assert all(set(pair) == {left, right} for pair in pairs.values())
            ratios = [value[right] / value[left] for value in pairs.values()]
            rng = random.Random(897)
            resampled = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
            return {'count': len(ratios), 'ratios': ratios,
                'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
                'equalWorkChangePercent': (sum(value[right] for value in pairs.values()) / sum(value[left] for value in pairs.values()) - 1) * 100,
                'worstPairChangePercent': (max(ratios) - 1) * 100,
                'descriptiveBootstrap95Percent': [(resampled[index] - 1) * 100 for index in (249, 9749)],
                'fasterPairs': sum(ratio < 1 for ratio in ratios)}

        candidate = paired('candidate', 'A', 'B')
        control = paired('control', 'A', 'C')
        assert candidate['count'] == 6 and control['count'] == 2
        analysis = read('analysis.json')
        assert analysis['candidateVsBaseline'] == candidate and analysis['identicalCodeControl'] == control
        require_equal(analysis['storagePolicy'], original_storage_policy.policy_manifest(args.dictionary), 'analysis exact-storage policy')
        require_equal(analysis['compressionProofPolicy'], proof_policy.policy_manifest(args.dictionary), 'analysis proof policy')
        require_equal(analysis['dispositionPolicy'], DISPOSITION_POLICY, 'analysis disposition policy')
        expected_memory_passed = memory_audit['passesProspectiveMemoryScreen'] and not semantic_failures
        assert analysis['memoryPassed'] is expected_memory_passed
        expected_status = 'correctness-memory-passed' if expected_memory_passed else 'memory-or-semantics-failed'
        assert analysis['status'] == expected_status
        restoration = read('overlay-restoration.json')
        require_equal(restoration, {'observations': [
            {'arm': arm, 'originalHarnessSha256': ORIGINAL_HARNESS_SHA256,
             'trackedTreeClean': True, 'packageBytesUnchanged': True} for arm in ('A', 'B')
        ], 'errors': []}, 'final overlay restoration')
        result = {
            'scope': 'Read-only complete corrected-artifact audit; no observation, source, protocol, gate, raw physical receipt or original result modified',
            'auditorSha256': sha(pathlib.Path(__file__).read_bytes()),
            'archive': str(args.archive), 'archiveSha256': sha(blob), 'archiveBytes': len(blob),
            'memberCount': len(inventory), 'memberInventory': inventory, 'extraction': str(args.extract),
            'validatorDependencies': dependencies, 'verifiedStudyTooling': verified_study_hashes,
            'verifiedPreviousTrialTooling': PREVIOUS_TOOLING_HASHES,
            'sourceContext': SOURCE_CONTEXT, 'proofOverlay': overlay,
            'storagePolicy': original_storage_policy.policy_manifest(args.dictionary),
            'compressionProofPolicy': proof_policy.policy_manifest(args.dictionary),
            'storagePolicyAudits': storage_policy_audits, 'compressionProofPolicyAudits': proof_policy_audits,
            'allRawAndComparisonReceiptsExact': len(proof_policy_audits) == 26,
            'allRawAdditiveProofSidecarsExact': True, 'bothPhysicalFamilyAnchorsExact': True,
            'allObservationMemberSetsExact': True, 'proofOverlayDerivationExact': True,
            'overlayRestorationExact': True, 'allPackageBytesMatchIdentity': True,
            'changedPackageEntries': changed, 'receiptsRevalidated': receipts,
            'all26ReceiptsExact': len(receipts) == 26, 'rawMemoryScanAudit': memory_audit,
            'candidateVsBaselineRecomputed': candidate, 'identicalCodeControlRecomputed': control,
            'phaseMetrics': phase_metrics, 'status': expected_status, 'semanticFailures': semantic_failures,
            'sourcePlanAndClockLinksExact': True, 'scheduleAndStatusRecomputed': True,
            'allReportPointersBoundToObservation': True, 'originalAcquisitionRoot': acquisition_root,
            'sourceIdentities': identities, 'registeredPlan': plan,
        }
        args.output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({key: result[key] for key in (
            'archiveSha256', 'memberCount', 'all26ReceiptsExact', 'allRawAdditiveProofSidecarsExact',
            'changedPackageEntries', 'rawMemoryScanAudit', 'candidateVsBaselineRecomputed',
            'identicalCodeControlRecomputed', 'status')}, indent=2))


if __name__ == '__main__':
    main()
