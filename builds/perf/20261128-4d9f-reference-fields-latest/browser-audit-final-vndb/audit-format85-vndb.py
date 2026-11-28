#!/usr/bin/env python3
"""Read-only independent audit of the two frozen final85 VNDB browser cells.

The prospectively registered exact77-unit contract is checked before invoking
the unchanged semantic validator. Original16c strict37 failures remain failures.
No browser import, benchmark or memory measurement is launched by this script.
"""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import zipfile

EXPECTED = {
    15262007286: ('reference-browser-vndb-on-off-a30077-4d9f', 17262203, 'f161c5c373beab7e067d3877e82940f4149b8767b6e4ff115bb8421fb528ae6a'),
    15262577737: ('reference-browser-vndb-off-on-a30077-4d9f', 17262541, '62baf2baab181afc9fcd412b2cf63b8383c518c7425de616c2b941b7ab8130ed'),
}
SOURCE = '85a8aa49f76fbabd2dc494aad247f74774ff2573'
SOURCE_TREE = 'ae7323d19d6da0cc500ff231a0dcd469ce4f31af'
TOOLING = '6650e56034b7c4e92451a7032fbf93ffd76d999f'
TOOLING_TREE = 'f6381689025ca791493acd1077ddac5eb8277dcf'


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
                    selected = {}
                    entry = 'js/dictionary/term-record-opfs-store.js'
                    value = package.read(entry)
                    selected[entry] = hashlib.sha1(b'blob ' + str(len(value)).encode() + b'\0' + value).hexdigest()
                package_receipt = {'bytes': len(data), 'sha256': digest(data), 'entries': entries, 'selectedEntryGitBlobs': selected}
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
    parser.add_argument('--previous-inventory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not __debug__:
        raise SystemExit('Assertions must remain enabled')
    pins = json.loads(args.pins.read_bytes())
    assert (pins['sourceCommit'], pins['sourceTree'], pins['toolingCommit'], pins['toolingTree']) == (SOURCE, SOURCE_TREE, TOOLING, TOOLING_TREE)
    assert pins['runId'] == 46141945184
    assert file_digest(args.previous_inventory) == pins['previousPackageInventory']['sha256']
    previous_package = json.loads(args.previous_inventory.read_bytes())
    assert len(previous_package['entries']) == pins['previousPackageInventory']['entries'] == 582
    args.output.mkdir(exist_ok=False)
    source_pins = {entry['path']: entry['sha256'] for entry in pins['pinnedSources']}
    reference = None
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
        assert plan['contract'] == contract
        assert plan['dictionary'] == 'vndb'
        order = plan['schedule']
        assert name == 'reference-browser-vndb-' + '-'.join(order) + '-a30077-4d9f'
        assert order in (['off', 'on'], ['on', 'off'])
        assert plan['source'] == identity['sha'] == SOURCE
        assert identity['tree'] == SOURCE_TREE
        assert plan['toolingSource'] == TOOLING and plan['toolingTree'] == TOOLING_TREE
        assert plan['timingEligible'] is False and contract['timingEligible'] is False
        assert contract['candidate'] == SOURCE and contract['candidateTree'] == SOURCE_TREE and contract['schemaVersion'] == 2
        assert identity['sourceDirty'] is True
        assert package['sha256'] == identity['packageSha256']
        assert package['bytes'] == identity['packageBytes']
        assert package['entries'] == identity['entries']
        assert len(package['entries']) == 582
        if common_package_entries is None:
            common_package_entries = package['entries']
        else:
            assert package['entries'] == common_package_entries
        delta = [{'path': key, 'before': previous_package['entries'].get(key), 'after': package['entries'].get(key)}
                 for key in sorted(set(previous_package['entries']) | set(package['entries']))
                 if previous_package['entries'].get(key) != package['entries'].get(key)]
        expected_delta = [{key: item[key] for key in ('path', 'before', 'after')} for item in pins['expectedPackageDelta']]
        assert delta == expected_delta
        for item in pins['expectedPackageDelta']:
            assert package['selectedEntryGitBlobs'][item['path']] == item['afterGitBlob']
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
        allocation = import_pinned(output / 'sah_allocation_contract.py', 'allocation_' + str(artifact_id))
        assert overlay.overlay(raw['harness-original.js'].decode()) == raw['harness-instrumented.js'].decode()
        assert package['entries']['lib/sqlite/index.mjs'] == overlay.SQLITE_BUNDLE_SHA256
        assert package['entries']['js/dictionary/sqlite-wasm.js'] == overlay.SQLITE_WRAPPER_SHA256
        exact_units = allocation.exact_parent_allocation(contract, 'vndb')
        assert exact_units == [77, 77]
        parent = contract['parentAllocationObservation']
        assert parent['source'] == contract['parent'] == 'a300da36d00df8e353c5679b1528b50a1299b75f'
        assert parent['artifactId'] == 15261649240 and parent['runId'] == 46140891339
        assert parent['artifactSha256'] == 'a03b703d9e0e3ffe47edd953d8ba066911f70ea91d33d33557579eb2011cac5f'
        assert parent['rawReportSha256'] == '3ea007adcaa5190860333540a6eb1fec87d24bd110b0315fe4235fb60e1bb07b'
        case = contract['dictionaries']['vndb']
        fixture = pins['fixture']['dictionaries']['vndb']
        assert case['totalRows'] == fixture['termRows'] == 6648310
        observations = []
        for mode in order:
            assert parsed('import-' + mode + '-exit.json')['returncode'] == 0
            summary = parsed(f'{mode}/summary.json')
            report = parsed(f'{mode}/run-1.json')
            receipt = validator.validate_import_summary(summary, report,
                dictionary='vndb', fixture=fixture, source_sha=SOURCE,
                package_sha256=package['sha256'], browser_version=browser['version'],
                import_flags={'experimentalReferenceTableFields': mode == 'on'},
                source_hashes=identity['sourceHashes'], source_dirty=True,
                media_check='all', vndb_sah_allocation_units=exact_units)
            assert receipt == parsed(f'{mode}/canonical-receipt.json')
            activation = overlay.validate_activation(report['referenceFormatActivation'], case['modes'][mode]['activation'])
            assert activation == parsed(f'{mode}/activation-receipt.json')
            normalized = normalization.normalize_receipt(receipt, case, mode)
            assert normalized == parsed(f'{mode}/normalized-receipt.json')
            if reference is not None:
                validator.require_matching_receipts(reference, normalized)
            reference = normalized
            sizes = sorted(item['bytes'] for item in report['benchmark']['validation']['storage']['files'] if item['path'].startswith(validator.SQLITE_PREFIX))
            assert sizes == [4096] * 7 + [315392]
            observations.append({'mode': mode, 'attempted': True, 'rawStatus': report['status'],
                'reportSha256': digest(raw[f'{mode}/run-1.json']), 'summarySha256': digest(raw[f'{mode}/summary.json']),
                'strictSemanticStatus': 'passed', 'fullMedia': True, 'lookupObservations': 72,
                'registeredSahUnits': exact_units, 'actualSahSizes': sizes,
                'activation': activation, 'actualTermFileBytes': sum(case['modes'][mode]['termFiles'].values())})
        result = parsed('result.json')
        assert result['status'] == 'passed' and result['source'] == SOURCE
        assert result['dictionary'] == 'vndb' and result['order'] == '-'.join(order)
        assert result['timingEligible'] is False and result['processMemoryMeasured'] is False
        saved = sum(case['modes']['off']['termFiles'].values()) - sum(case['modes']['on']['termFiles'].values())
        assert saved == case['expectedTermFileBytesSaved'] == result['actualTermFileBytesSaved'] == 24411244
        assert result['observations'] == parsed('observations.json')
        for original, recomputed in zip(result['observations'], observations, strict=True):
            assert original == {key: recomputed[key] for key in ('mode', 'activation', 'actualTermFileBytes')} | {'semanticChecksPassed': True, 'timingEligible': False}
        cell = {'artifactId': artifact_id, 'artifactName': name, 'artifactSha256': expected_sha, 'artifactBytes': byte_count,
            'source': SOURCE, 'sourceTree': SOURCE_TREE, 'tooling': TOOLING, 'toolingTree': TOOLING_TREE,
            'dictionary': 'vndb', 'schedule': order, 'packageSha256': package['sha256'], 'packageEntries': len(package['entries']),
            'browser': browser, 'status': 'passed', 'actualTermFileBytesSaved': saved,
            'observations': observations, 'timingEligible': False, 'processMemoryMeasured': False,
            'packageDeltaFrom16c': delta}
        write_json(output / 'independent-audit.json', cell)
        cells.append(cell)
        print(json.dumps({'artifactId': artifact_id, 'order': order, 'status': 'passed', 'qualifiedImports': 2, 'actualTermFileBytesSaved': saved}), flush=True)
    assert len(cells) == 2 and {tuple(cell['schedule']) for cell in cells} == {('off', 'on'), ('on', 'off')}
    summary = {'schemaVersion': 1, 'runId': 46141945184, 'source': SOURCE, 'sourceTree': SOURCE_TREE,
        'tooling': TOOLING, 'toolingTree': TOOLING_TREE, 'qualifiedCells': 2, 'qualifiedImports': 4,
        'allReleaseEntriesIdenticalAcrossBothHosts': True, 'releaseEntryCount': len(common_package_entries),
        'registeredVndbUnits': [77, 77], 'actualTermFileBytesSaved': 24411244,
        'original16cFailuresRetrospectivelyQualified': False, 'timingEligible': False, 'processMemoryMeasured': False,
        'packageDeltaFrom16c': pins['expectedPackageDelta'], 'cells': cells,
        'limitations': ['Four orderly-restart VNDB imports on two independent opposite-order hosts; interruption, corruption and older-reader gates are separate.',
            'The unchanged validator uses the prospectively registered exact77 parent allocation; no range widening or per-observation adjustment.',
            'The two prior16c VNDB strict37 failures remain failures. Existing16c JMdict/Jitendex results retain their source identity.',
            'All582 release-entry hashes match across85 hosts. Exactly one entry differs from16c, matching the independently inspected lint-only source file.',
            'No import-speed or whole-process-memory improvement is asserted.']}
    write_json(args.output / 'audit-index.json', summary)
    write_json(args.output / 'audit-input-identities.json', {'scriptSha256': file_digest(Path(__file__)), 'pinsSha256': file_digest(args.pins),
        'previousPackageInventorySha256': file_digest(args.previous_inventory), 'artifacts': EXPECTED})


if __name__ == '__main__':
    main()
