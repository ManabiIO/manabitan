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

def redact(error):
    message = str(error)
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        message = message.replace(token, "<token-redacted>")
    return re.sub(r"https?://\S+", "<url-redacted>", message)[:2000]

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

def bind_sources(source, study, location, known_root):
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
    assert proof and known_root is not None, "Recent-first audit requires the matching completed known-answer proof"
    assert git(known_root, "rev-parse", "HEAD") == proof["evidenceCommit"]
    proof_path = known_root / proof["reportPath"]
    assert file_sha(proof_path) == proof["reportSha256"]
    known = read(proof_path)
    assert known["complete"] is True and known["exactJournalEntries"] == 5661
    assert known["newAuditorSha256"] == file_sha(HERE / "audit-recent-first.py")
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

def audit_entry(entry_key, source, baseline, output, known_root=None):
    registration = verify_registration()
    entry = registration["entries"][entry_key]
    study = registration["studies"][entry["study"]]
    output.mkdir(parents=True)
    acquisition = {
        "entry": entry_key, "expected": entry, "study": study,
        "auditCommit": os.environ["GITHUB_SHA"],
        "auditRegistrationSha256": file_sha(HERE / "registration.json"),
        "auditFileSha256": registration["auditFileSha256"],
        "complete": False, "originalArchiveVerified": False,
        "noTimingOrParserReexecution": True,
    }
    summary = {"entry": entry_key, "auditPassed": False, "requiredGatesPassed": False}
    try:
        run = api(f"/actions/runs/{study['runId']}")
        job = api(f"/actions/jobs/{entry['jobId']}")
        artifact = api(f"/actions/artifacts/{entry['artifactId']}")
        acquisition["run"] = {key: run.get(key) for key in (
            "id", "head_sha", "head_branch", "event", "run_attempt", "status", "conclusion", "created_at", "updated_at")}
        acquisition["job"] = {key: job.get(key) for key in (
            "id", "run_id", "head_sha", "name", "status", "conclusion", "started_at", "completed_at")}
        acquisition["artifact"] = artifact
        assert run["id"] == study["runId"] and run["head_sha"] == study["sourceCommit"]
        assert run["run_attempt"] == 1 and run["event"] == "push"
        assert job["id"] == entry["jobId"] and job["run_id"] == study["runId"]
        assert job["head_sha"] == study["sourceCommit"] and job["status"] == "completed"
        assert job["name"] == entry["jobName"]
        assert artifact["id"] == entry["artifactId"] and artifact["name"] == entry["artifactName"]
        assert not artifact["expired"]
        assert artifact["size_in_bytes"] == entry["artifactBytes"]
        assert artifact["digest"] == "sha256:" + entry["artifactSha256"]
        assert artifact["workflow_run"]["id"] == study["runId"]
        assert artifact["workflow_run"]["head_sha"] == study["sourceCommit"]
        archive = output / "original-artifact.zip"
        download_original(entry["artifactId"], archive, entry["artifactBytes"], entry["artifactSha256"])
        acquisition["originalArchiveVerified"] = True
        location = output / "original-members"
        members = extract_and_census(archive, location)
        write(output / "archive-members.json", {
            "complete": True, "artifactId": entry["artifactId"],
            "outerSha256": entry["artifactSha256"], "outerBytes": entry["artifactBytes"],
            "memberCount": len(members), "members": members,
        })
        auditor = bind_sources(source, study, location, known_root)
        command = [sys.executable, str(auditor), str(location), "--out", str(output / "independent-audit.json")]
        if study["kind"] == "prefix":
            command += ["--source-root", str(source), "--baseline-root", str(baseline),
                        "--dictionary", entry["dictionary"]]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        (output / "audit.stdout.log").write_text(completed.stdout)
        (output / "audit.stderr.log").write_text(completed.stderr)
        acquisition["auditorSha256"] = file_sha(auditor)
        acquisition["auditorReturncode"] = completed.returncode
        report = read(output / "independent-audit.json")
        assert report.get("dictionary", entry["dictionary"]) == entry["dictionary"]
        audit_passed = completed.returncode == 0 and report.get("complete") is True
        memory_passed = report.get("memoryPassed") if study["kind"] == "canonical" else None
        acquisition["complete"] = True
        summary = {
            "entry": entry_key, "artifactId": entry["artifactId"], "artifactSha256": entry["artifactSha256"],
            "auditPassed": audit_passed, "memoryPassed": memory_passed,
            "requiredGatesPassed": audit_passed and memory_passed is not False,
            "performancePromotionDecision": "not automatic",
            "report": compact_report(report, study["kind"]),
        }
    except Exception as error:
        acquisition["failure"] = {"type": type(error).__name__, "error": redact(error)}
        summary["failure"] = acquisition["failure"]
        if not (output / "independent-audit.json").exists():
            write(output / "independent-audit.json", {
                "complete": False, "dictionary": entry["dictionary"], "acquisitionFailedBeforeAudit": True,
                **acquisition["failure"],
            })
    write(output / "acquisition.json", acquisition)
    write(output / "summary.json", summary)
    # Print only structured summaries; full raw reports and auditor logs remain
    # in the evidence. Never print a token, request header or signed URL.
    console = encoded(summary)
    if len(console.encode()) > 24000:
        console = encoded({key: summary.get(key) for key in (
            "entry", "artifactId", "artifactSha256", "auditPassed", "memoryPassed", "requiredGatesPassed", "failure")})
    print("FROZEN_AUDIT_SUMMARY " + console, flush=True)
    return 0 if summary["requiredGatesPassed"] else 1

def retain_archive(output, kind):
    original = output / "original-artifact.zip"
    if not original.exists():
        return None
    if kind == "prefix" or not (output / "archive-members.json").exists():
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
    with zipfile.ZipFile(retained, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
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
    write(output / "retention.json", {
        "mode": "all-original-member-bytes-except-listed-reproducible-package-zips",
        "originalOuterSha256": census["outerSha256"], "originalOuterBytes": census["outerBytes"],
        "retainedArchiveSha256": file_sha(retained), "retainedArchiveBytes": retained.stat().st_size,
        "omittedOriginalMembers": omitted,
        "limitations": "The retained archive is not the original outer ZIP. Complete original-member census and original outer digest are retained. Only exact package-A.zip/package-B.zip members are omitted; original observations remain byte-identical. Original package bytes were available to the audit before omission; consult its pass/failure report.",
    })
    return retained

def publish_entry(entry_key, output):
    if entry_key == "prefix-known-answer":
        publish_known(output)
        return
    registration = verify_registration()
    entry = registration["entries"][entry_key]
    kind = registration["studies"][entry["study"]]["kind"]
    assert (output / "acquisition.json").exists(), "No audit/acquisition receipt to retain"
    archive = retain_archive(output, kind)
    names = ["acquisition.json", "archive-members.json", "independent-audit.json",
             "summary.json", "audit.stdout.log", "audit.stderr.log", "retention.json"]
    if archive:
        names.append(archive.name)
    elif (output / "download-incomplete.bin").exists():
        names.append("download-incomplete.bin")
    publish_files(output, entry_key, names, {
        "originalRunId": registration["studies"][entry["study"]]["runId"],
        "originalArtifactId": entry["artifactId"],
        "originalArtifactSha256": entry["artifactSha256"],
    })

def publish_known(output):
    verify_registration()
    assert (output / "known-answer.json").exists()
    names = ["known-answer.json"]
    for dictionary in ("jmdict", "jitendex", "vndb"):
        names += [dictionary + "/" + name for name in (
            "reconstructed-audit.json", "archive-members.json", "audit.stdout.log", "audit.stderr.log")]
    publish_files(output, "prefix-known-answer", names, {
        "knownAnswerOnly": True,
        "originalEvidenceCommit": "a355146b6c511f8ccdea3fd7fa60af9c450d904f",
        "originalIndependentAuditGitBlob": "03a0efff5529523183fe92997b0946ff98e7d622",
    })

def publish_files(output, entry_key, names, provenance):
    files = []
    for name in names:
        path = output / name
        if not path.exists():
            continue
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
    manifest = {
        "complete": True, "entry": entry_key, "auditCommit": os.environ["GITHUB_SHA"],
        **provenance,
        "unreferencedBlobsOnly": True, "noRefOrBranchOrPullRequestWrite": True, "files": files,
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

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("audit", "publish"))
    parser.add_argument("--entry", required=True)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--baseline-root", type=Path)
    parser.add_argument("--known-answer-root", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "audit":
        assert args.source_root is not None
        sys.exit(audit_entry(args.entry, args.source_root.resolve(),
                             args.baseline_root.resolve() if args.baseline_root else None, args.out.resolve(),
                             args.known_answer_root.resolve() if args.known_answer_root else None))
    publish_entry(args.entry, args.out.resolve())
