#!/usr/bin/env python3
"""Run a frozen, counterbalanced comparison of two release import packages.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import random
import signal
import statistics
import subprocess
import time
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def own_orphaned_children():
    # Playwright detaches Chromium into another process group. This process
    # adopts orphaned descendants so failures can clean only this acquisition's
    # children, including browsers whose Node parent already exited.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # Linux PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Cannot establish owned child cleanup")


def child_snapshot():
    processes = {}
    for directory in Path("/proc").iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            fields = (directory / "stat").read_text().rsplit(") ", 1)[1].split()
            processes[int(directory.name)] = (int(fields[1]), int(fields[19]), fields[0])
        except (OSError, IndexError, ValueError):
            continue
    owned = {os.getpid()}
    previous = set()
    while owned != previous:
        previous = owned.copy()
        owned.update(pid for pid, (parent, _, _) in processes.items() if parent in owned)
    return {pid: (start, state) for pid, (_, start, state) in processes.items() if pid in owned and pid != os.getpid()}


def clean_owned_children():
    seen = set()
    forced = set()
    deadline = time.monotonic() + 5
    while True:
        children = child_snapshot()
        live = {pid: start for pid, (start, state) in children.items() if state != "Z"}
        if not live:
            break
        force = time.monotonic() >= deadline
        for pid, start in live.items():
            # Recheck start time and ancestry immediately before signalling so
            # PID reuse cannot target a process belonging to another task.
            if child_snapshot().get(pid, (None, None))[0] != start:
                continue
            try:
                os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
                seen.add(pid)
                if force:
                    forced.add(pid)
            except ProcessLookupError:
                pass
        if force:
            break
        time.sleep(0.05)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            while os.waitpid(-1, os.WNOHANG)[0] != 0:
                pass
        except ChildProcessError:
            pass
        children = child_snapshot()
        if not children:
            return {"signalledChildren": len(seen), "forcedChildren": len(forced)}
        for pid, (start, state) in children.items():
            if state == "Z" or child_snapshot().get(pid, (None, None))[0] != start:
                continue
            try:
                os.kill(pid, signal.SIGKILL)
                seen.add(pid)
                forced.add(pid)
            except ProcessLookupError:
                pass
        time.sleep(0.05)
    raise RuntimeError("Owned descendant cleanup did not complete; no further acquisition")


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def package(root):
    path = root / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(path) as archive:
        entries = {item.filename: digest(archive.read(item)) for item in archive.infolist() if not item.is_dir()}
    return {"sha256": digest(path.read_bytes()), "bytes": path.stat().st_size, "entries": entries}


def effects(pairs):
    changes = [100 * (right / left - 1) for left, right in pairs]
    rng = random.Random(20261125)
    bootstrap = sorted(statistics.median(rng.choices(changes, k=len(changes))) for _ in range(20000))
    return {
        "pairs": len(pairs),
        "pairedChangesPercent": changes,
        "medianPairedChangePercent": statistics.median(changes),
        "equalWorkChangePercent": 100 * (sum(right for _, right in pairs) / sum(left for left, _ in pairs) - 1),
        "descriptiveBootstrap95Percent": [bootstrap[499], bootstrap[19499]],
        "worstPairPercent": max(changes),
        "fasterPairs": sum(change < 0 for change in changes),
    }


def schedule(reverse):
    result = [("warmup", 0, arm) for arm in ("BA" if reverse else "AB")]
    for pair in range(1, 13):
        order = "BA" if (pair % 2 == 0) != reverse else "AB"
        result.extend(("candidate", pair, arm) for arm in order)
        if pair % 3 == 0:
            control = pair // 3
            order = "CA" if (control % 2 == 0) != reverse else "AC"
            result.extend(("control", control, arm) for arm in order)
    result.extend(("validation", 0, arm) for arm in ("BA" if reverse else "AB"))
    return result


def semantic_fingerprint(summary):
    """Return complete comparable fields; retain this value with each receipt.

    Compare against the first A receipt separately for each mediaMode. In BA
    order, retain the first B fingerprint until A arrives, then compare it too.
    Store both values on mismatch instead of retaining only a digest. Timings
    and UUID-bearing storage file paths are intentionally excluded.
    """
    def require(condition, label):
        if not condition:
            raise ValueError(f"Invalid semantic receipt: {label}")

    def record(value, label):
        require(isinstance(value, dict), label)
        return value

    def integer(value, label, minimum=0):
        require(type(value) is int and minimum <= value <= 9007199254740991, label)
        return value

    def sha256(value, label):
        require(isinstance(value, str) and len(value) == 64 and
                all(char in "0123456789abcdef" for char in value), label)
        return value

    summary = record(summary, "summary")
    require(type(summary.get("schemaVersion")) is int and summary["schemaVersion"] == 3,
            "summary.schemaVersion")
    require(summary.get("dictionary") in ("jmdict", "jitendex", "vndb"), "dictionary")
    mode = summary.get("mediaCheck")
    require(mode in ("sample", "all"), "mediaCheck")
    runs = summary.get("runs")
    require(isinstance(runs, list) and len(runs) == 1, "exactly one run")
    validation = record(record(runs[0], "run").get("validation"), "validation")
    fixture = record(summary.get("fixture"), "fixture")
    fixture_sha = sha256(fixture.get("sha256"), "fixture.sha256")
    term_rows = integer(fixture.get("termRows"), "fixture.termRows", 1)
    media_files = integer(fixture.get("mediaFiles"), "fixture.mediaFiles")
    media_bytes = integer(fixture.get("mediaBytes"), "fixture.mediaBytes")
    identity = {"title": fixture.get("expectedTitle"), "revision": fixture.get("revision"),
                "termRows": term_rows, "contentReadable": True, "probeCount": 12}
    require(all(isinstance(identity[key], str) and identity[key] for key in ("title", "revision")),
            "fixture title/revision")
    restart = record(validation.get("restart"), "restart")
    for key, value in identity.items():
        require(type(validation.get(key)) is type(value) and validation[key] == value,
                f"validation.{key}")
        require(type(restart.get(key)) is type(value) and restart[key] == value,
                f"restart.{key}")
    require(integer(restart.get("mediaFiles"), "restart.mediaFiles") == media_files,
            "restart.mediaFiles differs from fixture")

    terms = validation.get("probeTerms")
    require(isinstance(terms, list) and len(terms) == 12 and
            all(isinstance(term, str) and term for term in terms), "probeTerms")
    require(len(set(terms)) == 12, "duplicate probeTerms")
    output_digest = sha256(validation.get("outputDigestSha256"), "outputDigestSha256")
    rows = record(validation.get("lookup"), "lookup").get("observations")
    require(isinstance(rows, list) and len(rows) == 72, "72 lookup observations")
    lookup_tuples = []
    seen = set()
    for raw in rows:
        row = record(raw, "lookup observation")
        pass_index = integer(row.get("pass"), "lookup.pass")
        term = row.get("term")
        require(pass_index < 6 and isinstance(term, str) and term in terms, "lookup pass/term")
        key = (pass_index, term)
        require(key not in seen, "duplicate lookup pass/term")
        seen.add(key)
        results = integer(row.get("results"), "lookup.results", 1)
        original_length = integer(row.get("originalTextLength"), "lookup.originalTextLength", 1)
        # Match JavaScript String.length, including supplementary characters.
        require(original_length == len(term.encode("utf-16-le", errors="surrogatepass")) // 2,
                "lookup.originalTextLength differs from term")
        require(row.get("hasExactHeadwordMatch") is True, "lookup.hasExactHeadwordMatch")
        row_digest = sha256(row.get("sha256"), "lookup.sha256")
        lookup_tuples.append([pass_index, term, results, original_length, True, row_digest])
    require(seen == {(index, term) for index in range(6) for term in terms},
            "complete lookup pass/term coverage")
    lookup_tuples.sort(key=lambda row: (row[0], row[1]))

    media = record(validation.get("media"), "media")
    expected_files = media_files if mode == "all" else min(media_files, 64)
    expected_media = {"mode": mode, "totalFiles": media_files, "totalBytes": media_bytes,
                      "files": expected_files}
    for key, value in expected_media.items():
        require(type(media.get(key)) is type(value) and media[key] == value, f"media.{key}")
    checked_bytes = integer(media.get("bytes"), "media.bytes")
    require(checked_bytes <= media_bytes and (expected_files == 0 or checked_bytes > 0),
            "media.bytes bounds")
    require(mode != "all" or checked_bytes == media_bytes, "exhaustive media.bytes")
    media_digest = sha256(media.get("sha256"), "media.sha256")
    require(expected_files != 0 or (checked_bytes == 0 and media_digest ==
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            "empty media bytes/digest")
    storage_bytes = integer(record(validation.get("storage"), "storage").get("bytes"),
                            "storage.bytes", 1)
    return {
        "dictionary": summary["dictionary"], "fixtureSha256": fixture_sha,
        "mediaMode": mode, "identity": identity,
        "probeTerms": list(terms), "outputDigestSha256": output_digest,
        # Each tuple: pass, term, results, originalTextLength, exactMatch, sha256.
        "lookupTuples": lookup_tuples, "storageBytes": storage_bytes,
        "media": {**expected_media, "bytes": checked_bytes, "sha256": media_digest},
        "restartMediaFiles": media_files,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-root", type=Path, required=True)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--baseline-sha", required=True)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--dictionary", choices=["jmdict", "jitendex", "vndb"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--initial-order", choices=["AB", "BA"], required=True)
    parser.add_argument("--allowed-member", action="append", required=True)
    args = parser.parse_args()
    own_orphaned_children()
    roots = {"A": args.baseline_root.resolve(), "B": args.candidate_root.resolve()}
    expected = {"A": args.baseline_sha, "B": args.candidate_sha}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    packages = {arm: package(root) for arm, root in roots.items()}
    changed = sorted(name for name in packages["A"]["entries"].keys() | packages["B"]["entries"].keys()
                     if packages["A"]["entries"].get(name) != packages["B"]["entries"].get(name))
    if changed != sorted(args.allowed_member):
        raise RuntimeError(f"Unexpected package changes: {changed}")
    shared = ["package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/import-benchmark.js",
              "dev/perf/benchmark-support.js", "test/chromium/extension-two-dictionary-import.e2e.js"]
    shared_hashes = {}
    for name in shared:
        contents = [(root / name).read_bytes() for root in roots.values()]
        if contents[0] != contents[1]:
            raise RuntimeError(f"Source arms have different shared inputs: {name}")
        shared_hashes[name] = digest(contents[0])
    source = {}
    for arm, root in roots.items():
        if git(root, "rev-parse", "HEAD") != expected[arm]:
            raise RuntimeError(f"Source revision changed: {arm}")
        dirty = git(root, "diff", "HEAD", "--name-only").splitlines()
        if any(name != "ext/legal-npm.html" for name in dirty):
            raise RuntimeError(f"Unexpected tracked build changes in {arm}: {dirty}")
        source[arm] = {"sha": expected[arm], "tree": git(root, "rev-parse", "HEAD^{tree}"),
                       "trackedStatus": git(root, "status", "--porcelain", "--untracked-files=no"),
                       "legalPageSha256": digest((root / "ext/legal-npm.html").read_bytes())}
    if source["A"]["legalPageSha256"] != source["B"]["legalPageSha256"]:
        raise RuntimeError("Arms have different generated license pages")
    fixture = json.loads((roots["A"] / shared[1]).read_text())["dictionaries"][args.dictionary]
    plan = schedule(args.initial_order == "BA")
    campaign = json.loads(Path(__file__).with_name("import-source-screen-plan.json").read_text())
    candidate = next((item for item in campaign["candidates"] if item["sha"] == args.candidate_sha), None)
    if (campaign["baseline"] != args.baseline_sha or candidate is None or
            sorted(candidate["changedPackageMembers"]) != sorted(args.allowed_member)):
        raise RuntimeError("Arguments differ from frozen campaign plan")
    protocol = {"schemaVersion": 1, "dictionary": args.dictionary, "fixture": fixture,
                "campaignPlan": campaign, "runnerSha256": digest(Path(__file__).read_bytes()),
                "sources": source, "packages": packages, "sharedInputHashes": shared_hashes,
                "schedule": plan, "browserVersion": "153.0.8010.12", "nodeVersion": "v22.22.0",
                "timingBoundary": "browser file-input change through post-UI import-complete event",
                "controls": "A and C use the exact same baseline release ZIP; fresh browser profiles every observation",
                "separateValidation": "both arms receive exhaustive media verification after timing",
                "semanticEquality": "compare complete deterministic receipts to the first A separately for sample/all media modes",
                "failurePolicy": "stop on any failed observation; retain every acquired receipt and all mismatch details; no selective replacement",
                "memoryQualification": "not measured by this timing screen",
                "host": {"uname": list(os.uname()), "cpuCount": os.cpu_count(),
                         "node": subprocess.check_output(["node", "--version"], text=True).strip()}}
    if protocol["host"]["node"] != protocol["nodeVersion"]:
        raise RuntimeError("Node version does not match frozen protocol")
    save(output / "protocol.json", protocol)
    observations = []
    baseline_fingerprints = {}
    for ordinal, (kind, pair, arm) in enumerate(plan):
        product = "A" if arm == "C" else arm
        root = roots[product]
        label = f"{ordinal:02d}-{kind}-{pair:02d}-{arm}"
        destination = output / label
        if git(root, "rev-parse", "HEAD") != expected[product] or digest((root / "builds/manabitan-chrome.zip").read_bytes()) != packages[product]["sha256"]:
            raise RuntimeError("Frozen source or package changed during acquisition")
        if (git(root, "status", "--porcelain", "--untracked-files=no") != source[product]["trackedStatus"] or
                digest((root / "ext/legal-npm.html").read_bytes()) != source[product]["legalPageSha256"] or
                any(digest((root / name).read_bytes()) != expected_hash for name, expected_hash in shared_hashes.items())):
            raise RuntimeError("Frozen build inputs or measurement helpers changed during acquisition")
        command = ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                   "--build-target", "chrome", "--media-check", "all" if kind == "validation" else "sample",
                   "--output", str(destination)]
        observation = {"label": label, "kind": kind, "pair": pair, "arm": arm, "durationMs": None,
                       "processFailure": True}
        started = time.monotonic()
        try:
            with (output / f"{label}.log").open("w") as log:
                process = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    exit_code = process.wait(timeout=1800 if args.dictionary == "vndb" else 600)
                except subprocess.TimeoutExpired:
                    observation["timedOut"] = True
                    observation["cleanup"] = clean_owned_children()
                    process.wait()
                    raise
            observation["exitCode"] = exit_code
            observation["cleanup"] = clean_owned_children()
            if exit_code != 0:
                raise RuntimeError(f"Import runner exited {exit_code}")
            observation["processFailure"] = False
            summary = json.loads((destination / "summary.json").read_text())
            run, = summary["runs"]
            if (summary["gitSha"] != expected[product] or summary["fixture"]["sha256"] != fixture["sha256"] or
                    summary["browserVersion"] != protocol["browserVersion"] or run["packageSha256"] != packages[product]["sha256"] or
                    summary["traceEnabled"] or not summary["authoritativeTiming"]):
                raise RuntimeError("Observation identity differs from frozen protocol")
            duration = run["totalImportMs"]
            if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
                raise RuntimeError("Invalid browser timing")
            observation["durationMs"] = duration
            fingerprint = semantic_fingerprint(summary)
            observation["semanticFingerprint"] = fingerprint
            mode = fingerprint["mediaMode"]
            if arm == "A" and mode not in baseline_fingerprints:
                baseline_fingerprints[mode] = fingerprint
            if mode in baseline_fingerprints:
                for receipt in [*observations, observation]:
                    actual = receipt.get("semanticFingerprint")
                    if actual is not None and actual["mediaMode"] == mode and actual != baseline_fingerprints[mode]:
                        receipt["error"] = "Deterministic semantic output differs from the first baseline A receipt"
                        receipt["expectedSemanticFingerprint"] = baseline_fingerprints[mode]
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
            observation["error"] = str(error)
        observation["wallSeconds"] = time.monotonic() - started
        observations.append(observation)
        save(output / "observations.json", observations)
        print(json.dumps(observation), flush=True)
        failures = [item for item in observations if "error" in item]
        if failures:
            save(output / "comparison.json", {"complete": len(observations) == len(plan), "failed": len(failures),
                                               "stoppedAt": label, "reason": failures[0]["error"]})
            raise RuntimeError("Cohort stopped after a failed observation; no qualification")
    summary = {"complete": len(observations) == len(plan), "failed": sum("error" in item for item in observations)}
    for kind, arms in [("candidate", "AB"), ("control", "AC")]:
        matching = [item for item in observations if item["kind"] == kind]
        if any("error" in item for item in matching):
            summary[kind] = None
            continue
        grouped = {}
        for item in matching:
            grouped.setdefault(item["pair"], {})[item["arm"]] = item["durationMs"]
        summary[kind] = effects([(pair[arms[0]], pair[arms[1]]) for pair in grouped.values()])
    save(output / "comparison.json", summary)
    if summary["failed"]:
        raise RuntimeError("One or more scheduled observations failed; no qualification")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
