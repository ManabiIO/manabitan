"""Immutable inputs shared by separate round-three timing and memory studies."""

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time
import zipfile

from readback import validate_readback


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
OVERLAY = (
    "test/perf/dictionaries.lock.json",
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/import-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
)


def run(args, cwd=ROOT, output=None):
    if output is None:
        subprocess.run(args, cwd=cwd, check=True)
    else:
        with output.open("x") as stream:
            subprocess.run(args, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, check=True)


def text(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(filename):
    hasher = hashlib.sha256()
    with filename.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def save(filename, value):
    with filename.open("x") as stream:
        stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")


def configuration():
    dictionary = os.environ["PERF_DICTIONARY"]
    replication = int(os.environ["PERF_REPLICATION"])
    if dictionary not in ("jmdict", "jitendex", "vndb") or replication not in (1, 2):
        raise ValueError("Unexpected corpus or replication")
    return dictionary, replication, json.loads((SOURCE / "candidates.json").read_text())


def prepare(mode, name, arms, package_rules, schedule, extra_plan):
    dictionary, replication, _ = configuration()
    for sha in arms.values():
        if len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha):
            raise ValueError("Expected immutable source SHA")
        run(["git", "cat-file", "-e", sha + "^{commit}"])
    if len(set(arms.values())) != len(arms):
        raise ValueError("Study arms must name distinct commits")
    evidence = ROOT / "builds/import-round3-study" / mode / name / dictionary / str(replication)
    evidence.mkdir(parents=True, exist_ok=False)
    stage = Path(os.environ["RUNNER_TEMP"]) / f"import-round3-71149-{mode}-{name}-{dictionary}-{replication}"
    stage.mkdir(exist_ok=False)
    fixture = json.loads((ROOT / OVERLAY[0]).read_text())["dictionaries"][dictionary]
    overlay_hashes = {name: digest(ROOT / name) for name in OVERLAY}
    plan = {
        "schemaVersion": 1, "mode": mode, "name": name,
        "authoritativeTiming": mode == "timing", "arms": arms,
        "harnessCommit": text(["git", "rev-parse", "HEAD"]),
        "harnessTree": text(["git", "rev-parse", "HEAD^{tree}"]),
        "node": text(["node", "--version"]), "host": platform.uname()._asdict(),
        "dictionary": dictionary, "fixture": fixture, "replication": replication,
        "schedule": schedule, "overlaidHarnessFiles": overlay_hashes,
        "studySourceHashes": {p.name: digest(p) for p in SOURCE.iterdir() if p.suffix in (".py", ".json", ".md")},
        "expectedPackageRules": package_rules, **extra_plan,
    }
    save(evidence / "plan.json", plan)
    run(["node", "--input-type=module", "-e", (
        "import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js';"
        "await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache',[process.argv[1]])"
    ), dictionary], output=evidence / "fixtures.log")
    archive = ROOT / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
    if archive.stat().st_size != fixture["sizeBytes"] or digest(archive) != fixture["sha256"]:
        raise ValueError("Pinned archive mismatch")
    roots, packages, package_members = {}, {}, {}
    for arm, sha in arms.items():
        root = stage / arm
        run(["git", "worktree", "add", "--detach", str(root), sha])
        if (root / "package-lock.json").read_bytes() != (ROOT / "package-lock.json").read_bytes():
            raise ValueError("Dependency locks differ")
        for name in OVERLAY:
            shutil.copyfile(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (root / "builds").mkdir(exist_ok=True)
        (root / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
        run(["npm", "run", "build:libs"], root, evidence / f"{arm}-libs.log")
        run(["npm", "run", "build", "--", "--target", "chrome"], root, evidence / f"{arm}-build.log")
        package = root / "builds/manabitan-chrome.zip"
        packages[arm] = digest(package)
        with zipfile.ZipFile(package) as zipped:
            names = [n for n in zipped.namelist() if not n.endswith("/")]
            if len(names) != len(set(names)):
                raise ValueError("Duplicate packaged path")
            package_members[arm] = {name: hashlib.sha256(zipped.read(name)).hexdigest() for name in names}
        save(evidence / f"{arm}-package-entries.json", package_members[arm])
        save(evidence / f"{arm}-identity.json", {
            "sourceCommit": sha, "sourceTree": text(["git", "rev-parse", "HEAD^{tree}"], root),
            "packageSha256": packages[arm],
            "statusWithHarnessOverlay": text(["git", "status", "--porcelain"], root),
        })
        roots[arm] = root
    differences = {}
    for rule in package_rules:
        a, b = (package_members[arm] for arm in (rule["baseline"], rule["candidate"]))
        changed = sorted(name for name in set(a) | set(b) if a.get(name) != b.get(name))
        differences[rule["baseline"] + "-" + rule["candidate"]] = changed
        if changed != sorted(rule["paths"]):
            save(evidence / "failed-package-differences.json", differences)
            raise ValueError("Unexpected packaged source differences")
    save(evidence / "package-differences.json", differences)
    return {"evidence": evidence, "roots": roots, "packages": packages,
            "arms": arms, "fixture": fixture, "archive": archive,
            "overlayHashes": overlay_hashes, "plan": plan, "dictionary": dictionary}


def begin_observation(state, index, arm, name):
    output = state["evidence"] / name
    output.mkdir()
    root, sha = state["roots"][arm], state["arms"][arm]
    if (text(["git", "rev-parse", "HEAD"], root) != sha or
            digest(root / "builds/manabitan-chrome.zip") != state["packages"][arm] or
            digest(state["archive"]) != state["fixture"]["sha256"] or
            {name: digest(root / name) for name in OVERLAY} != state["overlayHashes"]):
        raise ValueError("Immutable inputs changed before observation")
    command = ["node", "dev/perf/import-benchmark.js", state["dictionary"], "--runs", "1", "--no-build",
               "--build-target", "chrome", "--output", str(output)]
    save(output / "identity.json", {
        "authoritativeTiming": state["plan"]["authoritativeTiming"], "index": index, "arm": arm,
        "planSha256": digest(state["evidence"] / "plan.json"), "sourceCommit": sha,
        "sourceTree": text(["git", "rev-parse", "HEAD^{tree}"], root),
        "packageSha256": state["packages"][arm], "fixtureSha256": state["fixture"]["sha256"],
        "overlaidHarnessFiles": state["overlayHashes"], "command": command,
        "startedAtEpochSeconds": time.time(), "loadAverage": os.getloadavg(),
    })
    return output, root, command


def finish_observation(state, output, arm):
    summary = json.loads((output / "summary.json").read_text())
    report = json.loads((output / "run-1.json").read_text())
    if summary["gitSha"] != state["arms"][arm] or len(summary["runs"]) != 1:
        raise ValueError("Wrong source or run count")
    result = summary["runs"][0]
    if (result["packageSha256"] != state["packages"][arm] or
            report["packageSha256"] != state["packages"][arm] or
            digest(state["roots"][arm] / "builds/manabitan-chrome.zip") != state["packages"][arm] or
            digest(state["archive"]) != state["fixture"]["sha256"]):
        raise ValueError("Package or archive identity changed")
    if state["plan"]["authoritativeTiming"] and summary["authoritativeTiming"] is not True:
        raise ValueError("Unexpected instrumented timing")
    if (type(result["totalImportMs"]) not in (int, float) or
            not math.isfinite(result["totalImportMs"]) or result["totalImportMs"] <= 0):
        raise ValueError("Invalid import duration")
    validate_readback(report, result["validation"], state["fixture"])
    return result


def receipt_hashes(output):
    return {p.name: digest(p) for p in output.iterdir() if p.is_file() and p.name != "observation.json"}
