#!/usr/bin/env python3
"""Read-only audit of the six frozen format16c browser artifacts.

The original strict 37-unit VNDB gate is retained. Failed cells are never
requalified; their independently readable activation receipts are diagnostic.
No benchmark is launched and no elapsed-time or process-memory claim is made.
"""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import zipfile

EXPECTED = {
    15261830153: ('reference-browser-vndb-on-off-latest-4d9f', 17207626, '786feeaf788bac8139902174aa19eea3c9bb4d03dfbf9ca7e234c5cb43f5a7a4'),
    15261720648: ('reference-browser-vndb-off-on-latest-4d9f', 17206077, 'd1d98d52b08ffe70ac51c7986681704dd7860030dbddef64369dc761c195a794'),
    15261425778: ('reference-browser-jitendex-off-on-latest-4d9f', 17251025, 'cfd6565e708d6d09896ceb58c6afeea6881da9d9ca45b65e02ad14f4723bfda2'),
    15261096419: ('reference-browser-jmdict-off-on-latest-4d9f', 17249234, '66fe0ef4e2508219812da0e709cab28bf3be95800439b7ad3400aee5ea93ae46'),
    15260672677: ('reference-browser-jmdict-on-off-latest-4d9f', 17248927, 'd83cb6295311463ea3d125f4fe61bc00a03b534e80e5d18266b6383b49524d73'),
    15260589347: ('reference-browser-jitendex-on-off-latest-4d9f', 17250671, '9c99eb7780ff98c8db7340edfe7ab2fde2000f16e115fa9229af2f0971e66a53'),
}
SOURCE = '16c1b9fb1e850fec5d1c3e1dba792b9c8a293e97'
SOURCE_TREE = 'c9bd2df5331c144d4988be32f29a64045a407786'
TOOLING = '0740b2d462a4be47f4ac0fdd20469d4f72cb52bc'
TOOLING_TREE = 'dc1236c251543334a8bb1ac59db363d2b7db9a17'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    with path.open('x') as handle:
        json.dump(value, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write('\n')


def import_pinned(path, label):
    spec = importlib.util.spec_from_file_location(label, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unpack_artifact(path, output):
    output.mkdir(exist_ok=False)
    raw = {}
    members = []
    package_receipt = None
    with zipfile.ZipFile(path) as archive:
        names = [item.filename for item in archive.infolist() if not item.is_dir()]
        assert len(names) == len(set(names))
        for name in names:
            parts = PurePosixPath(name)
            assert not parts.is_absolute() and '..' not in parts.parts
            data = archive.read(name)
            members.append({'path': name, 'bytes': len(data), 'sha256': digest(data)})
            if name == 'package.zip':
                with zipfile.ZipFile(io.BytesIO(data)) as package:
                    paths = [item.filename for item in package.infolist() if not item.is_dir()]
                    assert len(paths) == len(set(paths))
                    entries = {entry: digest(package.read(entry)) for entry in paths}
                package_receipt = {'bytes': len(data), 'sha256': digest(data), 'entries': entries}
            else:
                target = output / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as handle:
                    handle.write(data)
                raw[name] = data
    assert package_receipt is not None
    write_json(output / 'independent-member-inventory.json', members)
    write_json(output / 'independent-package-inventory.json', package_receipt)
    return raw, package_receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--pins', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not __debug__:
        raise SystemExit('Assertions must remain enabled')
    pins = json.loads(args.pins.read_bytes())
    assert (pins['sourceCommit'], pins['sourceTree'], pins['toolingCommit'], pins['toolingTree']) == (SOURCE, SOURCE_TREE, TOOLING, TOOLING_TREE)
    args.output.mkdir(exist_ok=False)
    source_pins = {entry['path']: entry['sha256'] for entry in pins['pinnedSources']}
    cross_cell = {}
    common_package_entries = None
    cells = []
    for artifact_id, (name, byte_count, expected_sha) in EXPECTED.items():
        archive = args.artifacts / (name + '.zip')
        assert archive.stat().st_size == byte_count
        assert file_digest(archive) == expected_sha
        output = args.output / name
        raw, package = unpack_artifact(archive, output)
        parsed = lambda member: json.loads(raw[member])
        plan = parsed('registered-plan.json')
        identity = parsed('source-identity.json')
        browser = parsed('browser-identity.json')
        contract = parsed('storage-contract.json')
        dictionary = plan['dictionary']
        order = plan['schedule']
        assert name == f'reference-browser-{dictionary}-{"-".join(order)}-latest-4d9f'
        assert order in (['off', 'on'], ['on', 'off'])
        assert plan['source'] == identity['sha'] == SOURCE
        assert identity['tree'] == SOURCE_TREE
        assert plan['toolingSource'] == TOOLING and plan['toolingTree'] == TOOLING_TREE
        assert plan['timingEligible'] is False and contract['timingEligible'] is False
        assert contract['candidate'] == SOURCE and contract['schemaVersion'] == 1
        assert identity['sourceDirty'] is True
        assert package['sha256'] == identity['packageSha256']
        assert package['bytes'] == identity['packageBytes']
        assert package['entries'] == identity['entries']
        if common_package_entries is None:
            common_package_entries = package['entries']
        else:
            assert package['entries'] == common_package_entries, 'All582 extracted release entries must match across hosts'
        for path, expected in pins['helperSha256'].items():
            assert digest(raw[path]) == expected, path
        assert digest(raw['qualification_receipts.py']) == source_pins['dev/perf/import-memory-20261125-a7f7/qualification_receipts.py'] == plan['qualificationReceiptValidatorSha256']
        assert digest(raw['storage-contract.json']) == plan['contractSha256']
        assert plan['fixtureLockSha256'] == source_pins['test/perf/dictionaries.lock.json']
        assert identity['observerSourceHashes'] == plan['observerSourceHashes']
        for path, expected in plan['observerSourceHashes'].items():
            actual_path = 'activation-overlay.py' if path == 'activation_overlay.py' else path
            assert digest(raw[actual_path]) == expected
        for path, expected in source_pins.items():
            if path == 'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py':
                continue
            assert identity['sourceHashes'][path] == expected, path
        assert identity['sourceHashes']['builds/manabitan-chrome.zip'] == package['sha256']
        assert identity['sourceHashes']['builds/manabitan-chrome-dev.zip'] is None
        assert digest(raw['harness-original.js']) == pins['harness']['originalSha256']
        assert digest(raw['harness-instrumented.js']) == pins['harness']['instrumentedSha256']
        assert identity['sourceHashes']['test/chromium/extension-two-dictionary-import.e2e.js'] == pins['harness']['instrumentedSha256']
        assert identity['instrumentation']['originalHarnessSha256'] == pins['harness']['originalSha256']
        assert identity['instrumentation']['instrumentedHarnessSha256'] == pins['harness']['instrumentedSha256']
        for label in ['fixtures', 'worktree', 'libs', 'license', 'build']:
            assert parsed(label + '-exit.json')['returncode'] == 0
        validator = import_pinned(output / 'qualification_receipts.py', 'qualification_' + str(artifact_id))
        overlay = import_pinned(output / 'activation-overlay.py', 'overlay_' + str(artifact_id))
        normalization = import_pinned(output / 'storage_contract.py', 'normalization_' + str(artifact_id))
        assert overlay.overlay(raw['harness-original.js'].decode()) == raw['harness-instrumented.js'].decode()
        assert package['entries']['lib/sqlite/index.mjs'] == overlay.SQLITE_BUNDLE_SHA256
        assert package['entries']['js/dictionary/sqlite-wasm.js'] == overlay.SQLITE_WRAPPER_SHA256
        case = contract['dictionaries'][dictionary]
        fixture = pins['fixture']['dictionaries'][dictionary]
        assert case['totalRows'] == fixture['termRows']
        observations = []
        reference = None
        for index, mode in enumerate(order):
            if f'{mode}/summary.json' not in raw:
                assert dictionary == 'vndb' and index == 1
                assert 'result.json' not in raw and 'observations.json' not in raw
                observations.append({'mode': mode, 'attempted': False, 'reason': 'Original stop-at-first-failure policy'})
                continue
            assert parsed('import-' + mode + '-exit.json')['returncode'] == 0
            summary = parsed(f'{mode}/summary.json')
            report = parsed(f'{mode}/run-1.json')
            flags = {'experimentalReferenceTableFields': mode == 'on'}
            row = {'mode': mode, 'attempted': True, 'rawStatus': report['status'], 'reportSha256': digest(raw[f'{mode}/run-1.json']), 'summarySha256': digest(raw[f'{mode}/summary.json'])}
            try:
                receipt = validator.validate_import_summary(summary, report,
                    dictionary=dictionary, fixture=fixture, source_sha=SOURCE,
                    package_sha256=package['sha256'], browser_version=browser['version'],
                    import_flags=flags, source_hashes=identity['sourceHashes'], source_dirty=True,
                    media_check='all', vndb_sah_allocation_units=[37, 37] if dictionary == 'vndb' else None)
            except ValueError as error:
                assert dictionary == 'vndb' and index == 0
                assert str(error) == 'VNDB active SAH allocation is outside 37–37 units of 4096 bytes'
                assert f'{mode}/canonical-receipt.json' not in raw
                sizes = sorted(item['bytes'] for item in report['benchmark']['validation']['storage']['files'] if item['path'].startswith(validator.SQLITE_PREFIX))
                assert sizes == [4096] * 7 + [315392]
                row.update(strictSemanticStatus='failed-original-registered-bound', failure=str(error), actualSahSizes=sizes, actualSahUnits=77, retrospectivelyQualified=False)
                activation = overlay.validate_activation(report['referenceFormatActivation'], case['modes'][mode]['activation'])
                row.update(activationDiagnostic=activation, activationDiagnosticIsQualification=False)
            else:
                assert dictionary != 'vndb'
                assert receipt == parsed(f'{mode}/canonical-receipt.json')
                activation = overlay.validate_activation(report['referenceFormatActivation'], case['modes'][mode]['activation'])
                assert activation == parsed(f'{mode}/activation-receipt.json')
                normalized = normalization.normalize_receipt(receipt, case, mode)
                assert normalized == parsed(f'{mode}/normalized-receipt.json')
                if reference is not None:
                    validator.require_matching_receipts(reference, normalized)
                reference = normalized
                if dictionary in cross_cell:
                    validator.require_matching_receipts(cross_cell[dictionary], normalized)
                else:
                    cross_cell[dictionary] = normalized
                row.update(strictSemanticStatus='passed', fullMedia=True, lookupObservations=72, activation=activation, actualTermFileBytes=sum(case['modes'][mode]['termFiles'].values()))
            observations.append(row)
        if dictionary != 'vndb':
            result = parsed('result.json')
            assert result['status'] == 'passed' and result['source'] == SOURCE
            assert result['dictionary'] == dictionary and result['order'] == '-'.join(order)
            assert result['timingEligible'] is False and result['processMemoryMeasured'] is False
            saved = sum(case['modes']['off']['termFiles'].values()) - sum(case['modes']['on']['termFiles'].values())
            assert result['actualTermFileBytesSaved'] == saved
            assert result['observations'] == parsed('observations.json')
            for original, recomputed in zip(result['observations'], observations, strict=True):
                assert original == {key: recomputed[key] for key in ('mode', 'activation', 'actualTermFileBytes')} | {'semanticChecksPassed': True, 'timingEligible': False}
        else:
            saved = None
        cell = {'artifactId': artifact_id, 'artifactName': name, 'artifactSha256': expected_sha, 'artifactBytes': byte_count,
            'source': SOURCE, 'sourceTree': SOURCE_TREE, 'tooling': TOOLING, 'toolingTree': TOOLING_TREE,
            'dictionary': dictionary, 'schedule': order, 'packageSha256': package['sha256'], 'packageEntries': len(package['entries']),
            'browser': browser, 'status': 'passed' if dictionary != 'vndb' else 'failed-original-registered-bound',
            'actualTermFileBytesSaved': saved, 'observations': observations, 'timingEligible': False, 'processMemoryMeasured': False}
        write_json(output / 'independent-audit.json', cell)
        cells.append(cell)
        print(json.dumps({'artifactId': artifact_id, 'dictionary': dictionary, 'order': order, 'status': cell['status'], 'qualifiedImports': sum(x.get('strictSemanticStatus') == 'passed' for x in observations)}), flush=True)
    assert len(cells) == 6
    summary = {'schemaVersion': 1, 'runId': 46139342690, 'source': SOURCE, 'sourceTree': SOURCE_TREE,
        'tooling': TOOLING, 'toolingTree': TOOLING_TREE, 'qualifiedCells': 4, 'qualifiedImports': 8,
        'retainedFailedCells': 2, 'unattemptedSecondImports': 2, 'allReleaseEntriesIdenticalAcrossSixHosts': True,
        'releaseEntryCount': len(common_package_entries), 'originalVndbRegisteredUnits': [37, 37],
        'originalVndbFailureObservedUnits': 77, 'originalFailuresRetrospectivelyQualified': False,
        'timingEligible': False, 'processMemoryMeasured': False, 'cells': cells,
        'limitations': ['The four qualified cells cover eight orderly-restart imports; interruption/corruption/older-reader gates are separate.',
            'The two original VNDB cells each stopped after the first successful browser import when the fixed37-unit gate rejected77 units. The second scheduled import did not run.',
            'Activation checks on those two raw VNDB reports are diagnostic only and do not turn either failed cell into a qualified cohort.',
            'Source16c results are not relabeled as85a8 or any later source. No speed or process-memory improvement is asserted.']}
    write_json(args.output / 'audit-index.json', summary)
    write_json(args.output / 'audit-input-identities.json', {'scriptSha256': file_digest(Path(__file__)), 'pinsSha256': file_digest(args.pins), 'artifacts': EXPECTED})


if __name__ == '__main__':
    main()
