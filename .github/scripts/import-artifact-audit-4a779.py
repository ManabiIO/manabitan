#!/usr/bin/env python3
"""Read existing frozen import artifacts; never run a product or benchmark."""
import argparse
import hashlib
import io
import json
import math
import os
import pathlib
import random
import re
import statistics
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOKEN = os.environ.pop("GH_TOKEN", "")
API = "https://api.github.com"
MAX_ZIP_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
# These frozen repository helpers are pure stdlib data validators; no product runs.
sys.path.insert(0, str(ROOT / "dev/perf/import-memory-20261125-a7f7"))
from qualification_receipts import validate_import_summary, require_matching_receipts
from protocol import memory_comparison, memory_overlay, schedule as memory_schedule

class AuditError(Exception):
    pass

def require(condition, message):
    if not condition:
        raise AuditError(message)

def scrub(value):
    if isinstance(value, str):
        value = value.replace(TOKEN, "[credential-redacted]") if TOKEN else value
        return re.sub(r"https?://[^\s\"<>]+", "[url-redacted]", value)
    if isinstance(value, list):
        return [scrub(x) for x in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value

def frozen_path(name):
    relative = pathlib.PurePosixPath(name)
    require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe source-boundary path")
    path = (ROOT / relative).resolve()
    require(path.is_relative_to(ROOT), "Source-boundary path leaves frozen checkout")
    return path

def digest(data):
    return hashlib.sha256(data).hexdigest()

def stream_digest(stream, limit=MAX_MEMBER_BYTES, destination=None):
    h = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        require(size <= limit, "Download/member exceeds auditor resource bound")
        h.update(chunk)
        if destination is not None:
            destination.write(chunk)
    return size, h.hexdigest()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect())

def open_once(url, authenticated):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and not parsed.username and not parsed.password,
            "Non-HTTPS or credential-bearing redirect rejected")
    headers = {"User-Agent": "manabitan-read-only-artifact-audit", "Accept": "application/vnd.github+json"}
    if authenticated:
        require(parsed.hostname == "api.github.com" and parsed.port in (None, 443),
                "Authentication may only be sent to GitHub API")
        headers["Authorization"] = "Bearer " + TOKEN
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    try:
        return OPENER.open(urllib.request.Request(url, headers=headers), timeout=60)
    except urllib.error.HTTPError as error:
        if error.code in (301, 302, 303, 307, 308):
            location = error.headers.get("Location")
            error.close()
            require(location is not None, "Redirect lacks Location")
            return urllib.parse.urljoin(url, location)
        code = error.code
        error.close()
        raise AuditError("HTTP status " + str(code) + " while reading registered evidence") from None
    except (urllib.error.URLError, TimeoutError):
        raise AuditError("Network/timeout failure while reading registered evidence") from None

def api_json(path):
    response = open_once(API + path, True)
    require(not isinstance(response, str), "Unexpected redirect for metadata request")
    with response:
        data = response.read(32 * 1024 * 1024 + 1)
    require(len(data) <= 32 * 1024 * 1024, "Metadata response exceeds auditor bound")
    return json.loads(data)

def pages(path, field):
    values = []
    for page in range(1, 21):
        separator = "&" if "?" in path else "?"
        response = api_json(path + separator + "per_page=100&page=" + str(page))
        batch = response[field]
        require(isinstance(batch, list), "Invalid metadata page")
        values.extend(batch)
        if len(batch) < 100:
            return values
    raise AuditError("Metadata pagination exceeded auditor bound")

def download_zip(repository, artifact_id, destination):
    url = API + "/repos/" + repository + "/actions/artifacts/" + str(artifact_id) + "/zip"
    authenticated = True
    for _ in range(8):
        response = open_once(url, authenticated)
        if isinstance(response, str):
            url = response
            # A signed destination and all subsequent redirects receive NO token.
            authenticated = False
            continue
        with response, destination.open("wb") as output:
            return stream_digest(response, MAX_ZIP_BYTES, output)
    raise AuditError("Too many artifact redirects")

def zip_entries(z):
    rows = [x for x in z.infolist() if not x.is_dir()]
    names = [x.filename for x in rows]
    require(len(names) == len(set(names)), "ZIP contains duplicate member names")
    for item in rows:
        name = pathlib.PurePosixPath(item.filename)
        require(not name.is_absolute() and ".." not in name.parts, "Unsafe ZIP member name")
        require(item.file_size <= MAX_MEMBER_BYTES, "ZIP member exceeds auditor bound")
    return rows

def read_json(z, name):
    require(z.getinfo(name).file_size <= MAX_MEMBER_BYTES, "JSON member exceeds auditor bound")
    return json.loads(z.read(name))

def close_number(a, b):
    return isinstance(a, (int, float)) and isinstance(b, (int, float)) and math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-9)

def fixed_schedule():
    rows = []
    for pair, order in enumerate(("AB", "BA"), 1):
        for arm in order:
            rows.append({"id": f"warmup-{pair}-{arm}", "kind": "warmup", "pair": pair, "arm": arm})
    for pair in range(1, 7):
        for arm in ("AB" if pair % 2 else "BA"):
            rows.append({"id": f"pair-{pair:02d}-{arm}", "kind": "candidate", "pair": pair, "arm": arm})
        if pair % 3 == 0:
            control_pair = pair // 3
            for arm in ("AC" if control_pair == 1 else "CA"):
                rows.append({"id": f"control-{control_pair:02d}-{arm}", "kind": "control", "pair": control_pair, "arm": arm})
    return rows

def paired(observations, kind, other, expected_count):
    groups = {}
    for row in observations:
        if row["kind"] != kind:
            continue
        group = groups.setdefault(row["pair"], {})
        require(row["arm"] not in group, "Repeated arm within a recorded pair")
        group[row["arm"]] = row["totalImportMs"]
    require(len(groups) == expected_count, "Incorrect number of complete pairs")
    values = [groups[index] for index in sorted(groups)]
    require(all(set(v) == {"A", other} for v in values), "Incomplete/unexpected paired arms")
    ratios = [v[other] / v["A"] for v in values]
    rng = random.Random(897)
    resamples = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        "count": len(values), "ratios": ratios,
        "medianPairedChangePercent": (statistics.median(ratios) - 1) * 100,
        "equalWorkChangePercent": (sum(v[other] for v in values) / sum(v["A"] for v in values) - 1) * 100,
        "worstPairChangePercent": (max(ratios) - 1) * 100,
        "descriptiveBootstrap95Percent": [(resamples[i] - 1) * 100 for i in (249, 9749)],
        "fasterPairs": sum(x < 1 for x in ratios),
        "medianAbsoluteChangeMs": statistics.median(v[other] - v["A"] for v in values),
    }

def compare_arithmetic(actual, recorded):
    require(set(recorded) == set(actual) - {"medianAbsoluteChangeMs"}, "Recorded arithmetic fields differ")
    for key, value in recorded.items():
        require(key in actual, "Unexpected recorded arithmetic field: " + key)
        if isinstance(value, list):
            require(len(value) == len(actual[key]) and all(close_number(a, b) for a, b in zip(actual[key], value)),
                    "Recorded arithmetic disagrees: " + key)
        else:
            require(close_number(actual[key], value), "Recorded arithmetic disagrees: " + key)

def selected_numbers(value, keys, path=""):
    found = {}
    if isinstance(value, dict):
        for key, item in value.items():
            child = path + "." + key
            if key in keys and isinstance(item, (bool, int, float)):
                found[child] = item
            elif isinstance(item, (dict, list)):
                found.update(selected_numbers(item, keys, child))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.update(selected_numbers(item, keys, path + "[" + str(index) + "]"))
    return found

def audit_contents(z, run, spec, manifest, result):
    result["stage"] = "registered-plan"
    members = zip_entries(z)
    names = {x.filename for x in members}
    matching = []
    for name in names:
        if name == "registered-plan.json" or name.endswith("/registered-plan.json"):
            plan = read_json(z, name)
            if plan.get("dictionary") == spec["dictionary"]:
                matching.append((name[:-len("registered-plan.json")], plan))
    require(len(matching) == 1, "Expected one ordinary qualification plan for this artifact")
    prefix, plan = matching[0]
    def read(name):
        return read_json(z, prefix + name)
    result["registeredPlan"] = plan
    require(plan["baseline"] == manifest["baseline"] and plan["candidate"] == run["head"], "Plan source heads disagree")
    require(plan["dictionary"] == spec["dictionary"] and plan["pairs"] == 6 and plan["initialOrder"] == "AB", "Plan cohort differs")
    require(plan["flags"] == {}, "Expected unchanged production flags")
    require(plan["schedule"] == fixed_schedule(), "Recorded timing plan differs from frozen AB protocol")
    expected_members = set(run["expectedPackageEntries"])
    require(set(plan["expectedPackageEntries"]) == expected_members, "Plan package delta differs")
    if spec["dictionary"] == "vndb":
        policy = plan["vndbSahAllocationPolicy"]
        require(policy["rangeUnits"] == [37, 37] and policy["unitBytes"] == 4096 and policy["origin"] == "explicit", "VNDB SAH policy differs")

    result["stage"] = "source-and-package-provenance"
    require(plan["memorySchedule"] == memory_schedule(1), "Memory schedule differs")
    identities = read("source-identities.json")
    require(set(identities["changedPackageEntries"]) == expected_members, "Recorded package delta differs")
    arms = identities["arms"]
    require(arms["A"]["sha"] == manifest["baseline"] and arms["B"]["sha"] == run["head"], "Recorded source heads disagree")
    require(set(arms["A"]["sourceHashes"]) == set(arms["B"]["sourceHashes"]) == set(manifest["sourceHashPaths"]), "Source-boundary member set differs")
    for key, value in arms["A"]["sourceHashes"].items():
        if key.startswith("builds/"):
            continue
        path = frozen_path(key)
        require(path.is_file(), "Missing frozen checkout source: " + key)
        require(value == arms["B"]["sourceHashes"][key] == digest(path.read_bytes()), "Frozen harness/source mismatch: " + key)
    require(arms["A"]["fixtureLockSha256"] == arms["B"]["fixtureLockSha256"] == manifest["baselineFixtureLockSha256"], "Fixture lock differs")
    actual = {}
    package_receipts = {}
    for arm in ("A", "B"):
        data = z.read(prefix + "package-" + arm + ".zip")
        require(digest(data) == arms[arm]["packageSha256"], "Package container digest differs")
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            actual[arm] = {}
            for item in zip_entries(package):
                with package.open(item) as stream:
                    _, value = stream_digest(stream)
                actual[arm][item.filename] = value
        require(actual[arm] == arms[arm]["entries"], "Package member hash manifest differs")
        package_receipts[arm] = {"sha256": digest(data), "memberCount": len(actual[arm]), "memberHashes": actual[arm]}
    require(actual["A"].keys() == actual["B"].keys(), "Package member set changed")
    changed = {name for name in actual["A"] if actual["A"][name] != actual["B"][name]}
    require(changed == expected_members, "Actual package delta differs")
    result["packageAudit"] = {"expectedDelta": sorted(expected_members), "actualDelta": sorted(changed), "arms": package_receipts}
    result["sourceIdentities"] = {arm: {k: v for k, v in arms[arm].items() if k != "entries"} for arm in arms}
    browser = read("browser-identity.json")
    require(browser["sha256"] == manifest["browserSha256"], "Frozen browser digest differs")
    result["browserIdentity"] = browser

    result["stage"] = "paired-timing-arithmetic"
    observations = read("observations.json")
    result["observations"] = observations
    require(len(observations) == 20 and len({x["id"] for x in observations}) == 20, "Expected all 20 observations including 4 warmups")
    require([{k: v for k, v in x.items() if k != "totalImportMs"} for x in observations] == plan["schedule"], "Observed schedule differs")
    for row in observations:
        duration = row["totalImportMs"]
        require(isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0, "Invalid complete-import duration")
        summary = read(row["id"] + "/summary.json")
        require(len(summary["runs"]) == 1 and close_number(summary["runs"][0]["totalImportMs"], duration), "Observation disagrees with raw summary")
    analysis = read("analysis.json")
    result["originalAnalysis"] = analysis
    result["recomputed"] = {
        "candidateVsBaseline": paired(observations, "candidate", "B", 6),
        "identicalCodeControl": paired(observations, "control", "C", 2),
    }
    for key, value in result["recomputed"].items():
        compare_arithmetic(value, analysis[key])

    result["stage"] = "separate-memory-and-semantics"
    memory = read("memory/memory-comparison.json")
    semantic = read("memory/semantic-failures.json")
    result["memoryComparison"] = memory
    require(isinstance(semantic, list), "Semantic failure receipt is not a list")
    result["semanticFailures"] = semantic
    require(memory_comparison(memory["observations"], spec["dictionary"], 1, memory_schedule) == memory, "Recorded memory arithmetic disagrees")
    result["memoryFailures"] = [
        {k: v for k, v in row.items() if k in ("name", "arm", "pair", "qualificationFailures", "benchmarkExitCode", "maximumCoveredSampleGapMs", "qualifiedForWholeTreePss")}
        for row in memory["observations"] if row.get("qualificationFailures") or row.get("benchmarkExitCode") != 0 or not row.get("qualifiedForWholeTreePss")
    ]
    has_memory_audit = prefix + "memory/memory-audit.json" in names
    has_memory_audit_failure = prefix + "memory/memory-audit-failure.json" in names
    require(has_memory_audit != has_memory_audit_failure, "Expected exactly one memory audit outcome")
    result["memoryAudit"] = read("memory/memory-audit.json") if has_memory_audit else None
    result["memoryAuditFailure"] = read("memory/memory-audit-failure.json") if has_memory_audit_failure else None
    if has_memory_audit:
        expected_audit = {
            "schemaVersion": 1, "observations": len(memory["observations"]),
            "rawScanCount": sum(row["allObservedSampleCount"] for row in memory["observations"]),
            "everyObservationQualified": memory["everyObservationQualified"],
            "passesProspectiveMemoryScreen": memory["passesProspectiveMemoryScreen"], "metrics": memory["metrics"],
        }
        require(result["memoryAudit"] == expected_audit, "Stored memory audit disagrees with comparison")
    qualified = bool(memory["passesProspectiveMemoryScreen"] and not semantic and result["memoryAuditFailure"] is None)
    require(analysis["memoryPassed"] == qualified, "Final memory/semantic status disagrees with its evidence")
    require(analysis["status"] == ("correctness-memory-passed" if qualified else "memory-or-semantics-failed"), "Final qualification status disagrees with its evidence")
    result["stage"] = "raw-report-revalidation"
    fixture = json.loads(frozen_path("test/perf/dictionaries.lock.json").read_text())["dictionaries"][spec["dictionary"]]
    original_harness = frozen_path("test/chromium/extension-two-dictionary-import.e2e.js").read_text()
    instrumented_harness = memory_overlay(original_harness)
    require(z.read(prefix + "memory/harness-original.js").decode() == original_harness, "Original memory harness differs")
    require(z.read(prefix + "memory/harness-instrumented.js").decode() == instrumented_harness, "Memory overlay differs")
    result["semanticRevalidationFailures"] = []
    semantic_references = {}
    result["rawReports"] = []
    result["rawReportFailures"] = []
    result["activationMismatches"] = []
    wanted = set(manifest["activationKeys"])
    for name in sorted(names):
        if not name.startswith(prefix) or not name.endswith("/run-1.json"):
            continue
        relative = name[len(prefix):]
        report = read_json(z, name)
        parts = relative.split("/")
        arm = parts[1][0] if parts[0] == "memory" else parts[0].split("-")[-1]
        require(arm in ("A", "B", "C"), "Unexpected raw report arm")
        failures = []
        if report.get("status") != "success":
            failures.append({"status": report.get("status"), "reason": report.get("failureReason")})
        if report.get("skippedVerification"):
            failures.append({"skippedVerification": True, "reason": report.get("skipReason")})
        if report.get("packageSha256") != arms["A" if arm == "C" else arm]["packageSha256"]:
            failures.append({"packageIdentityMismatch": True})
        try:
            source_arm = "A" if arm == "C" else arm
            is_memory = parts[0] == "memory"
            media_check = "all" if parts[0].startswith("exhaustive-media-") else "sample"
            hashes = arms[source_arm]["sourceHashes"].copy()
            if is_memory:
                hashes["test/chromium/extension-two-dictionary-import.e2e.js"] = digest(instrumented_harness.encode())
            summary = read_json(z, name[:-len("run-1.json")] + "summary.json")
            receipt = validate_import_summary(
                summary, report, dictionary=spec["dictionary"], fixture=fixture,
                source_sha=arms[source_arm]["sha"], package_sha256=arms[source_arm]["packageSha256"],
                browser_version=browser["version"], import_flags=None, source_hashes=hashes,
                source_dirty=is_memory, media_check=media_check,
                vndb_sah_allocation_units=(37, 37) if spec["dictionary"] == "vndb" else None,
            )
            recorded_receipt = read_json(z, name[:-len("run-1.json")] + "canonical-receipt.json")
            require(recorded_receipt == receipt, "Stored semantic receipt differs from raw revalidation")
            if media_check in semantic_references:
                require_matching_receipts(semantic_references[media_check], receipt)
            else:
                semantic_references[media_check] = receipt
        except Exception as error:
            result["semanticRevalidationFailures"].append({
                "report": relative, "type": type(error).__name__,
                "message": str(error) if isinstance(error, (AuditError, ValueError)) else type(error).__name__,
            })
        numbers = {}
        details = None
        for phase in report.get("phases", []):
            data = phase.get("data") or {}
            debug = data.get("importDebug") or {}
            numbers.update(selected_numbers(debug, wanted))
            for entry in debug.get("importerPhaseTimings", []):
                if entry.get("phase") == "import-data-banks":
                    details = entry.get("details") or {}
        if spec["dictionary"] == "vndb":
            mismatches = {key: {"expected": expected, "actual": None if details is None else details.get(key)}
                          for key, expected in manifest["vndbPackedActivation"].items()
                          if details is None or type(details.get(key)) is not type(expected) or details.get(key) != expected}
            if mismatches:
                result["activationMismatches"].append({"report": relative, "mismatches": mismatches})
        result["rawReports"].append({"report": relative, "arm": arm, "status": report.get("status"), "selectedCountsAndPhases": numbers})
        if failures:
            result["rawReportFailures"].append({"report": relative, "failures": failures})
    if set(semantic_references) == {"sample", "all"}:
        try:
            require_matching_receipts(semantic_references["sample"], semantic_references["all"], compare_media=False)
        except Exception as error:
            result["semanticRevalidationFailures"].append({
                "report": "cross-media-mode", "type": type(error).__name__,
                "message": str(error) if isinstance(error, (AuditError, ValueError)) else type(error).__name__,
            })
    else:
        result["semanticRevalidationFailures"].append({"report": "cross-media-mode", "message": "Missing valid sample/all semantic reference"})
    expected_reports = {x["id"] + "/run-1.json" for x in plan["schedule"]}
    expected_reports.update("exhaustive-media-" + arm + "/run-1.json" for arm in ("A", "B"))
    expected_reports.update("memory/" + x["name"] + "/run-1.json" for x in plan["memorySchedule"])
    found_reports = {x["report"] for x in result["rawReports"]}
    for name in sorted(expected_reports - found_reports):
        result["rawReportFailures"].append({"report": name, "failures": [{"missing": True}]})
    require(not found_reports - expected_reports, "Unexpected additional raw observation report")
    result["stage"] = "outer-artifact-member-hashes"
    result["outerMemberHashes"] = []
    for item in members:
        with z.open(item) as stream:
            size, value = stream_digest(stream)
        result["outerMemberHashes"].append({"name": item.filename, "bytes": size, "sha256": value})
    result["stage"] = "complete"
    result["status"] = "audited"
    result["ordinaryQualificationStatus"] = analysis["status"]
    result["promotionDecision"] = "Not made by this read-only auditor"

def compact(result):
    keep = ("label", "runId", "sourceHead", "dictionary", "artifactId", "artifactName", "artifactSha256",
            "status", "stage", "error", "ordinaryQualificationStatus", "recomputed", "memoryFailures",
            "semanticFailures", "semanticRevalidationFailures", "memoryAuditFailure", "activationMismatches", "rawReportFailures")
    out = {k: result[k] for k in keep if k in result}
    if "memoryComparison" in result:
        out["memoryMetrics"] = result["memoryComparison"].get("metrics")
        out["memoryPassed"] = result["originalAnalysis"]["memoryPassed"]
    if "rawReports" in result:
        out["rawReportCount"] = len(result["rawReports"])
        unique = {}
        for row in result["rawReports"]:
            for key, value in row["selectedCountsAndPhases"].items():
                leaf = key.rsplit(".", 1)[-1]
                unique.setdefault(leaf, set()).add(value)
        out["selectedCountAndPhaseValues"] = {
            k: sorted(v) if len(v) <= 16 else {"distinctCount": len(v), "minimum": min(v), "maximum": max(v)}
            for k, v in unique.items()
        }
    return out

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=pathlib.Path, default=pathlib.Path(__file__).with_suffix(".json"))
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    require(bool(TOKEN), "GH_TOKEN is unavailable")
    manifest = json.loads(args.manifest.read_text())
    repository = manifest["repository"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is not None, "Invalid repository")
    report = {
        "schemaVersion": 1, "scope": __doc__, "manifestSha256": digest(args.manifest.read_bytes()),
        "auditorSourceSha256": digest(pathlib.Path(__file__).read_bytes()),
        "auditorCommit": os.environ.get("GITHUB_SHA"), "baseline": manifest["baseline"],
        "runs": [], "artifacts": [], "notes": manifest["notes"],
    }
    args.output.mkdir(parents=True, exist_ok=True)
    def save():
        (args.output / "audit.json").write_text(json.dumps(scrub(report), indent=2, sort_keys=True) + "\n")
    save()
    for run in manifest["runs"]:
        run_receipt = {"label": run["label"], "runId": run["id"], "expectedHead": run["head"]}
        report["runs"].append(run_receipt)
        try:
            base = "/repos/" + repository + "/actions/runs/" + str(run["id"])
            metadata = api_json(base)
            run_receipt.update({k: metadata.get(k) for k in ("head_sha", "run_attempt", "status", "conclusion")})
            require(metadata["head_sha"] == run["head"] and metadata["run_attempt"] == run["attempt"], "Run source head/attempt differs")
            run_receipt["jobs"] = [{k: row.get(k) for k in ("id", "name", "status", "conclusion")}
                                   for row in pages(base + "/jobs?filter=all", "jobs")]
            if run.get("statusOnly"):
                run_receipt["scope"] = run["scope"]
                save()
                print("AUDIT_RUN " + json.dumps(scrub(run_receipt), sort_keys=True), flush=True)
                continue
            available = pages(base + "/artifacts", "artifacts")
        except Exception as error:
            run_receipt["auditError"] = str(error) if isinstance(error, AuditError) else type(error).__name__
            save()
            print("AUDIT_RUN " + json.dumps(scrub(run_receipt), sort_keys=True), flush=True)
            continue
        save()
        for spec in run["artifacts"]:
            result = {"label": run["label"], "runId": run["id"], "sourceHead": run["head"],
                      "dictionary": spec["dictionary"], "artifactName": spec["name"]}
            report["artifacts"].append(result)
            try:
                matches = [row for row in available if row["name"] == spec["name"]]
                if not matches:
                    result["status"] = "missing-completed-artifact" if metadata["status"] == "completed" else "pending-artifact"
                    result["runStatus"] = metadata["status"]
                    result["runConclusion"] = metadata["conclusion"]
                else:
                    require(len(matches) == 1, "Ambiguous artifact name; no cohort automatically selected")
                    artifact = matches[0]
                    result["artifactId"] = artifact["id"]
                    result["artifactMetadata"] = {k: artifact.get(k) for k in ("id", "name", "digest", "size_in_bytes", "created_at", "updated_at", "expires_at", "workflow_run")}
                    require(not artifact["expired"], "Artifact has expired")
                    require(artifact["workflow_run"]["id"] == run["id"] and artifact["workflow_run"]["head_sha"] == run["head"], "Artifact run/head differs")
                    if "id" in spec:
                        require(artifact["id"] == spec["id"], "Pinned artifact ID differs")
                    value = artifact.get("digest", "")
                    require(re.fullmatch(r"sha256:[0-9a-f]{64}", value) is not None, "Artifact digest unavailable")
                    expected = value.split(":", 1)[1]
                    if "sha256" in spec:
                        require(expected == spec["sha256"], "Pinned artifact digest differs")
                    result["artifactSha256"] = expected
                    with tempfile.TemporaryDirectory(prefix="read-only-import-audit-") as temporary:
                        path = pathlib.Path(temporary) / "artifact.zip"
                        size, actual = download_zip(repository, artifact["id"], path)
                        require(actual == expected and size == artifact["size_in_bytes"], "Downloaded artifact digest/size differs")
                        result["artifactBytes"] = size
                        with zipfile.ZipFile(path) as z:
                            audit_contents(z, run, spec, manifest, result)
            except Exception as error:
                result["status"] = "audit-error"
                result["error"] = str(error) if isinstance(error, AuditError) else type(error).__name__
            save()
            print("AUDIT_CASE " + json.dumps(scrub(compact(result)), sort_keys=True), flush=True)
    report["expectedArtifactCount"] = sum(len(x["artifacts"]) for x in manifest["runs"])
    report["allExpectedArtifactsAvailable"] = (
        len(report["artifacts"]) == report["expectedArtifactCount"]
        and all("artifactId" in x for x in report["artifacts"])
        and not any("auditError" in x for x in report["runs"])
    )
    report["auditErrors"] = sum("auditError" in x for x in report["runs"]) + sum(x.get("status") == "audit-error" for x in report["artifacts"])
    report["auditedArtifactCount"] = sum(x.get("status") == "audited" for x in report["artifacts"])
    report["candidateQualificationPassIsNotInferred"] = True
    save()
    print("AUDIT_TOTAL " + json.dumps({k: report[k] for k in ("allExpectedArtifactsAvailable", "auditErrors", "auditedArtifactCount", "candidateQualificationPassIsNotInferred")}, sort_keys=True), flush=True)
    return 1 if report["auditErrors"] else 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        message = str(error) if isinstance(error, AuditError) else type(error).__name__
        print("AUDIT_FATAL " + json.dumps({"error": scrub(message)}), flush=True)
        sys.exit(1)
