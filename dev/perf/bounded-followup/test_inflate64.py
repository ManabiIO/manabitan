import copy
import unittest
import tempfile
import zipfile
import warnings
from pathlib import Path
from inflate64 import COMMON, WASM, PACKAGE, check_common, check_wasm_identity, digest

class BuildIdentityTests(unittest.TestCase):
    def good(self):
        a = {p: 'same' for p in COMMON}
        b = {**a, WASM: 'intentionally different'}
        return {'baseline': {'common': a}, 'candidate': {'common': b}}

    def test_only_wasm_change_is_accepted(self):
        check_common(self.good())

    def test_same_binary_is_not_a_bitbuffer_comparison(self):
        data = self.good()
        data['candidate']['common'] = copy.deepcopy(data['baseline']['common'])
        with self.assertRaises(ValueError): check_common(data)

    def test_missing_identity_fails(self):
        for arm in ('baseline', 'candidate'):
            for path in COMMON:
                data = self.good(); del data[arm]['common'][path]
                with self.assertRaises(ValueError): check_common(data)

    def test_any_other_changed_identity_fails(self):
        for path in COMMON:
            if path == WASM: continue
            data = self.good(); data['candidate']['common'][path] = 'wrong'
            with self.assertRaises(ValueError): check_common(data)

class PackagedIdentityTests(unittest.TestCase):
    def setup_files(self, root, member='lib/term-bank-parser.wasm', content=b'wasm', duplicate=False):
        (root / WASM).parent.mkdir(parents=True, exist_ok=True)
        (root / WASM).write_bytes(b'wasm')
        (root / PACKAGE).parent.mkdir(parents=True, exist_ok=True)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(root / PACKAGE, 'w') as z:
                z.writestr(member, content)
                if duplicate: z.writestr(member, content)
        return {'common': {WASM: digest(root / WASM)}, 'package_sha256': digest(root / PACKAGE)}

    def test_real_schema_does_not_need_per_run_wasm_summary_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = self.setup_files(root)
            check_wasm_identity(root, expected)

    def test_changed_build_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = self.setup_files(root)
            (root / WASM).write_bytes(b'changed')
            with self.assertRaises(ValueError): check_wasm_identity(root, expected)

    def test_changed_zip_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = self.setup_files(root)
            (root / PACKAGE).write_bytes(b'changed')
            with self.assertRaises(ValueError): check_wasm_identity(root, expected)

    def test_wrong_shipped_wasm_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = self.setup_files(root, content=b'different')
            with self.assertRaises(ValueError): check_wasm_identity(root, expected)

    def test_missing_shipped_wasm_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = self.setup_files(root, member='other')
            with self.assertRaises(ValueError): check_wasm_identity(root, expected)

    def test_duplicate_member_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = self.setup_files(root, duplicate=True)
            with self.assertRaises(ValueError): check_wasm_identity(root, expected)

if __name__ == '__main__': unittest.main()
