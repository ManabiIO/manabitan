#!/usr/bin/env python3
"""Independently audit frozen browser receipts, or preserve raw evidence bytes."""

import argparse
from collections import Counter
import hashlib
import io
import json
import math
from pathlib import Path
import random
import statistics
import tarfile
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def compare(pairs):
    changes = [100 * (candidate / baseline - 1) for baseline, candidate in pairs]
    randomizer = random.Random(20261123)
    bootstrap = sorted(statistics.median(randomizer.choices(changes, k=len(changes))) for _ in range(5000))
    return {
        "pairs": len(pairs), "pairedPercentChanges": changes,
        "medianPairedPercent": statistics.median(changes),
        "equalWorkPercent": 100 * (sum(row[1] for row in pairs) / sum(row[0] for row in pairs) - 1),
        "fasterPairs": sum(change < 0 for change in changes),
        "worstPairPercent": max(changes),
        "descriptiveBootstrap95": [bootstrap[124], bootstrap[4874]],
    }


def audit_cell(root, published):
    preparation = read_json(root / "preparation.json")
    config = read_json(root / "config.json")
    complete = read_json(root / "cohort-complete.json")
    observations = read_json(root / "observations.json")
    schedule = read_json(root / "schedule.json")
    analysis = read_json(root / "analysis.json")
    case_id, direction = preparation["case"], preparation["direction"]
    require(direction in ("forward", "reverse"), "Invalid direction")
    require(preparation["dictionary"] == config["cases"][case_id]["dictionary"], "Case/dictionary binding mismatch")
    for name in ("observations", "schedule", "preparation", "config"):
        require(digest((root / (name + ".json")).read_bytes()) == complete[name + "Sha256"], "Receipt mismatch: " + name)
    for key in ("case", "dictionary", "direction"):
        require(preparation[key] == complete[key] == analysis[key], "Cell identity mismatch")
    require(analysis["complete"] is True and not any((root / name).exists() for name in ("run-failure.json", "prepare-failure.json")), "Incomplete cohort")
    require(len(observations) == len(schedule) == 42, "Unexpected observation count")
    require([{key: row[key] for key in expected} for row, expected in zip(observations, schedule, strict=True)] == schedule,
            "Observation order differs from frozen schedule")
    require(len({row["name"] for row in observations}) == 42, "Duplicate observations")
    warmups, measured = observations[:6], observations[6:]
    require(all(row["warmup"] and row["kind"] == "warmup" for row in warmups), "Invalid warmup boundary")
    require("".join(row["arm"] for row in warmups) == ("ABCABC" if direction == "forward" else "CBACBA"), "Warmup order changed")
    require(all(not row["warmup"] for row in measured), "Excluded measured observation")
    require(Counter(row["arm"] for row in measured) == {"A": 18, "B": 12, "C": 6}, "Arm counts changed")
    pairs = {"candidate": [], "control": []}
    for index in range(0, 36, 2):
        rows = measured[index:index + 2]
        kind = "control" if (index // 2) % 3 == 2 else "candidate"
        number = len(pairs[kind]) + 1
        other = "B" if kind == "candidate" else "C"
        order = "A" + other if (number % 2 == 1) == (direction == "forward") else other + "A"
        require(all(row["kind"] == kind and row["block"] == number and row["order"] == order for row in rows), "Pair boundary changed")
        require("".join(row["arm"] for row in rows) == order, "Pair order changed")
        arms = {row["arm"]: row for row in rows}
        pairs[kind].append((arms["A"]["totalImportMs"], arms[other]["totalImportMs"]))
    research = root / "research-sources"
    source = research / "dev/perf/import-r2-qualification-20261123.py"
    source_config = source.with_suffix(".json")
    require(digest(source.read_bytes()) == preparation["runnerSha256"], "Runner provenance mismatch")
    require(digest(source_config.read_bytes()) == preparation["configSha256"] and read_json(source_config) == config, "Config provenance mismatch")
    require((root / "research-sha.txt").read_text().strip() == preparation["researchSha"], "Research source mismatch")
    require((root / "research-tree.txt").read_text().strip() == preparation["researchTree"], "Research tree mismatch")
    identities = preparation["identities"]
    require(identities["A"]["sha"] == config["baseline"] and identities["B"]["sha"] == config["cases"][case_id]["sha"], "Runtime refs changed")
    require(identities["A"]["overlaySha256"] == identities["B"]["overlaySha256"], "Asymmetric harness overlay")
    for name, expected in identities["A"]["overlaySha256"].items():
        require(digest((root / "overlay" / name).read_bytes()) == expected, "Overlay bytes changed: " + name)
    maps = {arm: read_json(root / ("package-entries-" + arm + ".json")) for arm in "ABC"}
    require(maps["A"] == maps["C"], "Same-code package differs")
    changed = sorted(name for name in maps["A"].keys() | maps["B"].keys() if maps["A"].get(name) != maps["B"].get(name))
    require(changed == sorted(config["cases"][case_id]["packageDifferences"]) == preparation["packageDifferences"] == read_json(root / "package-differences.json"), "Unexpected packaged change")
    for arm in ("A", "B"):
        expected_source = published["runtimes"][identities[arm]["sha"]]
        require(expected_source["tree"] == identities[arm]["tree"], "Published tree differs from built runtime")
        for name in changed:
            require(maps[arm][name] == expected_source["files"][name]["sha256"], "Allowed package entry differs from exact published blob: " + name)
    fixture = preparation["fixture"]
    lock = read_json(root / "overlay/test/perf/dictionaries.lock.json")
    require(fixture == lock["dictionaries"][preparation["dictionary"]], "Prepared fixture differs from frozen overlay lock")
    require(preparation["fixtures"][preparation["dictionary"]] == {key: fixture[key] for key in ("sha256", "sizeBytes")}, "Downloaded fixture receipt differs from lock")
    expected_work = None
    expected_output = None
    for row in observations:
        require(row["status"] == "success", "Failed observation")
        require(math.isfinite(row["totalImportMs"]) and row["totalImportMs"] > 0, "Invalid duration")
        folder = root / "observations" / row["name"]
        summary, report = read_json(folder / "summary.json"), read_json(folder / "run-1.json")
        identity = identities["A" if row["arm"] == "C" else row["arm"]]
        require(summary["fixture"] == fixture and summary["gitSha"] == identity["sha"], "Fixture or runtime source changed")
        require(summary["dictionary"] == preparation["dictionary"] and summary["buildTarget"] == "chrome", "Wrong workload")
        require(summary["authoritativeTiming"] is True and summary["traceEnabled"] is False and summary["importFlags"] is None, "Timing controls changed")
        require(report["status"] == "success" and report["skippedVerification"] is False, "Browser verification failed")
        require(all(report["benchmark"][key] is False for key in ("phaseProfiling", "phaseScreenshots", "processSampling")), "Instrumented observation")
        require(summary["browserVersion"] == report["browserVersion"] == row["browserVersion"] == preparation["runtime"]["browserVersion"], "Browser version changed")
        require(summary["hostEnvironment"]["nodeVersion"] == preparation["runtime"]["node"], "Node version changed")
        hashes = summary["source"]["sha256"]
        require(hashes["builds/manabitan-chrome.zip"] == identity["packageSha256"] == row["packageSha256"], "Package provenance mismatch")
        require(hashes["package-lock.json"] == identity["packageLockSha256"] and all(hashes[name] == expected for name, expected in identity["overlaySha256"].items()), "Lock or harness provenance mismatch")
        require(len(summary["runs"]) == 1, "Unexpected import count")
        run = summary["runs"][0]
        require(run["totalImportMs"] == row["totalImportMs"] and run["packageSha256"] == row["packageSha256"], "Raw duration/package mismatch")
        phases = [phase["data"] for phase in report["phases"] if isinstance(phase.get("data"), dict) and phase["data"].get("kind") == "dictionary-import"]
        require(len(phases) == 1, "Ambiguous browser timing phase")
        timing, debug = phases[0]["browserTiming"], phases[0]["importDebug"]
        require(timing["trigger"] == "file-input-change" and timing["sequence"] == timing["sequenceBefore"] + 1 and timing["errorCount"] == 0, "Wrong browser operation or failed import")
        require(all(type(timing[key]) in (int, float) and math.isfinite(timing[key]) for key in ("startedAtMs", "completedAtMs")), "Invalid browser clock")
        require(0 <= timing["startedAtMs"] < timing["completedAtMs"], "Non-monotonic browser clock")
        # The harness records a later animation-frame opportunity only if it
        # happens before readback. It is not the declared completion boundary.
        next_frame = timing["nextFrameAtMs"]
        require(next_frame is None or (type(next_frame) in (int, float) and math.isfinite(next_frame) and next_frame >= timing["completedAtMs"]), "Invalid optional next-frame clock")
        require(timing["completedAtMs"] - timing["startedAtMs"] == row["totalImportMs"], "Raw browser duration mismatch")
        require(debug == run["importDebug"] and debug["usesFallbackStorage"] is False and debug["errorCount"] == debug["addSettingsErrorCount"] == 0, "Storage path or import errors differ")
        require(debug["useImportSession"] is True and debug["finalizeImportSession"] is True, "Import session policy changed")
        validation = report["benchmark"]["validation"]
        for check in (validation, validation["restart"]):
            require(check["title"] == fixture["expectedTitle"] and check["revision"] == fixture["revision"] and check["termRows"] == fixture["termRows"], "Persisted metadata mismatch")
            require(check["contentReadable"] is True and check["probeCount"] == 12, "Missing restart/readback coverage")
        output = validation["outputDigestSha256"]
        require(output == row["outputDigestSha256"] and len(output) == 64, "Persisted probe digest mismatch")
        phases = run["importDebug"]["importerPhaseTimings"]
        parsing = [phase["details"] for phase in phases if phase["phase"].startswith("term-file-fast-path:")]
        final = [phase["details"] for phase in phases if phase["phase"] == "bulk-finalization"]
        require(parsing and len(final) == 1 and final[0]["published"] is True, "Missing publication/native receipt")
        require(all(part["parserParallelWorkerCount"] == 3 and part["parserFusedFallbacks"] == part["dedupNativeFallbackCount"] == 0 for part in parsing), "Native path or worker policy changed")
        work = {key: sum(part[key] for part in parsing) for key in ("rows", "chunkCount", "parserFusedAttempts", "parserBankSpanCount", "parserSourceCompressedBytes", "parserSourceUncompressedBytes")}
        work.update({key: final[0][key] for key in ("termContentTotalWriteBytes", "termRecordTotalWriteBytes", "termRecordLookupIndexWriteBytes")})
        require(all(type(value) is int and value > 0 for value in work.values()) and work["rows"] == fixture["termRows"], "Invalid work totals")
        require(work == row["workReceipt"], "Derived work receipt mismatch")
        if expected_work is None:
            expected_work, expected_output = work, output
        require(work == expected_work and output == expected_output, "Work, persisted bytes, or probe results differ between arms")
    calculated = {"candidateVsBaseline": compare(pairs["candidate"]), "sameCodeControl": compare(pairs["control"])}
    for key, value in calculated.items():
        require(value == analysis[key], "Analysis arithmetic mismatch: " + key)
    return {"case": case_id, "dictionary": preparation["dictionary"], "direction": direction,
            "imports": len(observations), "warmups": 6, "measured": 36,
            "baseline": identities["A"], "candidate": identities["B"], "researchSha": preparation["researchSha"],
            "fixture": fixture, "work": expected_work, "sampledOutputSha256": expected_output, **calculated}


def audit_browser(root, output, expected_cases, published_path):
    require(expected_cases and len(set(expected_cases)) == len(expected_cases), "Declare each expected case exactly once")
    expected = {"import-r2-qualification-" + case + "-" + direction for case in expected_cases for direction in ("forward", "reverse")}
    cells = sorted(path for path in root.iterdir() if path.is_dir() and path.name.startswith("import-r2-qualification-"))
    require({path.name for path in cells} == expected, "Missing or unexpected browser cells")
    published = read_json(published_path)
    results = [audit_cell(cell, published) for cell in cells]
    require(len({(row["case"], row["direction"]) for row in results}) == len(results), "Duplicate cells")
    require({(row["case"], row["direction"]) for row in results} == {(case, direction) for case in expected_cases for direction in ("forward", "reverse")}, "Audited identities differ from requested case roster")
    write_json(output, {"schemaVersion": 1, "auditorSha256": digest(Path(__file__).read_bytes()),
                       "expectedCases": expected_cases, "publishedSourceManifestSha256": digest(published_path.read_bytes()),
                       "imports": sum(row["imports"] for row in results), "cells": results,
                       "scope": "Source/package/native-work identities, complete fixed schedules, raw durations, restart guards and stored probe digests; probes are sampled, not exhaustive semantic readback."})
    print(json.dumps({"verifiedCells": len(results), "verifiedImports": sum(row["imports"] for row in results)}))


def freeze(specification, output):
    require(not output.exists(), "Evidence destination must be new")
    output.mkdir(parents=True)
    members = {}
    transports = []
    for entry in read_json(specification):
        root, label = Path(entry["path"]), entry["label"]
        require(root.is_dir() and label and "/" not in label and label not in (".", ".."), "Invalid evidence root")
        for file in sorted(root.rglob("*")):
            require(not file.is_symlink(), "Evidence cannot contain symlinks")
            if not file.is_file():
                continue
            relative = file.relative_to(root)
            name = label + "/" + relative.as_posix()
            data = file.read_bytes()
            if file.suffix == ".zip" and len(relative.parts) == 1:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    names = [item.filename for item in archive.infolist() if not item.is_dir()]
                    require(len(names) == len(set(names)), "Duplicate transport ZIP members")
                    inventory = []
                    for member in names:
                        require(not Path(member).is_absolute() and ".." not in Path(member).parts, "Unsafe transport member")
                        original = archive.read(member)
                        expanded = root / file.stem / member
                        require(expanded.is_file() and expanded.read_bytes() == original, "Expanded transport bytes differ")
                        inventory.append({"path": member, "bytes": len(original), "sha256": digest(original)})
                    transports.append({"path": name, "bytes": len(data), "sha256": digest(data), "members": inventory})
                continue
            require(name not in members, "Duplicate evidence path")
            members[name] = {"file": file, "bytes": len(data), "sha256": digest(data)}
    inventory = [{"path": name, "bytes": item["bytes"], "sha256": item["sha256"]} for name, item in sorted(members.items())]
    archive_path = output / "raw-evidence.tar.xz"
    with tarfile.open(archive_path, "w:xz", preset=6) as archive:
        for name, item in sorted(members.items()):
            data = item["file"].read_bytes()
            require(len(data) == item["bytes"] and digest(data) == item["sha256"], "Evidence changed during freezing")
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))
    write_json(output / "raw-members.json", inventory)
    write_json(output / "original-zips.json", transports)
    write_json(output / "manifest.json", {"schemaVersion": 1,
               "archive": {"name": archive_path.name, "bytes": archive_path.stat().st_size, "sha256": digest(archive_path.read_bytes())},
               "members": len(inventory), "expandedBytes": sum(row["bytes"] for row in inventory),
               "memberIndexSha256": digest((output / "raw-members.json").read_bytes()),
               "transportIndexSha256": digest((output / "original-zips.json").read_bytes()),
               "packerSha256": digest(Path(__file__).read_bytes())})
    print(json.dumps({"members": len(inventory), "archiveBytes": archive_path.stat().st_size}))


def verify(root):
    manifest = read_json(root / "manifest.json")
    require((root / manifest["archive"]["name"]).stat().st_size == manifest["archive"]["bytes"], "Archive byte length mismatch")
    require(digest((root / manifest["archive"]["name"]).read_bytes()) == manifest["archive"]["sha256"], "Archive digest mismatch")
    require(digest((root / "raw-members.json").read_bytes()) == manifest["memberIndexSha256"], "Member index changed")
    require(digest((root / "original-zips.json").read_bytes()) == manifest["transportIndexSha256"], "Transport index changed")
    expected = {row["path"]: row for row in read_json(root / "raw-members.json")}
    require(len(expected) == manifest["members"], "Member count mismatch")
    require(sum(row["bytes"] for row in expected.values()) == manifest["expandedBytes"], "Expanded byte total mismatch")
    for transport in read_json(root / "original-zips.json"):
        prefix = str(Path(transport["path"]).with_suffix(""))
        names = [member["path"] for member in transport["members"]]
        require(len(names) == len(set(names)), "Duplicate transport inventory")
        for member in transport["members"]:
            name = prefix + "/" + member["path"]
            require(name in expected and all(expected[name][key] == member[key] for key in ("bytes", "sha256")), "Transport inventory differs from archived expanded bytes")
    seen = set()
    with tarfile.open(root / manifest["archive"]["name"], "r:xz") as archive:
        for member in archive:
            require(not Path(member.name).is_absolute() and ".." not in Path(member.name).parts, "Unsafe archive member path")
            require(member.isfile() and member.name not in seen and member.name in expected, "Unexpected archive member")
            data = archive.extractfile(member).read()
            require(len(data) == expected[member.name]["bytes"] and digest(data) == expected[member.name]["sha256"], "Member changed")
            seen.add(member.name)
    require(seen == expected.keys(), "Missing archive members")
    print(json.dumps({"verifiedMembers": len(seen), "archiveSha256": manifest["archive"]["sha256"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("audit-browser", "freeze", "verify"))
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--expected-cases", help="Comma-separated complete browser case roster; both directions are required")
    parser.add_argument("--published-sources", type=Path, help="Exact published tree/blob identities for both runtime arms")
    args = parser.parse_args()
    if args.mode == "audit-browser":
        require(args.output is not None, "--output is required")
        require(args.expected_cases is not None, "--expected-cases is required for a complete-run audit")
        require(args.published_sources is not None, "--published-sources is required")
        audit_browser(args.source, args.output, args.expected_cases.split(","), args.published_sources)
    elif args.mode == "freeze":
        require(args.output is not None, "--output is required")
        freeze(args.source, args.output)
    else:
        verify(args.source)


if __name__ == "__main__":
    main()
