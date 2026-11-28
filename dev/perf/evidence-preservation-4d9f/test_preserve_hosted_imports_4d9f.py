"""Offline contracts for the evidence preserver; no GitHub or browser calls."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
import urllib.error
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location(
    'preserver', Path(__file__).with_name('preserve-hosted-imports-4d9f.py'))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


def zip_bytes(items):
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as archive:
        for name, body in items:
            item = zipfile.ZipInfo(name, date_time=(2020, 1, 2, 3, 4, 6))
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, body)
    return result.getvalue()


def artifact(body, name='example'):
    return {'id': 123, 'name': name, 'size': len(body),
            'sha256': hashlib.sha256(body).hexdigest(), 'runId': 7,
            'workflowHead': 'a' * 40}


def package_fixture():
    entries = [('manifest.json', b'{"name":"test"}'), ('js/test.js', b'export const value = 1;\n')]
    body = zip_bytes(entries)
    proof = {'arms': {'A': {
        'packageSha256': hashlib.sha256(body).hexdigest(),
        'entries': {name: hashlib.sha256(value).hexdigest() for name, value in entries},
    }}}
    return body, proof


class PreservationContracts(unittest.TestCase):
    def test_deterministic_complete_archive_excludes_only_proved_package(self):
        package, proof = package_fixture()
        diagnostic = zip_bytes([('retained.txt', b'unproved diagnostic archive')])
        files = [
            ('package-A.zip', package),
            ('source-identities.json', json.dumps(proof, sort_keys=True).encode()),
            ('failure.log', b'original failed memory coverage observation\n'),
            ('analysis.json', b'{"memoryPassed":false}\n'),
            ('diagnostic.zip', diagnostic),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hashes = []
            for index, ordered in enumerate((files, list(reversed(files)))):
                raw = zip_bytes(ordered)
                path = root / f'artifact-{index}.zip'
                path.write_bytes(raw)
                output = root / f'output-{index}'
                receipt = P.archive_artifact(path, output, artifact(raw))
                self.assertTrue(receipt['everyPreservedMemberVerified'])
                self.assertEqual(receipt['excludedVerifiedProductZipCount'], 1)
                exclusions = json.loads((output / 'verified-product-zips.json').read_text())
                self.assertEqual([item['name'] for item in exclusions], ['package-A.zip'])
                with tarfile.open(output / 'verified-evidence.tar.xz', 'r:xz') as tar:
                    actual = {item.name: tar.extractfile(item).read() for item in tar.getmembers()}
                    for item in tar.getmembers():
                        self.assertEqual((item.uid, item.gid, item.mtime, item.mode), (0, 0, 0, 0o644))
                self.assertEqual(actual, {name: value for name, value in files if name != 'package-A.zip'})
                hashes.append(receipt['archiveSha256'])
            self.assertEqual(hashes[0], hashes[1])

    def test_incomplete_or_wrong_package_inventory_is_not_excluded(self):
        for alteration in ('missing-member', 'wrong-member-hash'):
            package, proof = package_fixture()
            entries = proof['arms']['A']['entries']
            if alteration == 'missing-member':
                entries.pop('js/test.js')
            else:
                entries['js/test.js'] = '0' * 64
            raw = zip_bytes([('package-A.zip', package),
                             ('source-identities.json', json.dumps(proof).encode())])
            with self.subTest(alteration=alteration), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / 'input.zip'
                path.write_bytes(raw)
                with self.assertRaisesRegex(ValueError, 'complete inventory'):
                    P.archive_artifact(path, root / 'output', artifact(raw))
                self.assertFalse((root / 'output/archive-receipt.json').exists())

    def test_unproved_package_bytes_are_retained(self):
        package, proof = package_fixture()
        proof['arms']['A']['packageSha256'] = '0' * 64
        raw = zip_bytes([('package-A.zip', package),
                         ('source-identities.json', json.dumps(proof).encode())])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'input.zip'
            path.write_bytes(raw)
            receipt = P.archive_artifact(path, root / 'output', artifact(raw))
            self.assertEqual(receipt['excludedVerifiedProductZipCount'], 0)
            with tarfile.open(root / 'output/verified-evidence.tar.xz', 'r:xz') as tar:
                self.assertEqual(tar.extractfile('package-A.zip').read(), package)

    def test_duplicate_or_unsafe_archive_members_fail_closed(self):
        for name in ('../escape', '/absolute', r'a\b', './file', 'a//b', '.'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                P.safe_member(name)
        self.assertEqual(P.safe_member('safe/file.json'), 'safe/file.json')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                raw = zip_bytes([('same', b'first'), ('same', b'second')])
            path = root / 'duplicate.zip'
            path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, 'Duplicate artifact'):
                P.archive_artifact(path, root / 'output', artifact(raw))

    def test_manifest_identity_guards(self):
        sample = artifact(b'contents')
        sample.pop('runId')
        valid = {'schemaVersion': 1, 'repository': 'ManabiIO/manabitan',
                 'runs': [{'id': 7, 'artifacts': [sample]}], 'pending': []}
        self.assertEqual(P.manifest_artifacts(valid)[0]['runId'], 7)
        for key, value in (('id', True), ('size', 0), ('name', '../bad'), ('sha256', 'not-a-hash')):
            changed = json.loads(json.dumps(valid))
            changed['runs'][0]['artifacts'][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                P.manifest_artifacts(changed)
        duplicate = json.loads(json.dumps(valid))
        duplicate['runs'][0]['artifacts'].append(sample)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            P.manifest_artifacts(duplicate)

    def test_authenticated_redirect_does_not_forward_token(self):
        body = b'pinned downloadable artifact bytes'
        item = artifact(body)
        seen = []
        signed = 'https://storage.example/bytes?signature=fake-test-only'

        class Opener:
            def open(self, request, timeout):
                seen.append(request.get_header('Authorization'))
                raise urllib.error.HTTPError(request.full_url, 302, 'redirect',
                                             {'Location': signed}, None)

        def unauthenticated(location, timeout):
            self.assertEqual(location, signed)
            self.assertEqual(timeout, 60)
            return io.BytesIO(body)

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'artifact.zip'
            with mock.patch.object(P.urllib.request, 'build_opener', return_value=Opener()), \
                    mock.patch.object(P.urllib.request, 'urlopen', side_effect=unauthenticated):
                P.download_artifact('ManabiIO/manabitan', item, path, 'never-forward-me')
            self.assertEqual(path.read_bytes(), body)
            self.assertFalse(path.with_suffix('.partial').exists())
        self.assertEqual(seen, ['Bearer never-forward-me'])
        error = urllib.error.HTTPError(signed, 403, 'forbidden', {}, None)
        self.assertNotIn('signature', json.dumps(P.safe_failure(error)))
        self.assertEqual(P.safe_failure(error)['httpCode'], 403)

    def test_wrong_outer_digest_keeps_partial_without_accepting_zip(self):
        body = b'wrong artifact bytes'
        item = artifact(body)
        item['sha256'] = '0' * 64

        class Opener:
            def open(self, request, timeout):
                return io.BytesIO(body)

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'artifact.zip'
            with mock.patch.object(P.urllib.request, 'build_opener', return_value=Opener()):
                with self.assertRaisesRegex(ValueError, 'digest differs'):
                    P.download_artifact('ManabiIO/manabitan', item, path, 'test-token')
            self.assertFalse(path.exists())
            self.assertEqual(path.with_suffix('.partial').read_bytes(), body)

    def test_successful_recomputation_preserves_failed_memory_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'output'
            scratch = root / 'scratch'
            scratch.mkdir()
            name = 'import-current-implicit-metadata-vndb-BA-currentbase1-4d9f'
            item = artifact(b'original-artifact', name)
            item['runId'] = P.CURRENT_RUN
            extracted_result = [{'artifact': {'name': name},
                                 'memory': {'passesProspectiveMemoryScreen': False}}]

            def completed(command, stdout, stderr):
                extraction = Path(command[command.index('--output') + 1])
                extraction.mkdir()
                (extraction / 'independent-audit.json').write_text(json.dumps(extracted_result))
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(P.subprocess, 'run', side_effect=completed):
                result = P.run_current_vn_audit(item, root / (name + '.zip'), output, scratch,
                                                root / 'validators', root / 'frozen-audit.py')
            self.assertEqual(result['status'], 'audit-passed')
            self.assertEqual(result['memoryScreenFailedCells'], [name])
            self.assertFalse(result['results'][0]['memory']['passesProspectiveMemoryScreen'])
            self.assertEqual(json.loads((output / 'independent-audit.json').read_text()), extracted_result)
            self.assertFalse((scratch / 'audit-123').exists())


if __name__ == '__main__':
    unittest.main()
