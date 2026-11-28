"""Reconcile existing excluded baseline reports; do not acquire any observations."""
import ast
import collections
import datetime
import errno
import hashlib
import json
from pathlib import Path
import re
import traceback
import zipfile

ROOT = Path(__file__).resolve().parent
OLD_MEMORY_AUDITOR = ROOT.parent / "numeric-suffix-972-full-evidence/raw-evidence-audit.py"
SOURCE = ROOT.parent / "benchmark-prerequisite-982-recovered"
BASE = "a300da36d00df8e353c5679b1528b50a1299b75f"
HEAD = "4b1d90e0cfbc4d19322105a92b1b3c0d9792436c"
BINDING = "c9da17e30c264ea31b10367294a9d31f431de705d52e3c9a3bedeee584a942f3"
JOBS = {"jmdict": 140962634770, "jitendex": 140962634795, "vndb": 140962634718}
ROWS = {"jmdict": 528299, "jitendex": 436555, "vndb": 6648310}
LABELS = ["prepare-locked-fixture", "create-baseline", "build-libraries", "license-page", "release-package"]
RUNNER = "/home/runner/work/manabitan/manabitan"
BASE_ROOT = "/home/runner/work/manabitan/suffix-proof-982-prerequisite-baseline"


def check(value, message):
    if not value:
        raise AssertionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def one(records, tag):
    xs = [r["value"] for r in records if r["tag"] == "MANABITAN_A300_PREREQUISITE_" + tag]
    check(len(xs) == 1, "Single primary " + tag)
    return xs[0]


old_bytes = OLD_MEMORY_AUDITOR.read_bytes()
check(sha(old_bytes) == "a49f2d50a9098af8c275002a61b5019d6118ffb619fcb12a7352442715997a1c",
      "Exact previously reviewed memory reconstruction source")
names = {"pick", "tree_identity", "exited_zombie", "reconstruct_memory"}
old_text = old_bytes.decode()
nodes = [node for node in ast.parse(old_text).body if isinstance(node, ast.FunctionDef) and node.name in names]
check({x.name for x in nodes} == names and len(nodes) == 4, "Only four pure existing memory helpers")
namespace = {"errno": errno, "GONE": {errno.ENOENT, errno.ESRCH}}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(OLD_MEMORY_AUDITOR), "exec"), namespace)
helper_hashes = {node.name: sha(ast.get_source_segment(old_text, node).encode()) for node in nodes}

all_results = []
common_entries = None
for dictionary in ("jmdict", "jitendex", "vndb"):
    cell = ROOT / dictionary
    recovered = cell / "raw-recovery-1"
    output = recovered / "independent-storage-source-report-audit-1.json"
    check(not output.exists(), "Never overwrite a prior replay")
    audit = {"schema": 1, "complete": False, "dictionary": dictionary,
             "scope": "Original excluded baseline source, five command logs, report/summary/storage/package-map and raw per-process scan reconciliation; no benchmark, browser or native execution.",
             "auditedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
             "auditorSha256": sha(Path(__file__).read_bytes()),
             "memoryReconstructionSourceSha256": sha(old_bytes), "unchangedMemoryHelperSha256": helper_hashes}
    try:
        recovery = json.loads((recovered / "raw-archive-recovery.json").read_text())
        check(recovery["complete"] is True and recovery["runId"] == 46139360578
              and recovery["jobId"] == JOBS[dictionary] and recovery["workflowCommit"] == HEAD,
              "Verified recovery provenance")
        archive_bytes = (recovered / "raw-evidence.zip").read_bytes()
        check(sha(archive_bytes) == recovery["archive"]["sha256"], "Original inner archive identity")
        with zipfile.ZipFile(recovered / "raw-evidence.zip") as z:
            raw = {name: z.read(name) for name in z.namelist()}
        manifest = json.loads((recovered / "raw-evidence-manifest.json").read_text())
        check(len(raw) == 29 and set(raw) == {x["path"] for x in manifest["members"]}, "All original selected members")
        for item in manifest["members"]:
            check(len(raw[item["path"]]) == item["bytes"] and sha(raw[item["path"]]) == item["sha256"], "Original selected member")
        data = {name: json.loads(body) for name, body in raw.items() if name.endswith(".json")}
        records = json.loads((cell / "primary-records.json").read_text())
        start, result = data["start.json"], data["result.json"]
        check(start == one(records, "START") and result == one(records, "RESULT"), "Raw start/result equals primary")
        check(start["runId"] == "46139360578" and start["runAttempt"] == "1" and start["workflowHead"] == HEAD
              and start["bindingSha256"] == BINDING and start["dictionary"] == dictionary
              and start["mode"] == "storage" and start["nodeVersion"] == "v22.22.0"
              and start["timingIsAuthoritative"] is False, "Excluded baseline provenance")
        check(raw["source-binding.json"] == (SOURCE / "source-binding.json").read_bytes()
              and sha(raw["source-binding.json"]) == BINDING, "Exact published binding")
        binding = data["source-binding.json"]
        check(sha(raw["a300-source-inventory.json"]) == binding["sourceInventory"]["sha256"]
              and sha(raw["prospective-review-criteria.json"]) == binding["criteria"]["sha256"], "Inventory and criteria")
        check(start["source"] == data["source-proof.json"] and start["source"]["baseline"] == binding["baseline"]
              and binding["baseline"]["commit"] == BASE, "Original source proof")
        check(result["status"] == "complete" and result["retried"] is False
              and result["baselineObservationCompleted"] is True and result["observations"] == 1
              and result["candidateObservations"] == 0 and result["comparison"] is False
              and result["authoritativeTiming"] is False and result["fullQualificationLaunched"] is False
              and result["storageCompatibilityAccepted"] is False, "No promoted or repeated observation")
        commands = [
            ["node", "dev/perf/prepare-dictionaries.js", dictionary],
            ["git", "worktree", "add", "--detach", BASE_ROOT, BASE],
            ["npm", "run", "build:libs"], ["npm", "run", "license-report:html"],
            ["npm", "run", "build", "--", "--target", "chrome"]]
        primary_commands = [x["value"] for x in records if x["tag"] == "MANABITAN_A300_PREREQUISITE_COMMAND"]
        check(len(primary_commands) == 5, "Exactly five preparation commands")
        receipts = []
        prior_finish = None
        for index, label in enumerate(LABELS):
            receipt = data[label + ".receipt.json"]
            check(receipt == primary_commands[index] and receipt["label"] == label
                  and receipt["command"] == commands[index] and receipt["cwd"] == (RUNNER if index < 2 else BASE_ROOT),
                  "Original preparation command argv/cwd")
            check(receipt["exitCode"] == 0 and receipt["exception"] is None and receipt["retried"] is False
                  and receipt["logSha256"] == sha(raw[label + ".log"]), "Original successful command/log")
            check(receipt["startedEpoch"] <= receipt["finishedEpoch"]
                  and (prior_finish is None or receipt["startedEpoch"] >= prior_finish), "Serial original command receipts")
            prior_finish = receipt["finishedEpoch"]
            receipts.append(receipt)
        check(result["commandReceipts"] == {x: sha(raw[x + ".receipt.json"]) for x in LABELS}, "Original command receipt hashes")
        plan = data["observation-plan.json"]
        check(plan["dictionary"] == dictionary and plan["baseline"] == binding["baseline"] and plan["flags"] == {}
              and plan["observations"] == 1 and plan["candidateObservations"] == 0
              and plan["authoritativeTiming"] is False and plan["comparison"] is False
              and plan["allocationBound"] is None, "Excluded observation plan")
        expected_command = ["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
                            "--build-target", "chrome", "--media-check", "sample", "--output",
                            RUNNER + "/builds/perf/suffix-proof-982-prerequisite-" + dictionary + "/baseline-only"]
        check(plan["command"] == expected_command, "Single exact default baseline observation command")
        report, summary = data["baseline-only/run-1.json"], data["baseline-only/summary.json"]
        check(report["status"] == "success" and report["skippedVerification"] is False
              and report["buildTarget"] == "chrome" and report["browserFlavor"] == "chromium"
              and report["launchMode"] == "headless", "Completed headless original report")
        check(len(summary["runs"]) == 1 and summary["gitSha"] == BASE and summary["source"]["gitSha"] == BASE
              and summary["source"]["dirty"] is True, "Single baseline and declared marker overlay")
        for key, expected in {"dictionary": dictionary, "pinnedDictionaries": True, "productionImportDefaults": True,
                              "traceEnabled": False, "phaseProfiling": False, "phaseScreenshots": False,
                              "processSampling": False, "importFlags": None, "mediaCheck": "sample"}.items():
            check(report["benchmark"][key] == expected, "Production/default report option " + key)
        check(summary["importFlags"] is None and summary["mediaCheck"] == "sample", "Original summary options")
        validation = report["benchmark"]["validation"]
        check(summary["runs"][0]["validation"] == validation, "Every raw semantic/storage field equals summary")
        check(validation["termRows"] == ROWS[dictionary] and validation["contentReadable"] is True
              and validation["probeCount"] == len(validation["probeTerms"]) == 12, "Locked rows and readable probes")
        restart = validation["restart"]
        for key in ("title", "revision", "termRows", "contentReadable", "probeCount"):
            check(restart[key] == validation[key], "Restart semantic field " + key)
        check(restart["mediaFiles"] == validation["media"]["totalFiles"], "Restart media count")
        lookups = validation["lookup"]["observations"]
        check(len(lookups) == 72 and {(x["pass"], x["term"]) for x in lookups}
              == {(p, term) for p in range(6) for term in validation["probeTerms"]}, "Six complete lookup passes")
        for term in validation["probeTerms"]:
            rows = [x for x in lookups if x["term"] == term]
            check(all(x["hasExactHeadwordMatch"] is True for x in rows)
                  and len({x["sha256"] for x in rows}) == 1, "All repeated lookup semantics")
        inventory = data["storage-inventory.json"]
        check(inventory == one(records, "STORAGE_INVENTORY") and inventory["validation"] == validation
              and inventory["summarySource"] == summary["source"] and inventory["summaryGitSha"] == BASE
              and inventory["candidateObserved"] is False and inventory["prospectiveFullStorageBound"] is None,
              "Raw storage inventory equals original report and primary")
        check(inventory["files"] == {n: sha(raw["baseline-only/" + n])
              for n in ("run-1.json", "summary.json", "memory.json", "markers.jsonl")}, "Inventory hashes bind all raw fields")
        packages = data["package-entries.json"]
        check(len(packages["entries"]) == 582, "Current a300 regular package entry count")
        entries = packages["entries"]
        check(entries["js/dictionary/wasm/term-bank-parser.c"]["sha256"] == binding["nativeBaseline"]["cSha256"]
              and entries["lib/term-bank-parser.wasm"]["sha256"] == binding["nativeBaseline"]["wasmSha256"],
              "Baseline native package entries")
        if common_entries is None:
            common_entries = entries
        check(entries == common_entries, "All three original baseline package-entry maps exactly identical")
        check(packages["packageSha256"] == report["packageSha256"] == summary["runs"][0]["packageSha256"]
              == plan["packageSha256"], "Original package identity in every receipt")
        excluded = recovery["excluded"]
        check(len(excluded) == 1 and excluded[0]["path"] == "package-A.zip"
              and excluded[0]["sha256"] == packages["packageSha256"]
              and excluded[0]["bytes"] == packages["packageBytes"] == 17060417, "Exactly one excluded original package")
        sources = summary["source"]["sha256"]
        expected_sources = {x["path"]: x["sha256"] for x in data["a300-source-inventory.json"]["sourceFiles"]}
        overlay_path = "test/chromium/extension-two-dictionary-import.e2e.js"
        check(sha(raw["harness-original.js"]) == expected_sources[overlay_path]
              == "d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf", "Original harness bytes")
        check(sha(raw["harness-instrumented.js"]) == "81adafaae2763693ae074bd8fe30c6712d066c29ec424c6385590f6eaa10a9bb",
              "Exact unchanged marker overlay")
        for path, actual in sources.items():
            expected = (packages["packageSha256"] if path == "builds/manabitan-chrome.zip" else
                        None if path == "builds/manabitan-chrome-dev.zip" else
                        sha(raw["harness-instrumented.js"]) if path == overlay_path else expected_sources[path])
            check(actual == expected, "Every source provenance column " + path)
        browser = data["browser-identity.json"]
        check(browser["sha256"] == binding["runtime"]["browser"]["sha256"]
              and browser["versionOutput"] == binding["runtime"]["browser"]["versionOutput"], "Pinned browser bytes/version")
        storage = validation["storage"]
        paths = [x["path"] for x in storage["files"]]
        check(len(paths) == len(set(paths)) and all(type(x["bytes"]) is int and x["bytes"] >= 0 for x in storage["files"]),
              "Unique logical OPFS files and exact nonnegative integer sizes")
        check(sum(x["bytes"] for x in storage["files"]) == storage["bytes"], "Every raw logical OPFS byte")
        sah = [x for x in storage["files"] if x["path"].startswith("manabitan/sqlite-sahpool-v1/.opaque/")]
        non_sah = [x for x in storage["files"] if x not in sah]
        check(len(sah) == 8 and all(x["bytes"] >= 4096 and x["bytes"] % 4096 == 0 for x in sah), "Eight observed page-aligned SAH files")
        check(all(x["path"] == "manabitan-term-content.bin" or x["path"].startswith("manabitan-term-records/")
                  or x["path"].startswith("manabitan-dictionary-media-v1/") for x in non_sah), "Known non-SAH path families")
        memory = data["baseline-only/memory.json"]
        markers = [json.loads(line) for line in raw["baseline-only/markers.jsonl"].decode().splitlines()]
        computed_memory = namespace["reconstruct_memory"](memory, markers)
        sampled = data["sampled-summary.json"]
        check(all(memory[key] == value for key, value in sampled.items()), "Sampler summary equals full original scan file")
        check(one(records, "SAMPLED_BASELINE") == {"dictionary": dictionary, "value": sampled, "authoritativeTiming": False},
              "Original sampler summary primary binding")
        check(result["qualifiedForWholeTreePss"] == computed_memory["qualifiedForWholeTreePss"]
              and result["memoryQualificationFailures"] == computed_memory["qualificationFailures"], "Original memory outcome")
        audit.update(complete=True, archive=recovery["archive"], recoveryReceiptSha256=sha((recovered / "raw-archive-recovery.json").read_bytes()),
                     originalReportSha256=sha(raw["baseline-only/run-1.json"]),
                     originalSummarySha256=sha(raw["baseline-only/summary.json"]),
                     originalInventorySha256=sha(raw["storage-inventory.json"]), commandReceipts=receipts,
                     baseline=binding["baseline"], observations=1, candidateObservations=0,
                     comparison=False, authoritativeTiming=False, storage=storage, sahFileCount=len(sah),
                     nonSahFiles=non_sah, package={"entries": 582, "entryMapSha256": digest(entries),
                     "wholeZipSha256": packages["packageSha256"], "bytes": packages["packageBytes"],
                     "excludedFiles": excluded, "originalPackageDownloaded": False},
                     originalMemoryScanReplay=computed_memory, semanticRows=ROWS[dictionary],
                     lookupObservations=72, sourceProvenanceColumns=len(sources),
                     fullQualificationAccepted=False,
                     limitations=["Only selected original raw archives were downloaded/recovered; the original outer storage ZIP and release package were not downloaded.",
                                  "The original producer hashed actual package members; this replay binds its exact582-entry map and package SHA/size to the report, without independently reading the omitted package bytes.",
                                  "One excluded baseline per dictionary is descriptive prerequisite evidence; no candidate comparison or performance conclusion is made.",
                                  "The prospective storage policy is independently reviewed by root/pipeline; this replay does not silently set or relax that policy."])
        all_results.append({"dictionary": dictionary, "audit": str(output), "storageBytes": storage["bytes"],
                            "rawScans": computed_memory["allObservedSampleCount"], "sahFiles": len(sah)})
    except Exception as error:
        audit["failure"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        raise
    finally:
        with output.open("x") as stream:
            stream.write(json.dumps(audit, indent=2) + "\n")
        print(json.dumps({"dictionary": dictionary, "complete": audit["complete"],
                          "failure": audit.get("failure", {}).get("message")}))
with (ROOT / "independent-storage-replay-index-1.json").open("x") as stream:
    stream.write(json.dumps({"schema": 1, "complete": True, "sourceSha256": sha(Path(__file__).read_bytes()),
                            "observations": all_results, "candidateObservations": 0,
                            "same582EntryPackageMap": True, "noPerformanceComparison": True}, indent=2) + "\n")

