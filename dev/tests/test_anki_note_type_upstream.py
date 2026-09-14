"""Regression tests for the schema-only APKG reader; no real Anki installation."""
from contextlib import closing
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location("anki_upstream", Path(__file__).resolve().parents[1] / "anki-note-type-upstream.py")
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)
HAS_ZSTD = importlib.util.find_spec("zstandard") is not None


def database(modern=False, fields=("Word", "Reading")):
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "test.sqlite"
        with closing(sqlite3.connect(path)) as db, db:
            if modern:
                db.execute("CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT)")
                db.execute("CREATE TABLE fields (ntid INTEGER, ord INTEGER, name TEXT)")
                db.execute("INSERT INTO notetypes VALUES (1, 'Example')")
                db.executemany("INSERT INTO fields VALUES (1, ?, ?)", list(enumerate(fields))[::-1])
            else:
                db.execute("CREATE TABLE col (models TEXT)")
                db.execute("INSERT INTO col VALUES (?)", (json.dumps({"1": {"name": "Example", "flds": [{"ord": i, "name": name} for i, name in reversed(list(enumerate(fields)))]}}),))
        return path.read_bytes()


def package(*members):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in members:
            archive.writestr(name, data)
    return output.getvalue()


class PackageReaderTests(unittest.TestCase):
    def test_legacy(self):
        self.assertEqual(upstream.extract_models(package(("collection.anki2", database()))), [{"name": "Example", "fields": ["Word", "Reading"]}])

    def test_modern_and_field_order(self):
        self.assertEqual(upstream.extract_models(package(("collection.anki21", database(True)))), [{"name": "Example", "fields": ["Word", "Reading"]}])

    def test_modern_preferred_over_dummy_legacy(self):
        models = upstream.extract_models(package(("collection.anki2", database(fields=("Dummy",))), ("collection.anki21", database(True))))
        self.assertEqual(models[0]["fields"], ["Word", "Reading"])

    @unittest.skipUnless(HAS_ZSTD, "zstandard is required; installed by compatibility CI")
    def test_zstandard_preferred_over_dummy_legacy(self):
        import zstandard
        compressed = zstandard.ZstdCompressor().compress(database(True))
        models = upstream.extract_models(package(("collection.anki2", database(fields=("Dummy",))), ("collection.anki21b", compressed)))
        self.assertEqual(models[0]["fields"], ["Word", "Reading"])

    @unittest.skipUnless(HAS_ZSTD, "zstandard is required; installed by compatibility CI")
    def test_corrupt_zstandard_does_not_fall_back_to_dummy(self):
        with self.assertRaises(Exception):
            upstream.extract_models(package(("collection.anki2", database()), ("collection.anki21b", b"corrupt")))

    def test_corrupt_modern_does_not_fall_back(self):
        with self.assertRaisesRegex(ValueError, "not SQLite"):
            upstream.extract_models(package(("collection.anki2", database()), ("collection.anki21", b"corrupt")))

    def test_missing_member_or_duplicate_member(self):
        with self.assertRaisesRegex(ValueError, "Missing or duplicate"):
            upstream.extract_models(package(("../collection.anki2", database())))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            duplicate = package(("collection.anki2", database()), ("collection.anki2", database()))
        with self.assertRaisesRegex(ValueError, "Missing or duplicate"):
            upstream.extract_models(duplicate)

    def test_duplicate_or_empty_fields_fail(self):
        for fields in [("Word", "Word"), (), ("",)]:
            for modern in (False, True):
                with self.subTest(fields=fields, modern=modern):
                    with self.assertRaisesRegex(ValueError, "Invalid note type"):
                        upstream.extract_models(package(("collection.anki2", database(modern, fields))))

    def test_bounds(self):
        with self.assertRaisesRegex(ValueError, "exceeds"):
            upstream.read_bounded(io.BytesIO(b"12345"), 4)
        with patch.object(upstream, "LIMIT", 32):
            with self.assertRaisesRegex(ValueError, "size limit"):
                upstream.extract_models(b"x" * 33)

    def test_checksums(self):
        data = b"package"
        digest = hashlib.sha256(data).hexdigest()
        blob = hashlib.sha1(b"blob 7\0" + data).hexdigest()
        self.assertEqual(upstream.verify_package(data, {"pinnedSha256": digest, "digest": f"sha256:{digest}", "gitBlobSha": blob}), digest)
        for key in ("pinnedSha256", "digest", "gitBlobSha", "pinnedGitBlobSha"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "mismatch"):
                upstream.verify_package(data, {key: "invalid"})

    def test_url_allowlist(self):
        for url in ["http://github.com/x", "https://github.com.evil.example/x", "https://localhost/x", "file:///etc/passwd", "https://u:p@github.com/x", "https://github.com:444/x"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                upstream.validate_url(url)
        upstream.validate_url("https://raw.githubusercontent.com/owner/repo/commit/file.apkg")

    def test_cross_host_redirect_drops_authorization(self):
        request = Request("https://api.github.com/start", headers={"Authorization": "Bearer fake"})
        redirected = upstream.SafeRedirect().redirect_request(request, None, 302, "", {}, "https://release-assets.githubusercontent.com/file")
        self.assertFalse(redirected.has_header("Authorization"))

    def test_release_selection_fails_closed(self):
        source = {"repository": "owner/repo", "kind": "release", "revision": "v1", "asset": "Model.apkg"}
        for assets in [[], [{"name": "a.apkg"}, {"name": "b.apkg"}]]:
            with patch.object(upstream, "api", return_value={"draft": False, "prerelease": False, "assets": assets}):
                with self.assertRaisesRegex(ValueError, "Expected one APKG"):
                    upstream.resolve(source, "latest")
        with patch.object(upstream, "api", return_value={"draft": False, "prerelease": True}):
            with self.assertRaisesRegex(ValueError, "stable release"):
                upstream.resolve(source, "latest")

    def test_repository_latest_resolves_default_branch_to_immutable_sha(self):
        responses = [{"default_branch": "trunk"}, {"sha": "abc123"}, {"type": "file", "size": 10, "name": "Model.apkg", "download_url": "https://raw.githubusercontent.com/o/r/abc123/Model.apkg", "sha": "blob123"}]
        with patch.object(upstream, "api", side_effect=responses) as api:
            result = upstream.resolve({"kind": "repository", "repository": "o/r", "revision": "old", "path": "Model.apkg"}, "latest")
        self.assertEqual(result["revision"], "abc123")
        self.assertEqual(api.call_args_list[1].args, ("repos/o/r/commits/trunk",))
        self.assertEqual(api.call_args_list[2].args, ("repos/o/r/contents/Model.apkg?ref=abc123",))


if __name__ == "__main__":
    unittest.main()
