#!/usr/bin/env python3
"""Deterministic compact-catalog corpus replay; not a timing or OPFS benchmark.

The Python oracle uses zipfile/JSON independently of the importer. It retains one
term bank and unique image paths, never decoded banks or complete term rows.
Node subprocesses execute one full importer at a time with a counting database.
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile
import zlib


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest_lines(values):
    digest = hashlib.sha256()
    for value in values:
        digest.update((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
    return digest.hexdigest()


def structured_images(value):
    if isinstance(value, list):
        for item in value:
            yield from structured_images(item)
    elif isinstance(value, dict):
        if value.get("tag") == "img":
            yield value["path"]
        elif "content" in value:
            yield from structured_images(value["content"])


def glossary_images(glossary):
    for item in glossary:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "image":
            yield item["path"]
        elif item.get("type") == "structured-content":
            yield from structured_images(item.get("content"))


def oracle(archive_path, fixture):
    assert archive_path.stat().st_size == fixture["sizeBytes"]
    assert digest_file(archive_path) == fixture["sha256"]
    paths = set()
    rows = references = 0
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        assert len(set(names)) == len(names), "Duplicate archive names"
        banks = sorted(
            (name for name in names if re.fullmatch(r"term_bank_[0-9]+\.json", name)),
            key=lambda name: int(re.search(r"[0-9]+", name).group()),
        )
        for bank in banks:
            with archive.open(bank) as stream:
                entries = json.load(stream)
            rows += len(entries)
            for row in entries:
                assert len(row) == 8
                for path in glossary_images(row[5]):
                    assert isinstance(path, str) and path
                    references += 1
                    paths.add(path)
            del entries
        assert rows == fixture["termRows"], (rows, fixture["termRows"])
        assert len(paths) == fixture["mediaFiles"], (len(paths), fixture["mediaFiles"])
        assert not (paths & set(fixture.get("unreferencedMediaPaths", [])))
        media_digest = hashlib.sha256()
        media_bytes = 0
        for path in sorted(paths):
            content = archive.read(path)  # zipfile checks the source CRC too.
            media_bytes += len(content)
            record = [path, len(content), hashlib.sha256(content).hexdigest()]
            media_digest.update((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        assert media_bytes == fixture["mediaBytes"]
    return {
        "archiveSha256": fixture["sha256"],
        "termBanks": len(banks),
        "termRows": rows,
        "rawImageReferences": references,
        "uniqueImagePaths": len(paths),
        "imagePathsSha256": digest_lines(sorted(paths)),
        "mediaBytes": media_bytes,
        "mediaSha256": media_digest.hexdigest(),
    }


def provenance(root):
    source_paths = sorted({
        "package.json",
        "package-lock.json",
        "ext/js/media/media-util.js",
        "ext/js/core/json.js",
        "test/perf/dictionaries.lock.json",
        *(str(path.relative_to(root)) for path in (root / "ext/js/dictionary").glob("*.js")),
    })
    generated_paths = sorted(str(path.relative_to(root)) for path in (root / "ext/lib").rglob("*") if path.is_file())
    assert "ext/lib/term-bank-parser.wasm" in generated_paths, "Run build:libs before replay"
    return {
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "sourceSha256": {name: digest_file(root / name) for name in source_paths},
        "generatedSha256": {name: digest_file(root / name) for name in generated_paths},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=pathlib.Path, required=True)
    parser.add_argument("--candidate", type=pathlib.Path, required=True)
    parser.add_argument("--cache", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--fixtures", default="jmdict,jitendex,vndb")
    parser.add_argument("--node", default="node")
    parser.add_argument("--heap-mib", type=int, default=512)
    parser.add_argument("--worker", choices=["prepared", "decline"], default="prepared")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    roots = {"base": args.base.resolve(), "candidate": args.candidate.resolve()}
    script = pathlib.Path(__file__).resolve().parents[2] / "test/perf/compact-media-corpus-replay.mjs"
    harness_files = [pathlib.Path(__file__).resolve(), script]
    report = {
        "status": "running",
        "complete": False,
        "scope": "Full source importer media dispatch; counting database; real source packer precomputed before import and delivered through explicit worker-result adapter; no worker transport, concurrency, browser/OPFS, elapsed-time, or peak-memory claim",
        "workerMode": args.worker,
        "invocation": sys.argv,
        "fixtures": {},
    }
    report_path = args.out / "report.json"

    def save_report():
        temporary = args.out / "report.json.tmp"
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(report_path)

    # Invalidate any old successful receipt before checks or subprocesses can
    # fail. Partial output can never claim that the requested cohort completed.
    save_report()
    try:
        if not __debug__:
            raise RuntimeError("Run without -O or PYTHONOPTIMIZE; oracle assertions are required")
        lock_name = "test/perf/dictionaries.lock.json"
        assert (roots["base"] / lock_name).read_bytes() == (roots["candidate"] / lock_name).read_bytes()
        fixtures = json.loads((roots["base"] / lock_name).read_text())["dictionaries"]
        report["runtime"] = {
            "python": sys.version,
            "pythonZlib": zlib.ZLIB_VERSION,
            "node": subprocess.check_output([args.node, "--version"], text=True).strip(),
        }
        report["provenance"] = {label: provenance(root) for label, root in roots.items()}
        report["harnessSha256"] = {path.name: digest_file(path) for path in harness_files}
        save_report()
        for fixture_id in args.fixtures.split(","):
            report["current"] = {"fixture": fixture_id, "arm": "oracle"}
            save_report()
            fixture = fixtures[fixture_id]
            archive = (args.cache / fixture["cacheFile"]).resolve()
            print(f"Oracle: {fixture_id}", file=sys.stderr, flush=True)
            expected = oracle(archive, fixture)
            outcome = {"oracle": expected}
            report["fixtures"][fixture_id] = outcome
            for label, root in roots.items():
                report["current"] = {"fixture": fixture_id, "arm": label}
                save_report()
                assert provenance(root) == report["provenance"][label], "Repository identity changed before replay"
                assert {path.name: digest_file(path) for path in harness_files} == report["harnessSha256"], "Harness changed"
                print(f"Importer: {fixture_id} / {label}", file=sys.stderr, flush=True)
                command = [
                    args.node, f"--max-old-space-size={args.heap_mib}", str(script),
                    str(root), str(archive), fixture_id, args.worker,
                ]
                with (args.out / f"{fixture_id}-{label}.stderr.log").open("w") as errors:
                    run = subprocess.run(command, stdout=subprocess.PIPE, stderr=errors, text=True, check=True)
                actual = json.loads(run.stdout)
                (args.out / f"{fixture_id}-{label}.json").write_text(json.dumps(actual, indent=2) + "\n")
                assert provenance(root) == report["provenance"][label], "Repository identity changed during replay"
                assert actual["runtime"]["node"] == report["runtime"]["node"]
                assert actual["termRows"] == expected["termRows"]
                assert actual["requirements"]["uniqueImagePaths"] == expected["uniqueImagePaths"]
                assert actual["requirements"]["imagePathsSha256"] == expected["imagePathsSha256"]
                assert actual["media"]["bytes"] == expected["mediaBytes"]
                assert actual["media"]["sha256"] == expected["mediaSha256"]
                assert actual["media"]["count"] == expected["uniqueImagePaths"]
                outcome[label] = actual
                save_report()
            report["current"] = {"fixture": fixture_id, "arm": "comparison"}
            assert digest_file(archive) == fixture["sha256"], "Archive changed during replay"
            assert {path.name: digest_file(path) for path in harness_files} == report["harnessSha256"], "Harness changed"
            for field in ["requirements", "media", "counts", "nativeTermChunks", "termRows", "sourceCatalog", "runtime"]:
                assert outcome["base"][field] == outcome["candidate"][field], field
            base = outcome["base"]["materialization"]
            candidate = outcome["candidate"]["materialization"]
            assert candidate["finalImages"] <= base["finalImages"], "Created image-entry regression"
            compact = outcome["candidate"]["sourceCatalog"]["type"] == "DenseZipFileMap"
            if expected["uniqueImagePaths"] and compact and fixture_id == "vndb":
                assert base["atLastTermSink"] == expected["uniqueImagePaths"]
                assert candidate["atLastTermSink"] == 0, "Fast deferral was not exercised"
            if fixture_id == "jitendex":
                assert base["finalImages"] == candidate["finalImages"]
                assert outcome["candidate"]["media"]["route"] == "decoded-rows"
                assert outcome["candidate"]["media"]["count"] == 236
            if fixture_id == "vndb" and args.worker == "prepared":
                assert candidate["finalImages"] == 0
                assert outcome["candidate"]["worker"]["prepared"] is True
                assert outcome["candidate"]["media"]["route"] == "generation-plan"
            outcome["materializationDelta"] = {
                "duringTerms": candidate["atLastTermSink"] - base["atLastTermSink"],
                "final": candidate["finalImages"] - base["finalImages"],
            }
            outcome["complete"] = True
            save_report()
        report["status"] = "passed"
        report["complete"] = True
        report.pop("current", None)
        save_report()
    except BaseException as error:
        report["status"] = "failed"
        report["failure"] = {"type": type(error).__name__, "message": str(error), **report.get("current", {})}
        save_report()
        raise
    print(json.dumps({"ok": True, "report": str((args.out / "report.json").resolve())}))


if __name__ == "__main__":
    main()
