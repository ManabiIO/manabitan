#!/usr/bin/env python3
"""Run a fixed discovery or confirmation schedule; never retry an observation."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import zipfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OVERLAY = (
    "test/perf/dictionaries.lock.json",
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/import-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
)
TIMING_SOURCE = (
    "package-lock.json",
    "test/chromium/import-flags-ab-benchmark.js",
    "test/e2e/import-timing.js",
    "ext/js/pages/settings/dictionary-import-controller.js",
    "ext/js/core/safe-performance.js",
)


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args, cwd=ROOT, log=None, timeout=900):
    if log is None:
        return subprocess.check_output(args, cwd=cwd, text=True, timeout=timeout).strip()
    with log.open("x") as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command exited {result.returncode}; retained log: {log}")


def read_config():
    config = json.loads((HERE / "config.json").read_text())
    if config["schemaVersion"] != 1 or config["stage"] not in ("discovery", "confirmation"):
        raise ValueError("Unknown study configuration")
    for key in ("baseline", "candidate"):
        if not isinstance(config[key], str) or re.fullmatch(r"[a-f0-9]{40}", config[key]) is None:
            raise ValueError(f"Freeze an immutable {key} SHA before launching")
    if config["baseline"] == config["candidate"]:
        raise ValueError("Candidate must differ from baseline")
    expected = config["expectedPackageDifferences"]
    if not expected or expected != sorted(set(expected)):
        raise ValueError("Freeze the sorted, exact packaged-file difference list")
    if config["dictionaries"] != ["jmdict", "jitendex", "vndb"]:
        raise ValueError("Every candidate must retain all three corpus cells")
    if config["stage"] == "confirmation" and not config["confirmationOf"]:
        raise ValueError("Confirmation must name the retained discovery campaign")
    return config


def schedule(stage, replication):
    if stage == "discovery":
        if replication != 1:
            raise ValueError("Discovery has exactly one replication")
        orders = ["ABC", "BCA", "CAB"]
    elif stage == "confirmation" and replication in (1, 2):
        orders = ["ABC", "CBA", "BCA", "ACB", "CAB", "BAC"]
        if replication == 2:
            orders.reverse()
    else:
        raise ValueError("Unknown stage or replication")
    warmups = "ABC" if replication == 1 else "CBA"
    result = [{"name": "warmup-" + arm, "kind": "warmup", "triplet": 0, "arm": arm}
              for arm in warmups]
    result.extend({"name": arm + str(number), "kind": "measured", "triplet": number, "arm": arm}
                  for number, arms in enumerate(orders, 1) for arm in arms)
    return result


def media_reference(archive_path, fixture):
    if fixture.get("mediaRows", 0) == 0 or "mediaProbePaths" not in fixture:
        return None
    with zipfile.ZipFile(archive_path) as archive:
        if fixture.get("mediaProbeMode") == "all-referenced-images":
            references = set()
            for name in archive.namelist():
                if re.fullmatch(r"term_bank_[0-9]+\.json", name) is None:
                    continue
                pending = [json.loads(archive.read(name))]
                while pending:
                    value = pending.pop()
                    if isinstance(value, dict):
                        if value.get("tag") == "img" or value.get("type") == "image":
                            image_path = value.get("path")
                            if not isinstance(image_path, str) or not image_path:
                                raise ValueError("Invalid referenced source image")
                            references.add(image_path)
                        pending.extend(value.values())
                    elif isinstance(value, list):
                        pending.extend(value)
            paths = sorted(references)
            if paths != fixture["mediaProbePaths"] or len(paths) != fixture["mediaRows"]:
                raise ValueError("Locked image probes differ from complete source references")
        else:
            names = [name for name in archive.namelist() if name.endswith(".webp")]
            if len(names) != fixture["mediaRows"]:
                raise ValueError("Locked source-media count differs")
            paths = list(dict.fromkeys([names[0], names[len(names) // 3], names[len(names) * 2 // 3],
                                       names[-1], *fixture["mediaProbePaths"]]))
        return [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                for name in paths for data in [archive.read(name)]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", action="store_true")
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"))
    parser.add_argument("--replication", type=int, choices=(1, 2))
    args = parser.parse_args()
    config = read_config()
    if args.matrix:
        replications = [1] if config["stage"] == "discovery" else [1, 2]
        print(json.dumps({"include": [{"dictionary": name, "replication": replication}
                                     for name in config["dictionaries"] for replication in replications]}))
        return
    if args.dictionary is None or args.replication is None:
        parser.error("--dictionary and --replication are required")
    order = schedule(config["stage"], args.replication)
    evidence = ROOT / "builds/import-study-20261123" / args.dictionary / str(args.replication)
    evidence.mkdir(parents=True, exist_ok=False)
    node = command(["node", "--version"])
    if node != "v22.22.0":
        raise ValueError("The study is pinned to Node.js 22.22.0")
    fixture = json.loads((ROOT / OVERLAY[0]).read_text())["dictionaries"][args.dictionary]
    sources = [*OVERLAY, *TIMING_SOURCE,
               "dev/perf/import-study-20261123/run.py", "dev/perf/import-study-20261123/verify.mjs",
               "dev/perf/import-study-20261123/config.json"]
    plan = {"schemaVersion": 1, "config": config, "dictionary": args.dictionary,
            "replication": args.replication, "schedule": order, "fixture": fixture,
            "nodeVersion": node, "harnessSha": command(["git", "rev-parse", "HEAD"]),
            "workflowRun": os.environ.get("GITHUB_RUN_ID"), "workflowAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "sourceFiles": {name: digest(ROOT / name) for name in sources},
            "boundary": "file-input change through post-UI completion; restart and readback excluded",
            "scope": "Ordinary production-default Chromium imports; no trace or process sampling"}
    save(evidence / "plan.json", plan)
    for name in sources:
        target = evidence / "source" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    stage = Path(tempfile.mkdtemp(prefix="import-study-", dir=os.environ.get("RUNNER_TEMP")))
    try:
        command(["node", "--input-type=module", "-e",
                 "import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js'; "
                 "await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache',[process.argv[1]])",
                 args.dictionary], log=evidence / "fixtures.log")
        archive = ROOT / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        if archive.stat().st_size != fixture["sizeBytes"] or digest(archive) != fixture["sha256"]:
            raise ValueError("Fixture bytes differ from the lock")
        save(evidence / "media-reference.json", media_reference(archive, fixture))
        roots = {}
        identities = {}
        packages = {}
        for arm, sha in (("A", config["baseline"]), ("B", config["candidate"])):
            source = stage / arm
            command(["git", "worktree", "add", "--detach", str(source), sha], log=evidence / (arm + "-checkout.log"))
            for name in TIMING_SOURCE:
                if digest(source / name) != plan["sourceFiles"][name]:
                    raise ValueError("Timing/dependency source changed: " + name)
            for name in OVERLAY:
                shutil.copyfile(ROOT / name, source / name)
            (source / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
            (source / "builds").mkdir(exist_ok=True)
            (source / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
            for name, script in (("libs", "build:libs"), ("license", "license-report:html"), ("build", "build")):
                arguments = ["npm", "run", script]
                if name == "build":
                    arguments += ["--", "--target", "chrome"]
                command(arguments, cwd=source, log=evidence / f"{arm}-{name}.log")
            package = source / "builds/manabitan-chrome.zip"
            with zipfile.ZipFile(package) as archive_zip:
                packages[arm] = {entry.filename: hashlib.sha256(archive_zip.read(entry)).hexdigest()
                                 for entry in archive_zip.infolist() if not entry.is_dir()}
            save(evidence / (arm + "-package-entries.json"), packages[arm])
            identities[arm] = {"sha": sha, "packageSha256": digest(package),
                               "statusWithHarnessOverlay": command(["git", "status", "--porcelain"], cwd=source)}
            save(evidence / (arm + "-identity.json"), identities[arm])
            roots[arm] = source
        differences = sorted(name for name in packages["A"].keys() | packages["B"].keys()
                             if packages["A"].get(name) != packages["B"].get(name))
        save(evidence / "package-differences.json", differences)
        if differences != config["expectedPackageDifferences"]:
            raise ValueError("Unexpected packaged product differences: " + repr(differences))
        for observation in order:
            output = evidence / observation["name"]
            output.mkdir()
            source = roots["B" if observation["arm"] == "B" else "A"]
            print(f"{args.dictionary}: {observation['name']}", flush=True)
            command(["node", "dev/perf/host-environment.js"], log=output / "host-before.json")
            started = time.time()
            try:
                command(["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                         "--build-target", "chrome", "--output", str(output)], cwd=source, log=output / "run.log")
            finally:
                save(output / "acquisition.json", {**observation, "startedEpochSeconds": started,
                                                   "endedEpochSeconds": time.time()})
                command(["node", "dev/perf/host-environment.js"], log=output / "host-after.json")
        command(["node", str(HERE / "verify.mjs"), str(evidence)], log=evidence / "verification.log")
        print((evidence / "result.json").read_text(), flush=True)
    except BaseException as error:
        save(evidence / "failure.json", {"type": type(error).__name__, "message": str(error),
                                        "recordedAtEpochSeconds": time.time(), "retried": False})
        raise


if __name__ == "__main__":
    main()
