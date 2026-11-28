#!/usr/bin/env python3
"""Acquire and audit fixed Actions artifacts; never replay an import or parser."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "ManabiIO/manabitan"
API = "https://api.github.com/repos/" + REPOSITORY
HERE = Path(__file__).resolve().parent
MAX_BLOB_BYTES = 64 * 1024 * 1024

def read(path):
    return json.loads(path.read_text())

def encoded(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))

def write(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")

def sha(data):
    return hashlib.sha256(data).hexdigest()

def file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

def redact_text(value):
    message = str(value)
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        message = message.replace(token, "<token-redacted>")
    return re.sub(r"https?://\S+", "<url-redacted>", message)

def redact(error):
    return redact_text(error)[:2000]

def print_diagnostic(entry, stage, stderr, stdout=""):
    # Redact the complete text before selecting its bounded tail.
    safe = redact_text(stderr if stderr else stdout)
    tail = "\n".join(safe.splitlines()[-30:])[-4096:]
    print("FROZEN_AUDIT_DIAGNOSTIC " + encoded({
        "entry": entry, "stage": stage, "sanitizedTail": tail,
        "fullLogsRetained": True,
    }), flush=True)

def api(path, body=None):
    assert path.startswith("/") and not path.startswith("//")
    headers = {
        "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "manabitan-frozen-artifact-audit",
    }
    data = None
    if body is not None:
        assert path == "/git/blobs", "Only unreferenced Git blob creation is permitted"
        data = encoded(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(API + path, data=data, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
        return json.load(response)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None

def download_original(artifact_id, path, expected_size, expected_sha):
    # The token is sent only to the constructed GitHub API URL. Redirects are
    # followed by a fresh request that contains no Authorization header.
    url = API + f"/actions/artifacts/{artifact_id}/zip"
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
        "Accept": "application/vnd.github+json",
        "User-Agent": "manabitan-frozen-artifact-audit",
    })
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=120)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        redirect = error.headers.get("Location", "")
        parsed = urllib.parse.urlparse(redirect)
        assert parsed.scheme == "https" and parsed.netloc and not parsed.username and not parsed.password
        response = urllib.request.urlopen(
            urllib.request.Request(redirect, headers={"User-Agent": "manabitan-frozen-artifact-audit"}),
            timeout=120,
        )
    partial = path.with_name("download-incomplete.bin")
    digest = hashlib.sha256()
    total = 0
    with response, partial.open("xb") as stream:
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            assert total <= expected_size, "Downloaded archive exceeds registered size"
            digest.update(chunk)
            stream.write(chunk)
    assert total == expected_size, "Downloaded archive size differs"
    assert digest.hexdigest() == expected_sha, "Original outer artifact digest differs"
    partial.rename(path)

def extract_and_census(archive_path, destination):
    destination.mkdir()
    members = []
    seen = set()
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            raw = info.filename.rstrip("/")
            assert raw and "\\" not in raw and "\x00" not in raw
            parts = raw.split("/")
            assert all(part not in ("", ".", "..") for part in parts)
            relative = PurePosixPath(raw)
            assert not relative.is_absolute() and not re.match(r"^[A-Za-z]:", raw)
            assert info.filename not in seen, "Duplicate archive member"
            seen.add(info.filename)
            mode = info.external_attr >> 16
            assert not stat.S_ISLNK(mode)
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)
            target = destination.joinpath(*relative.parts)
            assert target.resolve().is_relative_to(destination.resolve())
            row = {"path": info.filename, "bytes": info.file_size,
                   "compressedBytes": info.compress_size, "crc32": info.CRC,
                   "externalAttributes": info.external_attr, "directory": info.is_dir()}
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                count = 0
                with archive.open(info) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        count += len(chunk)
                        digest.update(chunk)
                        output.write(chunk)
                assert count == info.file_size
                row["sha256"] = digest.hexdigest()
            members.append(row)
    return members

def bind_sources(source, study, location, known_root, reference_root=None):
    assert git(source, "rev-parse", "HEAD") == study["sourceCommit"]
    assert git(source, "rev-parse", "HEAD^{tree}") == study["sourceTree"]
    if study["kind"] == "canonical":
        config_path = source / "dev/perf/canonical-sidecar-qualification-20261128-beb5.json"
        config = read(config_path)
        assert config["candidate"] == "570ccc3968046269cb00d2053e49d3c32367031a"
        assert config["candidateTree"] == "f68db2831a11dc0b733287f109f08c5ec0a34fde"
        assert (location / "qualification-config.json").read_bytes() == config_path.read_bytes()
        hashes = {}
        for name, expected in config["qualificationSourceHashes"].items():
            assert file_sha(source / name) == expected, f"Qualification source: {name}"
            hashes[name] = expected
        expected = {
            "studyCommit": study["sourceCommit"], "studyTree": study["sourceTree"],
            "configSha256": file_sha(config_path), "qualificationSourceHashes": hashes,
            "memoryAcquisition": config["memoryAcquisition"],
        }
        assert read(location / "qualification-source-identities.json") == expected
        auditor = source / study["auditorPath"]
        assert file_sha(auditor) == study["auditorSha256"]
        return auditor
    assert study["kind"] == "prefix"
    proof = study.get("knownAnswer")
    assert proof and proof["mode"] == "same-job-required"
    assert known_root is not None, "Recent-first audit requires this job's successful known-answer proof"
    proof_path = known_root / "known-answer.json"
    known = read(proof_path)
    assert known["complete"] is True and known["knownAnswerOnly"] is True
    assert known["noNewMeasurements"] is True and known["exactJournalEntries"] == 5661
    assert known["retainedEvidenceCommit"] == proof["evidenceCommit"]
    assert known["sourceCommit"] == proof["sourceCommit"] and known["sourceTree"] == proof["sourceTree"]
    assert known["originalIndependentAuditGitBlob"] == proof["originalIndependentAuditGitBlob"]
    assert known["newAuditorSha256"] == file_sha(HERE / "audit-recent-first.py")
    assert [case["dictionary"] for case in known["cases"]] == ["jmdict", "jitendex", "vndb"]
    assert all(case["complete"] is True and case["oracleComparisons"] == 242 for case in known["cases"])
    assert known["derivedArithmeticTolerance"] == verify_registration()["knownAnswerDerivedTolerances"]
    assert reference_root is not None
    assert git(reference_root, "rev-parse", "HEAD") == proof["sourceCommit"]
    assert git(reference_root, "rev-parse", "HEAD^{tree}") == proof["sourceTree"]
    assert set(known["referenceOracles"]) == {"jmdict", "jitendex", "vndb"}
    reference = known["referenceOracles"]["jmdict"]
    assert reference["path"] == "jmdict/original-members/oracle.json"
    assert file_sha(known_root / reference["path"]) == reference["sha256"]
    assert all(item["baselineProjectionSha256"] == known["baselineOracleProjectionSha256"]
               for item in known["referenceOracles"].values())
    return HERE / "audit-recent-first.py"

def compact_report(report, kind):
    if not report.get("complete"):
        return {key: report.get(key) for key in ("complete", "dictionary", "type", "error")}
    if kind == "canonical":
        return {
            "complete": True, "dictionary": report["dictionary"],
            "validatedObservationCount": report["validatedObservationCount"],
            "candidate": report["candidate"], "control": report["control"],
            "memoryPassed": report["memoryPassed"],
            "memoryReceiptFailures": report["memoryReceiptFailures"],
            "phaseComparisons": report["phaseComparisons"],
            "limits": report["limits"],
        }
    reports = []
    for item in report["reports"]:
        reports.append({
            "file": item["file"], "exactJournalEntries": item["exactJournalEntries"],
            "dictionaries": [{"dictionary": row["dictionary"], "rows": row["rows"], "groups": row["groups"],
                              "comparisons": row["comparisons"], "diagnostics": row["diagnostics"]}
                             for row in item["dictionaries"]],
        })
    return {"complete": True, "dictionary": report["dictionary"], "reports": reports,
            "exactJournalEntries": report["exactJournalEntries"], "scope": report["scope"]}

def verify_registration():
    registration = read(HERE / "registration.json")
    assert file_sha(HERE.parents[2] / registration["workflow"]) == registration["workflowSha256"]
    for name, expected in registration["auditFileSha256"].items():
        assert file_sha(HERE / name) == expected, f"Audit implementation changed: {name}"
    return registration

def resolve_original(entry, study, acquisition, output, deadline, poll_seconds):
    # IDs already known at registration remain exact constraints. Unknown future
    # IDs may resolve only from one exact run/head/attempt/name selection.
    commit = api("/git/commits/" + study["sourceCommit"])
    assert commit["sha"] == study["sourceCommit"] and commit["tree"]["sha"] == study["sourceTree"]
    acquisition["sourceGitObject"] = {"sha": commit["sha"], "tree": commit["tree"]["sha"]}
    previous = None
    while True:
        run = api(f"/actions/runs/{study['runId']}")
        job = api(f"/actions/jobs/{entry['jobId']}")
        listing = api(f"/actions/runs/{study['runId']}/artifacts?per_page=100&name=" +
                      urllib.parse.quote(entry["artifactName"], safe=""))
        acquisition["run"] = {key: run.get(key) for key in (
            "id", "head_sha", "head_branch", "event", "path", "run_attempt", "status",
            "conclusion", "created_at", "updated_at")}
        acquisition["job"] = {key: job.get(key) for key in (
            "id", "run_id", "head_sha", "name", "status", "conclusion", "started_at", "completed_at")}
        assert run["id"] == study["runId"] and run["head_sha"] == study["sourceCommit"]
        assert run["run_attempt"] == study["runAttempt"] == 1 and run["event"] == "push"
        assert run["path"] == study["workflowPath"]
        assert job["id"] == entry["jobId"] and job["run_id"] == study["runId"]
        assert job["head_sha"] == study["sourceCommit"] and job["name"] == entry["jobName"]
        assert listing["total_count"] <= 100, "Artifact listing exceeds the registered bounded page"
        matches = [item for item in listing["artifacts"] if item["name"] == entry["artifactName"]]
        assert len(matches) <= 1, "Registered artifact name is ambiguous; never select a latest replacement"
        artifact = matches[0] if matches else None
        state = {
            "runStatus": run["status"], "runConclusion": run["conclusion"],
            "jobStatus": job["status"], "jobConclusion": job["conclusion"],
            "matchingArtifacts": len(matches),
            "artifactId": artifact["id"] if artifact else None,
        }
        if state != previous:
            with (output / "resolution-polls.jsonl").open("a") as stream:
                stream.write(encoded({"observedAtUnixSeconds": time.time(), **state}) + "\n")
            print("FROZEN_ARTIFACT_RESOLUTION " + encoded({
                "entry": acquisition["entry"], **state,
            }), flush=True)
            previous = state
        if artifact is not None:
            acquisition["artifact"] = artifact
            assert not artifact["expired"]
            assert artifact["workflow_run"]["id"] == study["runId"]
            assert artifact["workflow_run"]["head_sha"] == study["sourceCommit"]
            assert type(artifact["id"]) is int and artifact["id"] > 0
            assert type(artifact["size_in_bytes"]) is int and 0 < artifact["size_in_bytes"] <= entry["maxArtifactBytes"]
            assert re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest") or ""), "Artifact API digest is absent"
            for field, actual in (
                ("artifactId", artifact["id"]), ("artifactBytes", artifact["size_in_bytes"]),
                ("artifactSha256", artifact["digest"][7:]),
            ):
                if field in entry:
                    assert entry[field] == actual, f"Previously registered {field} differs"
            if job["status"] == "completed":
                acquisition["resolvedIdentity"] = {
                    "runId": study["runId"], "sourceCommit": study["sourceCommit"],
                    "runAttempt": 1, "jobId": entry["jobId"], "artifactName": entry["artifactName"],
                    "artifactId": artifact["id"], "artifactBytes": artifact["size_in_bytes"],
                    "artifactSha256": artifact["digest"][7:],
                    "selection": "Unique exact artifact name under the locked run/head/attempt; any prelocked ID/digest also matched.",
                }
                return artifact
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Registered original artifact did not become available within the fixed shared wait deadline")
        time.sleep(min(poll_seconds, remaining))

def run_auditor(command, output, entry_key, timeout_seconds):
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False, timeout=timeout_seconds)
        stdout, stderr = completed.stdout, completed.stderr
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        (output / "audit.stdout.log").write_text(stdout)
        (output / "audit.stderr.log").write_text(stderr)
        print_diagnostic(entry_key, "auditor-timeout", stderr, stdout)
        raise
    (output / "audit.stdout.log").write_text(stdout)
    (output / "audit.stderr.log").write_text(stderr)
    if completed.returncode != 0:
        print_diagnostic(entry_key, "auditor-exit-" + str(completed.returncode), stderr, stdout)
    return completed

def audit_entry(entry_key, source, baseline, output, known_root=None, deadline=None, reference_root=None):
    registration = verify_registration()
    entry = registration["entries"][entry_key]
    study = registration["studies"][entry["study"]]
    output.mkdir(parents=True)
    if deadline is None:
        deadline = time.monotonic() + registration["acquisition"]["maximumSharedWaitSeconds"]
    acquisition = {
        "entry": entry_key, "expected": entry, "study": study,
        "auditCommit": os.environ["GITHUB_SHA"],
        "auditRegistrationSha256": file_sha(HERE / "registration.json"),
        "auditFileSha256": registration["auditFileSha256"],
        "complete": False, "originalArchiveVerified": False,
        "sourceBindingsVerified": False, "independentAuditPerformed": False,
        "noTimingOrParserReexecution": True,
    }
    summary = {"entry": entry_key, "acquisitionComplete": False, "auditPassed": False,
               "requiredGatesPassed": False, "required": entry["required"]}
    stage = "resolve-original"
    try:
        artifact = resolve_original(entry, study, acquisition, output, deadline,
                                    registration["acquisition"]["pollSeconds"])
        archive = output / "original-artifact.zip"
        stage = "download-original"
        download_original(artifact["id"], archive, artifact["size_in_bytes"], artifact["digest"][7:])
        acquisition["originalArchiveVerified"] = True
        location = output / "original-members"
        stage = "extract-and-census"
        members = extract_and_census(archive, location)
        write(output / "archive-members.json", {
            "complete": True, "artifactId": artifact["id"],
            "outerSha256": artifact["digest"][7:], "outerBytes": artifact["size_in_bytes"],
            "memberCount": len(members), "members": members,
        })
        acquisition["complete"] = True
        if study["kind"] == "preserve-only":
            report = {
                "complete": False, "auditNotPerformed": True, "dictionary": entry["dictionary"],
                "scope": "Preservation only: exact API-bound original outer ZIP and full member census. No independent correctness, timing, or qualification audit.",
            }
            write(output / "independent-audit.json", report)
            summary = {
                "entry": entry_key, "artifactId": artifact["id"], "artifactSha256": artifact["digest"][7:],
                "acquisitionComplete": True, "auditPassed": None, "memoryPassed": None,
                "requiredGatesPassed": None, "required": entry["required"],
                "preserveOnly": True, "report": report,
            }
        else:
            stage = "source-and-known-answer-binding"
            auditor = bind_sources(source, study, location, known_root, reference_root)
            acquisition["sourceBindingsVerified"] = True
            if study["kind"] == "prefix":
                acquisition["knownAnswerProofSha256"] = file_sha(known_root / "known-answer.json")
                acquisition["referenceOracleSha256"] = file_sha(known_root / "jmdict/original-members/oracle.json")
                acquisition["referenceSourceCommit"] = git(reference_root, "rev-parse", "HEAD")
            command = [sys.executable, str(auditor), str(location), "--out", str(output / "independent-audit.json")]
            if study["kind"] == "prefix":
                assert reference_root is not None
                command += ["--source-root", str(source), "--baseline-root", str(baseline),
                            "--dictionary", entry["dictionary"],
                            "--reference-oracle", str(known_root / "jmdict/original-members/oracle.json"),
                            "--reference-source-root", str(reference_root)]
            stage = "independent-audit"
            completed = run_auditor(command, output, entry_key, registration["acquisition"]["auditorTimeoutSeconds"])
            acquisition["independentAuditPerformed"] = True
            acquisition["auditorSha256"] = file_sha(auditor)
            acquisition["auditorReturncode"] = completed.returncode
            report = read(output / "independent-audit.json")
            assert report.get("dictionary", entry["dictionary"]) == entry["dictionary"]
            audit_passed = completed.returncode == 0 and report.get("complete") is True
            memory_passed = report.get("memoryPassed") if study["kind"] == "canonical" else None
            summary = {
                "entry": entry_key, "artifactId": artifact["id"], "artifactSha256": artifact["digest"][7:],
                "acquisitionComplete": True, "auditPassed": audit_passed, "memoryPassed": memory_passed,
                "requiredGatesPassed": audit_passed and memory_passed is not False, "required": entry["required"],
                "performancePromotionDecision": "not automatic",
                "report": compact_report(report, study["kind"]),
            }
    except Exception as error:
        acquisition["failure"] = {"stage": stage, "type": type(error).__name__, "error": redact(error)}
        summary["failure"] = acquisition["failure"]
        summary["acquisitionComplete"] = acquisition["complete"]
        print_diagnostic(entry_key, stage, redact(error))
        if not (output / "independent-audit.json").exists():
            write(output / "independent-audit.json", {
                "complete": False, "dictionary": entry["dictionary"], "auditNotPerformed": True,
                **acquisition["failure"],
            })
    write(output / "acquisition.json", acquisition)
    write(output / "summary.json", summary)
    console = encoded(summary)
    if len(console.encode()) > 24000:
        console = encoded({key: summary.get(key) for key in (
            "entry", "artifactId", "artifactSha256", "acquisitionComplete", "auditPassed",
            "memoryPassed", "requiredGatesPassed", "preserveOnly", "failure")})
    print("FROZEN_AUDIT_SUMMARY " + console, flush=True)
    return summary

def retain_archive(output, kind):
    original = output / "original-artifact.zip"
    if not original.exists():
        return None
    # Omitting packaged archives is allowed only after the full original-byte
    # auditor completed. A memory-gate failure does not invalidate that audit.
    report_path = output / "independent-audit.json"
    byte_audit_complete = report_path.exists() and read(report_path).get("complete") is True
    if kind != "canonical" or not byte_audit_complete or not (output / "archive-members.json").exists():
        write(output / "retention.json", {
            "mode": "verbatim-original-artifact", "sha256": file_sha(original),
            "bytes": original.stat().st_size, "omittedOriginalMembers": [],
        })
        return original
    census = read(output / "archive-members.json")
    location = output / "original-members"
    excluded = {"package-A.zip", "package-B.zip"}
    retained = output / "evidence-without-reproducible-packages.zip"
    omitted = []
    with zipfile.ZipFile(retained, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for member in census["members"]:
            if member["directory"]:
                continue
            name = member["path"]
            path = location / name
            assert path.stat().st_size == member["bytes"] and file_sha(path) == member["sha256"]
            if name in excluded:
                omitted.append(member)
                continue
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, path.read_bytes())
    assert {row["path"] for row in omitted} == excluded, "Exact two package archives must be the only omissions"
    write(output / "retention.json", {
        "mode": "all-original-member-bytes-except-listed-reproducible-package-zips",
        "originalOuterSha256": census["outerSha256"], "originalOuterBytes": census["outerBytes"],
        "retainedArchiveSha256": file_sha(retained), "retainedArchiveBytes": retained.stat().st_size,
        "omittedOriginalMembers": omitted,
        "limitations": "The retained archive is not the original outer ZIP. Complete original-member census and original outer digest are retained. Only exact package-A.zip/package-B.zip members are omitted; original observations remain byte-identical. The full byte audit completed before omission; memory gates remain separate. A later full package/byte audit cannot be repeated from this reduced archive alone without the original package ZIPs.",
    })
    return retained

def publish_entry(entry_key, output):
    if entry_key == "prefix-known-answer":
        return publish_known(output)
    registration = verify_registration()
    entry = registration["entries"][entry_key]
    kind = registration["studies"][entry["study"]]["kind"]
    assert (output / "acquisition.json").exists(), "No acquisition receipt to retain"
    acquisition = read(output / "acquisition.json")
    try:
        archive = retain_archive(output, kind)
    except Exception as error:
        # A failed reduced-archive preparation must never suppress the original.
        original = output / "original-artifact.zip"
        archive = original if original.exists() else None
        write(output / "retention.json", {
            "mode": "verbatim-original-after-retention-preparation-failure" if archive else "no-complete-original",
            "failure": {"type": type(error).__name__, "error": redact(error)},
            "sha256": file_sha(original) if archive else None,
            "bytes": original.stat().st_size if archive else None, "omittedOriginalMembers": [],
        })
        print_diagnostic(entry_key, "retention-preparation", redact(error))
    names = ["acquisition.json", "archive-members.json", "independent-audit.json",
             "summary.json", "audit.stdout.log", "audit.stderr.log", "retention.json",
             "resolution-polls.jsonl"]
    if archive:
        names.append(archive.name)
    elif (output / "download-incomplete.bin").exists():
        names.append("download-incomplete.bin")
    resolved = acquisition.get("resolvedIdentity", {})
    return publish_files(output, entry_key, names, {
        "originalRunId": registration["studies"][entry["study"]]["runId"],
        "originalArtifactId": resolved.get("artifactId"),
        "originalArtifactSha256": resolved.get("artifactSha256"),
        "originalArchiveVerified": acquisition["originalArchiveVerified"],
        "acquisitionComplete": acquisition["complete"],
    })

def publish_known(output):
    verify_registration()
    assert (output / "known-answer.json").exists()
    names = ["known-answer.json"]
    for dictionary in ("jmdict", "jitendex", "vndb"):
        names += [dictionary + "/" + name for name in (
            "reconstructed-audit.json", "archive-members.json", "audit.stdout.log", "audit.stderr.log",
            "original-members/oracle.json")]
    return publish_files(output, "prefix-known-answer", names, {
        "knownAnswerOnly": True,
        "originalEvidenceCommit": "a355146b6c511f8ccdea3fd7fa60af9c450d904f",
        "originalIndependentAuditGitBlob": "03a0efff5529523183fe92997b0946ff98e7d622",
    })

def publish_files(output, entry_key, names, provenance):
    files = []
    failures = []
    for name in names:
        path = output / name
        if not path.exists():
            continue
        try:
            assert path.resolve().is_relative_to(output.resolve()) and path.is_file() and not path.is_symlink()
            size = path.stat().st_size
            assert size <= MAX_BLOB_BYTES, f"Retained file exceeds bounded Git-blob upload: {name}"
            data = path.read_bytes()
            expected_git = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            response = api("/git/blobs", {"encoding": "base64", "content": base64.b64encode(data).decode()})
            assert response["sha"] == expected_git, f"Git blob identity differs: {name}"
            row = {"path": f"dev/perf/import-round-20261128-beb5/hosted-audit/{entry_key}/{name}",
                   "bytes": len(data), "gitBlobSha": expected_git, "sha256": sha(data)}
            files.append(row)
            print("DURABLE_EVIDENCE_BLOB " + encoded(row), flush=True)
        except Exception as error:
            failure = {"name": name, "type": type(error).__name__, "error": redact(error)}
            failures.append(failure)
            print("DURABLE_EVIDENCE_FAILURE " + encoded({"entry": entry_key, **failure}), flush=True)
    manifest = {
        "complete": not failures, "entry": entry_key, "auditCommit": os.environ["GITHUB_SHA"],
        **provenance,
        "unreferencedBlobsOnly": True, "noRefOrBranchOrPullRequestWrite": True,
        "files": files, "failures": failures,
    }
    write(output / "durable-manifest.json", manifest)
    data = (output / "durable-manifest.json").read_bytes()
    expected_git = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    response = api("/git/blobs", {"encoding": "base64", "content": base64.b64encode(data).decode()})
    assert response["sha"] == expected_git
    print("DURABLE_EVIDENCE_MANIFEST " + encoded({
        "path": f"dev/perf/import-round-20261128-beb5/hosted-audit/{entry_key}/durable-manifest.json",
        "gitBlobSha": expected_git, "sha256": sha(data), "bytes": len(data),
    }), flush=True)
    return manifest

def batch(canonical, prefix, baseline, output, known_root, reference_root):
    registration = verify_registration()
    output.mkdir(parents=True, exist_ok=True)
    assert not (output / "batch-summary.json").exists()
    order = registration["entryOrder"]
    assert len(order) == len(set(order)) and set(order) == set(registration["entries"])
    deadline = time.monotonic() + registration["acquisition"]["maximumSharedWaitSeconds"]
    write(output / "batch-plan.json", {
        "auditCommit": os.environ["GITHUB_SHA"], "entryOrder": order,
        "registrationSha256": file_sha(HERE / "registration.json"),
        "acquisition": registration["acquisition"], "noTimingOrParserReexecution": True,
    })
    known_status = {"complete": False, "retentionComplete": False}
    try:
        known = read(known_root / "known-answer.json")
        known_status["complete"] = known.get("complete") is True
        known_status["reportSha256"] = file_sha(known_root / "known-answer.json")
        retained = publish_known(known_root)
        known_status["retentionComplete"] = retained["complete"]
    except Exception as error:
        known_status["failure"] = {"type": type(error).__name__, "error": redact(error)}
        print_diagnostic("prefix-known-answer", "known-answer-retention", redact(error))
    observations = []
    sources = {"canonical": canonical, "prefix": prefix, "crc": None}
    for entry_key in order:
        entry = registration["entries"][entry_key]
        row = {"entry": entry_key, "required": entry["required"], "retentionComplete": False}
        folder = output / entry_key
        try:
            entry_deadline = deadline
            if not entry["required"]:
                entry_deadline = min(deadline, time.monotonic() + registration["acquisition"]["optionalPreserveWaitSeconds"])
            summary = audit_entry(entry_key, sources[entry["study"]], baseline, folder,
                                  known_root, entry_deadline, reference_root)
            row["summary"] = summary
        except Exception as error:
            row["failure"] = {"type": type(error).__name__, "error": redact(error)}
            print_diagnostic(entry_key, "entry-wrapper", redact(error))
        try:
            retained = publish_entry(entry_key, folder)
            row["retentionComplete"] = retained["complete"]
        except Exception as error:
            row["retentionFailure"] = {"type": type(error).__name__, "error": redact(error)}
            print_diagnostic(entry_key, "entry-retention", redact(error))
        observations.append(row)
        with (output / "batch-journal.jsonl").open("a") as journal:
            journal.write(encoded(row) + "\n")
    required_gates = all(
        row.get("summary", {}).get("requiredGatesPassed") is True
        for row in observations if row["required"]
    )
    required_retention = all(row["retentionComplete"] for row in observations if row["required"])
    result = {
        "complete": True, "auditCommit": os.environ["GITHUB_SHA"],
        "noTimingOrParserReexecution": True, "knownAnswer": known_status,
        "requiredGatesPassed": known_status["complete"] and required_gates,
        "requiredRetentionComplete": known_status["retentionComplete"] and required_retention,
        "entries": observations, "optionalPreserveOnlyEntry": "crc-no-unroll-jmdict",
        "performancePromotionDecision": "not automatic",
        "limits": "A complete batch means every registered entry was attempted, including failures. Optional CRC preservation is never an independent efficacy or correctness audit.",
    }
    write(output / "batch-summary.json", result)
    print("FROZEN_AUDIT_BATCH " + encoded({
        "complete": True, "requiredGatesPassed": result["requiredGatesPassed"],
        "requiredRetentionComplete": result["requiredRetentionComplete"],
        "entries": [{"entry": row["entry"], "retentionComplete": row["retentionComplete"],
                     "acquisitionComplete": row.get("summary", {}).get("acquisitionComplete"),
                     "auditPassed": row.get("summary", {}).get("auditPassed"),
                     "requiredGatesPassed": row.get("summary", {}).get("requiredGatesPassed")}
                    for row in observations],
    }), flush=True)
    publish_files(output, "combined", ["batch-plan.json", "batch-journal.jsonl", "batch-summary.json"], {
        "originalRunIds": [registration["studies"][key]["runId"] for key in ("canonical", "prefix", "crc")],
        "noTimingOrParserReexecution": True,
    })
    return result["requiredGatesPassed"] and result["requiredRetentionComplete"]

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("audit", "publish", "batch"))
    parser.add_argument("--entry")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--canonical-root", type=Path)
    parser.add_argument("--prefix-root", type=Path)
    parser.add_argument("--reference-source-root", type=Path)
    parser.add_argument("--baseline-root", type=Path)
    parser.add_argument("--known-answer-root", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "batch":
        assert args.canonical_root and args.prefix_root and args.baseline_root and args.known_answer_root and args.reference_source_root
        sys.exit(0 if batch(args.canonical_root.resolve(), args.prefix_root.resolve(),
                             args.baseline_root.resolve(), args.out.resolve(),
                             args.known_answer_root.resolve(), args.reference_source_root.resolve()) else 1)
    assert args.entry
    if args.operation == "audit":
        summary = audit_entry(args.entry, args.source_root.resolve() if args.source_root else None,
                              args.baseline_root.resolve() if args.baseline_root else None, args.out.resolve(),
                              args.known_answer_root.resolve() if args.known_answer_root else None,
                              reference_root=args.reference_source_root.resolve() if args.reference_source_root else None)
        sys.exit(0 if summary["requiredGatesPassed"] is True or summary.get("preserveOnly") else 1)
    manifest = publish_entry(args.entry, args.out.resolve())
    sys.exit(0 if manifest["complete"] else 1)
