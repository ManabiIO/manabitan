#!/usr/bin/env python3
"""Independent, read-only audit of retained import-screen artifacts."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import subprocess
import tarfile
import tempfile


BASE = "3d65e403c644b9a5a6be3128d72f9d30050b70e0"
ORDERS = ["ABC", "CBA", "BCA", "ACB", "CAB", "BAC"]
STUDIES = {
    "filename-arena": {
        "study": "79c8d64063747f36e4b48cbb7b588845c268eac7",
        "candidate": "4737f9e05eb8600d926843bfc32675bd214a8bb1",
        "run": 45262851083,
        "changed": ["js/dictionary/dense-zip-directory.js"],
    },
    "media-ranges": {
        "study": "3e7343d9baa307552dc8f60fd5731dc2a212ec21",
        "candidate": "2da6e38c204e1bb22c5835f8f53f867e872b7296",
        "run": 45263267064,
        "changed": ["js/dictionary/term-bank-source-pipeline.js"],
    },
    "utf8-loop": {
        "study": "d977051ec6f3c0ee0ed2320d92c9683cffda56ff",
        "candidate": "cb9f241106ab1529fa21c112f1733849c188511c",
        "run": 45266391385,
        "changed": ["js/dictionary/wasm/term-bank-parser.c", "lib/term-bank-parser.wasm"],
    },
    "media-adjacent": {
        "study": "0fe2f82a54f5129cf0287a443d6b4918f875df3e",
        "candidate": "2c604d0f0a252a7a2e223773292507921b19feaf",
        "run": 45267017516,
        "changed": ["js/dictionary/term-bank-source-pipeline.js"],
    },
}
HARNESS = [
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "dev/perf/import-benchmark.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/import-media-validation.js",
    "test/perf/dictionaries.lock.json",
    "package-lock.json",
]


def read(path):
    return json.loads(path.read_text())


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def check(condition, message):
    if not condition:
        raise ValueError(message)


def finite_positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def hash_valid(value):
    return isinstance(value, str) and re.fullmatch("[a-f0-9]{64}", value) is not None


def identity_signature(validation):
    return {
        key: validation[key] for key in ("title", "revision", "termRows", "probeTerms", "restart")
    } | {
        "lookupResults": [
            {key: item[key] for key in ("pass", "term", "results", "sha256")}
            for item in validation["lookup"]["observations"]
        ]
    }


def validate_result(result, fixture, mode, name):
    v = result["validation"]
    check(v["title"] == fixture["expectedTitle"], f"{name}: title")
    check(v["revision"] == fixture["revision"], f"{name}: revision")
    check(v["termRows"] == fixture["termRows"], f"{name}: term rows")
    check(v["contentReadable"] is True and v["probeCount"] == 12, f"{name}: content probes")
    terms = v["probeTerms"]
    check(len(terms) == 12 and len(set(terms)) == 12 and all(isinstance(x, str) and x for x in terms), f"{name}: probe terms")
    lookup = v["lookup"]["observations"]
    check(len(lookup) == 72, f"{name}: lookup count")
    check({(x["pass"], x["term"]) for x in lookup} == {(i, t) for i in range(6) for t in terms}, f"{name}: lookup coverage")
    for item in lookup:
        check(item["hasExactHeadwordMatch"] is True and item["originalTextLength"] == len(item["term"].encode("utf-16-le")) // 2, f"{name}: exact headword")
        check(isinstance(item["results"], int) and item["results"] > 0 and hash_valid(item["sha256"]), f"{name}: lookup response")
        check(isinstance(item["elapsedMs"], (int, float)) and math.isfinite(item["elapsedMs"]) and item["elapsedMs"] >= 0, f"{name}: lookup timing")
    restart = v["restart"]
    for key in ("title", "revision", "termRows", "contentReadable", "probeCount"):
        check(restart[key] == v[key], f"{name}: restart {key}")
    check(restart["mediaFiles"] == fixture["mediaFiles"], f"{name}: restart media")
    media = v["media"]
    check(media["mode"] == mode and media["totalFiles"] == fixture["mediaFiles"] and media["totalBytes"] == fixture["mediaBytes"], f"{name}: media identity")
    expected_files = fixture["mediaFiles"] if mode == "all" else min(fixture["mediaFiles"], 64)
    check(media["files"] == expected_files and hash_valid(media["sha256"]), f"{name}: media coverage")
    check(0 <= media["bytes"] <= fixture["mediaBytes"], f"{name}: media bytes")
    if mode == "all":
        check(media["bytes"] == fixture["mediaBytes"], f"{name}: exhaustive media bytes")
    if expected_files == 0:
        check(media["bytes"] == 0 and media["sha256"] == sha256(b""), f"{name}: empty media")
    else:
        check(media["bytes"] > 0, f"{name}: nonempty media")
    check(isinstance(v["storage"]["bytes"], int) and v["storage"]["bytes"] > 0, f"{name}: storage bytes")
    check(hash_valid(v["outputDigestSha256"]), f"{name}: output digest")
    debug = result["importDebug"]
    check(debug["hasResult"] is True and debug["resultTitle"] == fixture["expectedTitle"], f"{name}: import result")
    check(debug["errorCount"] == 0 and debug["addSettingsErrorCount"] == 0 and debug["usesFallbackStorage"] is False, f"{name}: import errors/storage")


def validate_report(report, result, fixture, dictionary, mode, name):
    check(report["status"] == "success" and report["skippedVerification"] is False, f"{name}: raw report success")
    benchmark = report["benchmark"]
    expected = {
        "dictionary": dictionary,
        "pinnedDictionaries": True,
        "productionImportDefaults": True,
        "traceEnabled": False,
        "authoritativeTiming": True,
        "phaseProfiling": False,
        "phaseScreenshots": False,
        "processSampling": False,
        "mediaCheck": mode,
        "importFlags": None,
    }
    check(all(benchmark.get(k) == v for k, v in expected.items()), f"{name}: timing configuration")
    check(benchmark["validation"] == result["validation"], f"{name}: validation provenance")
    phases = [x for x in report["phases"] if x["name"] == fixture["label"] + ": total import"]
    triggers = [x for x in report["phases"] if x["name"] == "Import " + fixture["label"] + " via file input"]
    check(len(phases) == 1 and len(triggers) == 1, f"{name}: timing phase uniqueness")
    phase, trigger = phases[0], triggers[0]
    check(phase["startMs"] == trigger["startMs"] <= trigger["endMs"] <= phase["endMs"], f"{name}: automation boundary")
    check(math.isclose(phase["durationMs"], phase["endMs"] - phase["startMs"], abs_tol=0.001), f"{name}: phase duration")
    timing = phase["data"]["browserTiming"]
    check(timing["trigger"] == "file-input-change" and timing["errorCount"] == 0 and timing["sequence"] > timing["sequenceBefore"], f"{name}: current import timing")
    check(finite_positive(result["totalImportMs"]) and result["totalImportMs"] == timing["completedAtMs"] - timing["startedAtMs"], f"{name}: browser clock duration")
    check(report["packageSha256"] == result["packageSha256"] and report["browserVersion"] == result["browserVersion"], f"{name}: raw package/browser identity")


def audit(path, repository):
    state = read(path)
    directory = path.parent
    label = state["label"]
    spec = STUDIES[label]
    dictionary = state["dictionary"]
    result = {"directory": str(directory), "label": label, "dictionary": dictionary, "status": state["status"], "observations": len(state["observations"])}
    check(state["baseline"] == BASE and state["candidate"] == spec["candidate"], "frozen source mismatch")
    check(state["orders"] == ORDERS, "six-block protocol changed")
    if state["status"] != "complete":
        result["failure"] = state.get("failure")
        result["validCompleteScreen"] = False
        return result
    check(state["studyCommit"] == spec["study"], "study revision mismatch")
    check(state["node"] == "v22.22.0", "Node version mismatch")
    check(sha256((directory / "runner.py").read_bytes()) == state["runnerSha256"], "retained runner hash mismatch")
    frozen = lambda name: subprocess.check_output(["git", "show", f"{BASE}:{name}"], cwd=repository)
    fixture = json.loads(frozen("test/perf/dictionaries.lock.json"))["dictionaries"][dictionary]
    check(state["fixture"] == fixture, "frozen fixture mismatch")
    identities = state["identities"]
    if (directory / "identities.json").exists():
        check(identities == read(directory / "identities.json"), "identity report mismatch")
    expected_harness = {name: sha256(frozen(name)) for name in HARNESS}
    for arm in "ABC":
        identity = identities[arm]
        check(identity["commit"] == (spec["candidate"] if arm == "B" else BASE), f"{arm}: source")
        check(identity["harness"] == expected_harness, f"{arm}: frozen harness")
        if (directory / f"package-{arm}-entries.json").exists():
            check(identity["entries"] == read(directory / f"package-{arm}-entries.json"), f"{arm}: member map")
        check(hash_valid(identity["packageSha256"]) and all(hash_valid(x) for x in identity["entries"].values()), f"{arm}: package hashes")
    check(identities["A"]["tree"] == identities["C"]["tree"], "control tree mismatch")
    check(identities["A"]["entries"] == identities["C"]["entries"], "control packaged member bytes mismatch")
    changed = sorted(k for k in set(identities["A"]["entries"]) | set(identities["B"]["entries"]) if identities["A"]["entries"].get(k) != identities["B"]["entries"].get(k))
    check(changed == state["packageChanges"], "package changes mismatch")
    check(changed == spec["changed"], f"unexpected package changes: {changed}")
    expected_order = [(f"warmup-{arm}", arm, None, "sample") for arm in "ABC"]
    expected_order += [(f"block-{i}-{arm}", arm, i, "sample") for i, order in enumerate(ORDERS, 1) for arm in order]
    expected_order += [(f"diagnostic-{arm}", arm, None, "all") for arm in "AB"]
    observed = [(x["label"], x["arm"], x["block"], x["mediaMode"]) for x in state["observations"]]
    check(observed == expected_order and len(observed) == 23, "missing, extra, or reordered observation")
    semantic = None
    media = {}
    browsers = set()
    total = {arm: [] for arm in "ABC"}
    workers = {arm: [] for arm in "ABC"}
    for observation in state["observations"]:
        name, arm, mode = observation["label"], observation["arm"], observation["mediaMode"]
        summary = read(directory / name / "summary.json")
        check(summary["dictionary"] == dictionary and summary["fixture"] == fixture, f"{name}: fixture identity")
        check(summary["gitSha"] == identities[arm]["commit"] and summary["source"]["gitSha"] == identities[arm]["commit"], f"{name}: source identity")
        check(summary["buildTarget"] == "chrome" and summary["authoritativeTiming"] is True and summary["traceEnabled"] is False and summary["importFlags"] is None and summary["mediaCheck"] == mode, f"{name}: summary configuration")
        check(len(summary["runs"]) == 1, f"{name}: internal repeat count")
        run = summary["runs"][0]
        check(run["packageSha256"] == identities[arm]["packageSha256"], f"{name}: actual package")
        check(summary["source"]["sha256"]["builds/manabitan-chrome.zip"] == identities[arm]["packageSha256"], f"{name}: source package hash")
        check(run["totalImportMs"] == observation["totalImportMs"] and run["workerImportMs"] == observation["workerImportMs"], f"{name}: timing provenance")
        check(observation["timed"] is (observation["block"] is not None), f"{name}: timing inclusion")
        check(run["tracePath"] is None, f"{name}: unexpected trace")
        check(run["browserVersion"] and run["browserVersion"] == observation["browserVersion"] == summary["browserVersion"], f"{name}: browser identity")
        browsers.add(run["browserVersion"])
        validate_result(run, fixture, mode, name)
        validate_report(read(directory / name / "run-1.json"), run, fixture, dictionary, mode, name)
        signature = identity_signature(run["validation"])
        semantic = signature if semantic is None else semantic
        check(signature == semantic, f"{name}: production lookup/restart semantics differ")
        current_media = run["validation"]["media"]
        check(mode not in media or media[mode] == current_media, f"{name}: media bytes differ")
        media[mode] = current_media
        check(run["validation"]["storage"]["bytes"] == observation["storageBytes"] and run["validation"]["outputDigestSha256"] == observation["outputDigestSha256"], f"{name}: layout diagnostic provenance")
        if observation["timed"]:
            total[arm].append(run["totalImportMs"])
            workers[arm].append(run["workerImportMs"])
    check(len(browsers) == 1, "browser changed between observations")
    check(media == state["media"], "media summary mismatch")
    check(semantic == read(directory / "expected-lookup-signature.json"), "canonical lookup signature mismatch")
    comparisons = {}
    for numerator, denominator in (("B", "A"), ("B", "C"), ("C", "A")):
        changes = [100 * (n / d - 1) for n, d in zip(total[numerator], total[denominator])]
        current = {
            "pairedPercentChanges": changes,
            "medianPairedPercentChange": statistics.median(changes),
            "equalWorkPercentChange": 100 * (sum(total[numerator]) / sum(total[denominator]) - 1),
            "fasterPairs": sum(x < 0 for x in changes),
            "worstPercentChange": max(changes),
        }
        check(current == state["comparisons"][f"{numerator}/{denominator}"], "published arithmetic mismatch")
        comparisons[f"{numerator}/{denominator}"] = current
    result.update({
        "validCompleteScreen": True,
        "source": {"baseline": BASE, "candidate": spec["candidate"], "study": spec["study"], "run": spec["run"]},
        "fixture": fixture,
        "browserVersion": sorted(browsers),
        "packageChanges": changed,
        "controlMemberBytesEqual": True,
        "controlZipBytesEqual": identities["A"]["packageSha256"] == identities["C"]["packageSha256"],
        "semanticSignatureSha256": sha256(json.dumps(semantic, sort_keys=True, ensure_ascii=False).encode()),
        "media": media,
        "allTimedSamplesMs": total,
        "medianByArmMs": {arm: statistics.median(total[arm]) for arm in "ABC"},
        "workerMedianByArmMs": {arm: statistics.median(workers[arm]) if all(finite_positive(x) for x in workers[arm]) else None for arm in "ABC"},
        "comparisons": comparisons,
        "outputDigestVariants": sorted({x["outputDigestSha256"] for x in state["observations"]}),
        "storageByteVariants": sorted({x["storageBytes"] for x in state["observations"]}),
        "limits": "Six-block exploratory single-runner screen; not promotion or cross-device qualification. Lexical content is sampled, media diagnostics are exhaustive. No peak-memory inference.",
    })
    return result


def audit_directory(root, repository):
    results = []
    paths = list(root.rglob("summary.json"))
    paths += [path for path in root.rglob("progress.json") if not (path.parent / "summary.json").exists()]
    for path in sorted(paths):
        state = read(path)
        if state.get("schemaVersion") != 1 or "observations" not in state or "baseline" not in state:
            continue
        try:
            results.append(audit(path, repository))
        except Exception as error:
            results.append({"directory": str(path.parent), "validCompleteScreen": False, "auditFailure": repr(error)})
    return results


def unpack_bundles(root, destination):
    index = read(root / "index.json")
    for bundle in index["bundles"]:
        receipt = read(root / bundle["manifest"])
        archive = receipt["archive"]
        check(archive == bundle["archive"], "archive manifest differs from index")
        payload = (root / archive["path"]).read_bytes()
        check(len(payload) == archive["bytes"] and sha256(payload) == archive["sha256"], "archive digest mismatch")
        with tarfile.open(root / archive["path"], "r:xz") as packed:
            expected = {item["path"]: item for item in receipt["files"]}
            check(len(expected) == len(receipt["files"]) == len(packed.getmembers()), "duplicate archive member")
            check(set(packed.getnames()) == set(expected), "archive member set differs")
            for member in packed.getmembers():
                path = Path(member.name)
                check(member.isfile() and not path.is_absolute() and ".." not in path.parts, "unsafe archive member")
                data = packed.extractfile(member).read()
                item = expected[member.name]
                check(len(data) == item["bytes"] and sha256(data) == item["sha256"], "member digest mismatch")
                target = destination / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--bundles", action="store_true", help="Verify and audit indexed .tar.xz evidence bundles")
    parser.add_argument("--studies", type=Path, help="Additional frozen study specifications, keyed by label")
    options = parser.parse_args()
    if options.studies:
        STUDIES.update(read(options.studies))
    if options.bundles:
        with tempfile.TemporaryDirectory(prefix="manabitan-import-audit-") as temporary:
            extracted = Path(temporary)
            unpack_bundles(options.root, extracted)
            results = audit_directory(extracted, options.repository)
            for result in results:
                result["directory"] = Path(result["directory"]).relative_to(extracted).as_posix()
    else:
        results = audit_directory(options.root, options.repository)
    text = json.dumps(results, indent=2, ensure_ascii=False) + "\n"
    if options.output:
        options.output.write_text(text)
    print(text)
    if not results or any(not result.get("validCompleteScreen") for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
