#!/usr/bin/env python3
"""Read field schemas from upstream APKGs without importing notes or executing templates."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 128 * 1024 * 1024
HOSTS = {"api.github.com", "github.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urlsplit(newurl).netloc != urlsplit(req.full_url).netloc:
            redirected.remove_header("Authorization")
        return redirected


def validate_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in HOSTS or parts.username or parts.password or parts.port not in (None, 443):
        raise ValueError(f"Unexpected upstream URL: {url}")


def read_bounded(stream, limit: int = LIMIT) -> bytes:
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Input exceeds {limit} bytes")
    return data


def download(url: str, limit: int = LIMIT) -> bytes:
    validate_url(url)
    headers = {"User-Agent": "Manabitan-Anki-Compatibility", "Accept": "application/octet-stream"}
    if urlsplit(url).hostname == "api.github.com":
        headers["Accept"] = "application/vnd.github+json"
        token = os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
    for attempt in range(3):
        try:
            with build_opener(SafeRedirect()).open(Request(url, headers=headers), timeout=45) as response:
                return read_bounded(response, limit)
        except (HTTPError, URLError, TimeoutError) as error:
            retryable = not isinstance(error, HTTPError) or error.code in (429, 500, 502, 503, 504)
            if not retryable or attempt == 2:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("Unreachable")


def api(path: str):
    return json.loads(download(f"https://api.github.com/{path}", 4 * 1024 * 1024))


def resolve(source: dict, mode: str) -> dict:
    repo = source["repository"]
    if source["kind"] == "release":
        endpoint = "latest" if mode == "latest" else f"tags/{quote(source['revision'], safe='')}"
        release = api(f"repos/{repo}/releases/{endpoint}")
        if release["draft"] or release["prerelease"]:
            raise ValueError("Expected a published stable release")
        assets = [a for a in release["assets"] if a["name"].lower().endswith(".apkg")]
        if mode == "pinned":
            assets = [a for a in assets if a["name"] == source["asset"]]
        if len(assets) != 1:
            raise ValueError(f"Expected one APKG, found {[a['name'] for a in assets]}")
        asset = assets[0]
        if asset["size"] > LIMIT:
            raise ValueError("APKG exceeds download limit")
        return {"revision": release["tag_name"], "publishedAt": release["published_at"], "asset": asset["name"], "url": asset["browser_download_url"], "digest": asset.get("digest"), "pinnedSha256": source.get("sha256") if mode == "pinned" else None}
    if source["kind"] != "repository":
        raise ValueError(f"Unknown source kind: {source['kind']}")
    revision = source["revision"]
    if mode == "latest":
        branch = api(f"repos/{repo}")["default_branch"]
        revision = api(f"repos/{repo}/commits/{quote(branch, safe='')}")["sha"]
    item = api(f"repos/{repo}/contents/{quote(source['path'])}?ref={quote(revision, safe='')}")
    if item["type"] != "file" or item["size"] > LIMIT:
        raise ValueError("Expected a bounded repository APKG file")
    return {"revision": revision, "asset": item["name"], "url": item["download_url"], "gitBlobSha": item["sha"], "pinnedGitBlobSha": source.get("gitBlobSha") if mode == "pinned" else None}


def verify_package(data: bytes, resolved: dict) -> str:
    digest = hashlib.sha256(data).hexdigest()
    for expected in (resolved.get("pinnedSha256"), (resolved.get("digest") or "").removeprefix("sha256:")):
        if expected and digest != expected:
            raise ValueError(f"APKG SHA-256 mismatch: expected {expected}, received {digest}")
    blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
    for expected in (resolved.get("gitBlobSha"), resolved.get("pinnedGitBlobSha")):
        if expected and blob != expected:
            raise ValueError(f"APKG Git blob mismatch: expected {expected}, received {blob}")
    return digest


def extract_models(data: bytes) -> list[dict]:
    if len(data) > LIMIT:
        raise ValueError("APKG exceeds size limit")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 10000:
            raise ValueError("Too many archive members")
        # Modern exports include a dummy anki2 database. Never prefer that stub,
        # and never fall back to it when the real collection is corrupt.
        names = archive.namelist()
        member = next((n for n in ("collection.anki21b", "collection.anki21", "collection.anki2") if n in names), None)
        if member is None or names.count(member) != 1:
            raise ValueError("Missing or duplicate collection member")
        if archive.getinfo(member).file_size > LIMIT:
            raise ValueError("Collection exceeds size limit")
        with archive.open(member) as stream:
            collection = read_bounded(stream)
        if member == "collection.anki21b":
            import zstandard
            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(collection)) as stream:
                collection = read_bounded(stream)
    if not collection.startswith(b"SQLite format 3\0"):
        raise ValueError("Collection is not SQLite")
    with tempfile.TemporaryDirectory(prefix="manabitan-anki-") as folder:
        path = Path(folder) / "collection.sqlite"
        path.write_bytes(collection)
        db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("PRAGMA query_only=ON")
            # Bound pathological queries as well as the downloaded bytes.
            deadline = time.monotonic() + 10
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"notetypes", "fields"} <= tables:
                models = [{"name": name, "fields": [f[0] for f in db.execute("SELECT name FROM fields WHERE ntid=? ORDER BY ord", (ntid,))]} for ntid, name in db.execute("SELECT id, name FROM notetypes ORDER BY id")]
            elif "col" in tables:
                row = db.execute("SELECT models FROM col").fetchone()
                if row is None:
                    raise ValueError("Collection has no model metadata")
                models = [{"name": m["name"], "fields": [f["name"] for f in sorted(m["flds"], key=lambda f: f["ord"])]} for m in json.loads(row[0]).values()]
            else:
                raise ValueError("Unsupported collection schema")
        finally:
            db.close()
    if not models:
        raise ValueError("Collection contains no note types")
    for model in models:
        fields = model["fields"]
        if not isinstance(model["name"], str) or not model["name"] or not fields or len(fields) > 256 or any(not isinstance(f, str) or not f for f in fields) or len(set(fields)) != len(fields):
            raise ValueError("Invalid note type or duplicate field names")
    return models


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("pinned", "latest"), default="pinned")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fixtures = json.loads((ROOT / "test/data/anki-note-types/contracts.json").read_text())
    report = {"mode": args.mode, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": []}
    failed = False
    for contract in fixtures:
        result = {"id": contract["id"], "repository": contract["source"]["repository"]}
        try:
            resolved = resolve(contract["source"], args.mode)
            result.update(resolved)
            data = download(resolved["url"])
            result["sha256"] = verify_package(data, resolved)
            result["models"] = extract_models(data)
            result["status"] = "downloaded"
        except Exception as error:
            # An unavailable release is NOT a compatibility pass or a skip.
            failed = True
            result.update(status="error", error=f"{type(error).__name__}: {error}")
        report["results"].append(result)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
