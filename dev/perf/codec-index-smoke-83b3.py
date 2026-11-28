#!/usr/bin/env python3
"""Bind a single hosted correctness/admission smoke; never qualify import speed."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time
import traceback
import zipfile

BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
LOCK_SHA256 = "60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89"
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js",
    "test/chromium/import-flags-ab-benchmark.js", "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/e2e/import-timing.js", "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)
SCOPE = {
    "purpose": "Single-import correctness and shared-codec admission smoke",
    "authoritativeTiming": False,
    "qualifiesMemory": False,
    "qualifiesSpeed": False,
    "comparison": "Independent matrix jobs; no paired timing or cross-host timing comparison",
    "rawEvidence": "Native reports remain unchanged, including their internal timing labels",
}


def require(value, message):
    if not value:
        raise ValueError(message)


def sha256(file):
    result = hashlib.sha256()
    with pathlib.Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def capture(command, root):
    return subprocess.check_output(command, cwd=root, text=True).strip()


def write_exclusive(file, value):
    with file.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def clean_source(root, expected):
    require(capture(["git", "rev-parse", "HEAD"], root) == expected, "Unexpected source HEAD")
    require(capture(["git", "status", "--porcelain"], root) == "", "Smoke source is dirty")


def writer_admission(report, dictionary, arm):
    phases = [item for item in report["phases"] if (item.get("data") or {}).get("kind") == "dictionary-import"]
    require(len(phases) == 1, "Smoke must contain exactly one dictionary import")
    timings = phases[0]["data"]["importDebug"]["importerPhaseTimings"]
    final = [item for item in timings if item["phase"] == "bulk-finalization"]
    require(len(final) == 1, "Missing or repeated bulk finalization")
    details = final[0]["details"]
    require(details.get("ok") is True and details.get("published") is True, "Bulk finalization did not publish")
    require(details.get("housekeepingErrors") == [], "Post-publication housekeeping failed")
    count = details.get("termRecordLookupIndexWorkerFileCount")
    require(type(count) is int and count >= 0, "Invalid index-worker file count")
    if dictionary == "jmdict":
        require(count == (0 if arm == "A" else 1), "JMdict shared-codec admission was not exercised exactly as registered")
    return {"workerFileCount": count, "jmdictExpected": (0 if arm == "A" else 1) if dictionary == "jmdict" else None,
            "indexWriteBytes": details.get("termRecordLookupIndexWriteBytes"),
            "meaning": "Below 1 GiB source, candidate source selects only the borrowed ready-codec path; topology is a separate diagnostic"}


def prepare(args):
    root, output = args.repo.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    require(re.fullmatch(r"[a-f0-9]{40}", args.source) is not None, "Full source SHA required")
    require(re.fullmatch(r"[a-f0-9]{40}", args.tooling_source) is not None, "Full tooling SHA required")
    require(args.arm != "A" or (args.dictionary == "jmdict" and args.source == BASELINE), "Only frozen JMdict baseline A is registered")
    require(args.arm != "B" or args.source == args.tooling_source, "Candidate B must be the committed tooling/source head")
    clean_source(root, args.source)
    script = pathlib.Path(__file__).read_bytes()
    recorded_script = subprocess.check_output(["git", "show", args.tooling_source + ":dev/perf/codec-index-smoke-83b3.py"], cwd=root)
    require(script == recorded_script, "Smoke helper differs from recorded tooling commit")
    lock = root / "test/perf/dictionaries.lock.json"
    require(sha256(lock) == LOCK_SHA256, "Fixture lock changed")
    fixture = json.loads(lock.read_text())["dictionaries"][args.dictionary]
    archive = root / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
    require(archive.stat().st_size == fixture["sizeBytes"] and sha256(archive) == fixture["sha256"], "Fixture archive mismatch")
    with zipfile.ZipFile(archive) as zipped:
        banks = [item for item in zipped.infolist() if re.fullmatch(r"term_bank_[0-9]+\.json", item.filename)]
        require(len(banks) > 0, "Missing source banks")
        require(len({item.filename for item in banks}) == len(banks), "Repeated source bank")
        raw_bytes = sum(item.file_size for item in banks)
    if args.dictionary == "jmdict":
        require(len(banks) == 53 and raw_bytes == 171617523, "Unexpected JMdict source admission bytes")
    package = root / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(package) as zipped:
        names = [item.filename for item in zipped.infolist()]
        require(len(names) == len(set(names)), "Repeated package member")
        entries = {item.filename: hashlib.sha256(zipped.read(item)).hexdigest() for item in zipped.infolist() if not item.is_dir()}
    node = capture(["node", "--version"], root)
    require(node == "v22.22.0", "Node version mismatch")
    executable = capture(["node", "--input-type=module", "-e", "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"], root)
    version_text = capture([executable, "--version"], root)
    match = re.search(r"\d+\.\d+\.\d+\.\d+", version_text)
    require(match is not None and match.group(0) == "153.0.8010.12", "Pinned browser version mismatch")
    identity = {
        "scope": SCOPE, "preparedBeforeBrowserAtUnixNs": time.time_ns(),
        "arm": args.arm, "dictionary": args.dictionary, "source": args.source,
        "sourceTree": capture(["git", "rev-parse", "HEAD^{tree}"], root), "sourceDirty": False,
        "toolingSource": args.tooling_source, "helperSha256": hashlib.sha256(script).hexdigest(),
        "node": node, "fixtureLockSha256": LOCK_SHA256, "fixture": fixture,
        "rawTermBankSourceBytes": raw_bytes, "termBankCount": len(banks),
        "packageSha256": sha256(package), "packageEntries": entries,
        "browserExecutable": executable, "browserVersion": match.group(0), "browserVersionOutput": version_text,
        "browserSha256": sha256(executable),
        "sourceHashes": {path: sha256(root / path) if (root / path).is_file() else None for path in PROVENANCE_PATHS},
    }
    write_exclusive(output / "smoke-identity.json", identity)
    return {"prepared": True, "scope": SCOPE, "source": args.source, "packageSha256": identity["packageSha256"]}


def verify(args):
    root, output = args.repo.resolve(), args.output.resolve()
    identity = json.loads((output / "smoke-identity.json").read_text())
    require(identity["arm"] == args.arm and identity["dictionary"] == args.dictionary, "Smoke cell changed")
    require(identity["source"] == args.source and identity["toolingSource"] == args.tooling_source, "Smoke source changed")
    require(identity["helperSha256"] == sha256(__file__), "Smoke helper changed")
    clean_source(root, args.source)
    require(sha256(root / "builds/manabitan-chrome.zip") == identity["packageSha256"], "Product package changed during smoke")
    require(sha256(identity["browserExecutable"]) == identity["browserSha256"], "Browser executable changed")
    summary = json.loads((output / "summary.json").read_text())
    report = json.loads((output / "run-1.json").read_text())
    sys.path.insert(0, str(root / "dev/perf/import-memory-20261125-a7f7"))
    from qualification_receipts import validate_import_summary
    receipt = validate_import_summary(
        summary, report, dictionary=args.dictionary, fixture=identity["fixture"],
        source_sha=args.source, package_sha256=identity["packageSha256"],
        browser_version=identity["browserVersion"], source_hashes=identity["sourceHashes"],
        import_flags=None, source_dirty=False, media_check="all",
        vndb_sah_allocation_units=(37, 37) if args.dictionary == "vndb" else None,
    )
    admission = writer_admission(report, args.dictionary, args.arm)
    result = {"passed": True, "scope": SCOPE, "identitySha256": sha256(output / "smoke-identity.json"),
              "summarySha256": sha256(output / "summary.json"), "reportSha256": sha256(output / "run-1.json"),
              "admission": admission, "canonicalReceipt": receipt}
    write_exclusive(output / "smoke-validation.json", result)
    return {"passed": True, "scope": SCOPE, "admission": admission}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "verify"))
    parser.add_argument("--repo", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--tooling-source", required=True)
    parser.add_argument("--arm", choices=("A", "B"), required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    args = parser.parse_args()
    try:
        result = prepare(args) if args.mode == "prepare" else verify(args)
    except Exception as error:
        args.output.mkdir(parents=True, exist_ok=True)
        write_exclusive(args.output / (args.mode + "-failure.json"), {
            "scope": SCOPE, "type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc(),
            "mode": args.mode, "arm": args.arm, "dictionary": args.dictionary, "source": args.source,
        })
        raise
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
