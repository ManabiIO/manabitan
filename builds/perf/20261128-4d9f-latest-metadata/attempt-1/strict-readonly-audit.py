#!/usr/bin/env python3
"""Audit original hosted receipts; never run a dictionary import."""
import copy
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess

ROOT = Path(__file__).resolve().parent
HELPER = ROOT / "audit-helper"
EXPECTED_MANIFEST = "7fbb44eba25fea790606b211bf0dc7143d716f1a8e75b85c58091b79225b4d3f"
EXPECTED_PROTOCOL = "07cb1c53c99bd856bec7b2998f68a7d769fd8b21b0cbe6c183aa354aabf48b1c"
EXPECTED_NODE = "1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31"
ARTIFACTS = {
    "jmdict": ("a56da68461df59c342ae6c95a2723e58d0f697a22fe6662afca37dbffebf7756", 128612),
    "jitendex": ("14095036a5fbf3e0a984c193b9ca950b47ce000271ff452ec56959df5d19d633", 77746),
    "vndb": ("e49c76b552e40e78e405cb63204a7b5797be93e93c2b58dafc6791f1647b238d", 110151),
}
def sha(data):
    return hashlib.sha256(data).hexdigest()
def read(path):
    return json.loads(path.read_bytes())
def frozen(path, expected):
    data = path.read_bytes()
    assert sha(data) == expected, str(path)
    return json.loads(data)

report = {"schemaVersion": 1, "timingEligible": False, "runId": 46140311762,
          "toolingCommit": "92467bf27b8ed0661085d65eaad8f134dc2f04cc",
          "auditNode": subprocess.check_output(["node", "--version"], text=True).strip(),
          "dictionaryImportReexecuted": False, "corpora": {}}
for corpus, (digest, size) in ARTIFACTS.items():
    archive = (ROOT / (corpus + ".zip")).read_bytes()
    assert len(archive) == size and sha(archive) == digest
    directory = ROOT / corpus
    manifest = frozen(directory / "verification-manifest.json", EXPECTED_MANIFEST)
    frozen(directory / "protocol.json", EXPECTED_PROTOCOL)
    transition = read(directory / "source-profile-transition.json")
    preflight = read(directory / "preflight.json")
    assert preflight["status"] == "verified" and preflight["toolingCommit"] == report["toolingCommit"]
    assert preflight["manifestSha256"] == EXPECTED_MANIFEST
    assert preflight["protocolSha256"] == EXPECTED_PROTOCOL
    assert preflight["node"]["sha256"] == EXPECTED_NODE
    assert preflight["archive"]["sha256"] == preflight["fixture"]["sha256"]
    assert preflight["archive"]["bytes"] == preflight["fixture"]["sizeBytes"]
    expected_helpers = {}
    for item in transition["helperFiles"]:
        name = Path(item["path"]).name
        assert sha((HELPER / name).read_bytes()) == item["sha256"]
        if name != "README.md":
            expected_helpers[name] = item["sha256"]
    tap = (directory / "contracts.log").read_text()
    counts = {key: int(re.search(r"^# " + key + r" (\d+)$", tap, re.M).group(1))
              for key in ("tests", "pass", "fail", "cancelled", "skipped", "todo")}
    assert counts == {"tests": 26, "pass": 26, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
    exits = read(directory / "arm-exits.json")
    arms = {}
    for arm in ("A", "B"):
        output = directory / (corpus + "-" + arm + "-1")
        success = (output / "result.json").exists()
        result = read(output / ("result.json" if success else "failure.json"))
        launch = read(directory / (corpus + "-" + arm + "-1.launcher.json"))
        assert launch["returncode"] == exits[arm] == (0 if success else 1)
        assert launch["terminatingSignal"] is None
        assert launch["status"] == ("complete" if success else "failed")
        source = result["source"]
        profile = manifest["sourceProfiles"][arm]
        assert source["commit"] == source["runtimeProfileCommit"] == profile["runtimeCommit"]
        assert source["canonicalIdentity"] == profile["canonicalIdentity"]
        assert source["trees"] == profile["trees"]
        assert source["runtimeDiffSha256"] == sha(b"")
        if success:
            assert result["success"] is True and result["timingEligible"] is False
            assert result["helperIdentity"] == expected_helpers
            assert result["runtimeIdentity"]["sha256"] == EXPECTED_NODE
            assert result["node"] == "v22.22.0"
            assert result["execArgv"] == ["--max-old-space-size=512"]
            assert result["evidenceIdentity"]["manifest"]["sha256"] == EXPECTED_MANIFEST
            assert result["evidenceIdentity"]["protocol"]["sha256"] == EXPECTED_PROTOCOL
            for name, oracle in manifest["oracles"].items():
                assert result["evidenceIdentity"]["oracles"][name] == {"bytes": oracle["bytes"], "sha256": oracle["sha256"]}
            oracle_bytes = (output / "final-output-oracle.json").read_bytes()
            assert sha(oracle_bytes) == manifest["oracles"][corpus + "-output"]["sha256"]
            assert len(oracle_bytes) == manifest["oracles"][corpus + "-output"]["bytes"]
            arms[arm] = {"success": True, "rows": result["rows"], "groups": len(result["groupResults"]), "finalOracleSha256": sha(oracle_bytes)}
        else:
            assert result["success"] is False
            assert result["stage"] == "actual public canonical sink"
            assert result["currentGroup"] == (4 if corpus == "jitendex" else 11)
            assert "TermContentLookupReadError: Database not open" in result["error"]
            arms[arm] = {"success": False, "stage": result["stage"], "currentGroup": result["currentGroup"], "error": result["error"].split("\n")[0]}
    report["corpora"][corpus] = {"artifactSha256": digest, "contractCounts": counts, "preflightVerified": True, "arms": arms}
jmdict = ROOT / "jmdict"
comparison = ROOT / "strict-jmdict-comparison.json"
command = ["node", str(HELPER / "compare-results.mjs"), str(jmdict / "jmdict-A-1"),
           str(jmdict / "jmdict-B-1"), str(comparison), "--evidence-dir", str(jmdict)]
completed = subprocess.run(command, text=True, capture_output=True, check=False)
(ROOT / "strict-comparator.stdout.log").write_text(completed.stdout)
(ROOT / "strict-comparator.stderr.log").write_text(completed.stderr)
assert completed.returncode == 0, completed.stderr
actual = read(comparison)
original = read(jmdict / "jmdict-comparison.json")
for item in (actual, original):
    for arm in ("parent", "candidate"):
        item[arm].pop("directory")
assert actual == original
assert actual["finalOwnedBytesAvoided"] == 4194304
assert actual["candidateNullPhysicalSignature1EveryGroup"] is True
assert actual["candidateNullPhysicalDictionaryNameIdsEveryGroup"] is True
report["strictComparator"] = {"exitCode": completed.returncode, "sameOriginalComparisonApartFromLocalDirectoryNames": True,
                            "finalOwnedBytesAvoided": actual["finalOwnedBytesAvoided"]}
bad = ROOT / "negative-control-A"
bad.mkdir()
invalid = read(jmdict / "jmdict-A-1/result.json")
invalid["success"] = False
(bad / "result.json").write_text(json.dumps(invalid) + "\n")
negative_command = ["node", str(HELPER / "compare-results.mjs"), str(bad),
                    str(jmdict / "jmdict-B-1"), str(ROOT / "negative-must-not-exist.json"),
                    "--evidence-dir", str(jmdict)]
pipeline = shlex.join(negative_command) + " 2>&1 | tee " + shlex.quote(str(ROOT / "negative-pipeline.log"))
negative = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", pipeline],
                          text=True, capture_output=True, check=False)
assert negative.returncode != 0 and not (ROOT / "negative-must-not-exist.json").exists()
assert "AssertionError" in negative.stdout
report["negativeExitControl"] = {"explicitShell": "bash --noprofile --norc -eo pipefail", "mutatedCopyOnly": True,
                               "invalidReceiptRejected": True, "pipelineExitCode": negative.returncode,
                               "comparisonOutputAbsent": True}
report["conclusion"] = "Original latest JMdict A/B proof independently revalidated without reacquisition; latest Jitendex/VNDB remain real symmetric harness-boundary failures."
report["auditSha256"] = sha(Path(__file__).read_bytes())
(ROOT / "strict-readonly-audit.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"jmdictPassed": True, "retainedBytesAvoided": 4194304, "jitendexFailureGroup": 4,
                  "vndbFailureGroup": 11, "negativeExit": negative.returncode, "importsReexecuted": False}))
