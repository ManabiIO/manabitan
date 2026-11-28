#!/usr/bin/env python3
"""Repackage immutable import evidence without running imports or altering gates."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile


class ExportError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def exporter_identity():
    return {
        "commit": os.environ.get("GITHUB_SHA"), "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "python": sys.version,
        "scriptSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    }


def request_config(path):
    value = json.loads(path.read_text())
    if value["repository"] != "ManabiIO/manabitan":
        raise ExportError("Unexpected repository")
    if value["sourceRunId"] != 46101887140 or value["sourceRunAttempt"] != 1:
        raise ExportError("Unexpected original run or attempt")
    if value["sourceHeadSha"] != "a94a751b8068c00a44ce120c16fca6762afd3a03":
        raise ExportError("Unexpected original study source")
    expected = {
        f"import-study-6b4c-{candidate}-{dictionary}-{order}-1"
        for candidate in ("typed-record-lengths", "dedup-lookahead")
        for dictionary in ("jmdict", "jitendex", "vndb")
        for order in ("AB", "BA")
    }
    if set(value["expectedArtifactNames"]) != expected or len(value["expectedArtifactNames"]) != len(expected):
        raise ExportError("Expected artifact set must contain all 12 original cells")
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", value["requestNonce"]):
        raise ExportError("Invalid explicit request nonce")
    if any(type(item) is not int or item <= 0 for item in value["alreadyExportedArtifactIds"]):
        raise ExportError("Already-exported artifact IDs must be positive integers")
    return value


def api_request(config, suffix):
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise ExportError("GITHUB_TOKEN is required for read-only artifact access")
    return urllib.request.Request(
        f"https://api.github.com/repos/{config['repository']}/{suffix}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Manabitan-import-evidence-export",
        },
    )


def api_json(config, suffix):
    try:
        with urllib.request.urlopen(api_request(config, suffix), timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise ExportError(f"GitHub metadata request failed with HTTP {error.code}") from None
    except urllib.error.URLError:
        raise ExportError("GitHub metadata request failed in transport") from None


def validate_run(config, run):
    if (run.get("id"), run.get("head_sha"), run.get("run_attempt")) != (
        config["sourceRunId"], config["sourceHeadSha"], config["sourceRunAttempt"],
    ):
        raise ExportError("Original run identity or attempt changed")
    if run.get("repository", {}).get("full_name") != config["repository"]:
        raise ExportError("Original run repository differs")
    if run.get("path") != ".github/workflows/import-study-6b4c.yml":
        raise ExportError("Original run workflow differs")


def validate_artifact(config, artifact):
    if artifact.get("name") not in config["expectedArtifactNames"]:
        raise ExportError("Unexpected original artifact name")
    if artifact.get("expired") is not False:
        raise ExportError("Original artifact is expired")
    workflow = artifact.get("workflow_run", {})
    if (workflow.get("id"), workflow.get("head_sha")) != (config["sourceRunId"], config["sourceHeadSha"]):
        raise ExportError("Original artifact run identity differs")
    if type(artifact.get("id")) is not int or artifact["id"] <= 0:
        raise ExportError("Invalid original artifact ID")
    if type(artifact.get("size_in_bytes")) is not int or artifact["size_in_bytes"] <= 0:
        raise ExportError("Invalid original artifact size")
    digest = artifact.get("digest")
    if not isinstance(digest, str) or re.fullmatch(r"sha256:[a-f0-9]{64}", digest) is None:
        raise ExportError("Original artifact lacks a published SHA-256 digest")


def output_value(name, value):
    with pathlib.Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(name + "=" + value + "\n")


def discover(config, output):
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "request.json", config)
    run = api_json(config, f"actions/runs/{config['sourceRunId']}")
    write_json(output / "source-run.json", run)
    validate_run(config, run)
    artifacts = []
    page = 1
    while True:
        result = api_json(config, f"actions/runs/{config['sourceRunId']}/artifacts?per_page=100&page={page}")
        artifacts.extend(result["artifacts"])
        if len(artifacts) >= result["total_count"]:
            break
        if not result["artifacts"]:
            raise ExportError("Original artifact listing ended before total_count")
        page += 1
    write_json(output / "all-source-artifacts.json", artifacts)
    by_name = {}
    selected = []
    excluded = set(config["alreadyExportedArtifactIds"])
    failures = []
    for artifact in artifacts:
        name = artifact["name"]
        if name not in config["expectedArtifactNames"]:
            continue
        if name in by_name:
            raise ExportError("Multiple original artifacts have the same expected name")
        by_name[name] = artifact
        try:
            validate_artifact(config, artifact)
        except ExportError as error:
            failures.append({"id": artifact["id"], "name": name, "reason": str(error)})
            continue
        if artifact["id"] not in excluded:
            selected.append({
                "id": artifact["id"], "name": name, "size": artifact["size_in_bytes"],
                "digest": artifact["digest"],
            })
    selected.sort(key=lambda item: config["expectedArtifactNames"].index(item["name"]))
    inventory = {
        "exporter": exporter_identity(),
        "capturedAt": timestamp(), "sourceRunId": config["sourceRunId"],
        "sourceRunStatus": run["status"], "sourceRunConclusion": run["conclusion"],
        "sourceRunCompleted": run["status"] == "completed",
        "allAvailableArtifactIds": [item["id"] for item in artifacts],
        "selectedArtifacts": selected, "unavailableArtifacts": failures,
        "alreadyExportedArtifactIds": config["alreadyExportedArtifactIds"],
        "pendingOrMissingCellNames": [name for name in config["expectedArtifactNames"] if name not in by_name],
        "policy": "Export only finalized artifacts available at inventory time; no waiting, reruns, replacement observations, or timing work",
    }
    write_json(output / "inventory.json", inventory)
    output_value("matrix", json.dumps({"include": selected}, separators=(",", ":")))
    output_value("hasArtifacts", "true" if selected else "false")
    print(json.dumps({"available": len(artifacts), "selected": len(selected), "pendingOrMissing": len(inventory["pendingOrMissingCellNames"])}))


def signed_download_url(config, artifact_id):
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(api_request(config, f"actions/artifacts/{artifact_id}/zip"), timeout=60)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise ExportError(f"Original artifact redirect request failed with HTTP {error.code}") from None
        location = error.headers.get("Location")
    except urllib.error.URLError:
        raise ExportError("Original artifact redirect request failed in transport") from None
    else:
        response.close()
        raise ExportError("Original artifact API did not return an expected download redirect")
    parsed = urllib.parse.urlsplit(location or "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ExportError("Original artifact redirect is not a valid HTTPS download URL")
    return location


def download_original(config, artifact, path):
    required = artifact["size_in_bytes"] + 1024 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise ExportError("Insufficient disk space for original ZIP plus evidence reserve")
    url = signed_download_url(config, artifact["id"])
    digest = hashlib.sha256()
    count = 0
    # The signed URL request deliberately receives no GitHub Authorization header.
    try:
        with urllib.request.urlopen(url, timeout=60) as response, path.open("xb") as target:
            while block := response.read(1024 * 1024):
                count += len(block)
                if count > artifact["size_in_bytes"]:
                    raise ExportError("Downloaded original ZIP exceeds published artifact size")
                digest.update(block)
                target.write(block)
    except urllib.error.HTTPError as error:
        raise ExportError(f"Original artifact download failed with HTTP {error.code}") from None
    except urllib.error.URLError:
        raise ExportError("Original artifact download failed in transport") from None
    actual = digest.hexdigest()
    expected = artifact["digest"].removeprefix("sha256:")
    if count != artifact["size_in_bytes"] or actual != expected:
        raise ExportError("Downloaded original ZIP differs from published size or SHA-256")
    return {"bytes": count, "sha256": actual, "matchesPublishedArtifact": True}


def safe_parts(name, is_directory):
    if not name or "\\" in name or name.startswith("/") or "\x00" in name:
        raise ExportError("Unsafe ZIP member path")
    raw = name[:-1] if is_directory and name.endswith("/") else name
    parts = raw.split("/")
    if any(part in ("", ".", "..") for part in parts) or ":" in parts[0]:
        raise ExportError("Unsafe ZIP member component")
    return parts


def selected_member(parts):
    if parts[0] == "qualification":
        return True
    if len(parts) == 1 and parts[0] in ("registered-study.json", "registered-source-trees.json"):
        return True
    if parts[0] == "qualification-sources":
        return False
    raise ExportError("Unexpected top-level ZIP content; refusing to omit unclassified evidence")


def extract_evidence(archive_path, output):
    destination = output / "evidence"
    destination.mkdir()
    retained = []
    excluded_count = 0
    total_selected_bytes = 0
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = set()
        selections = []
        with (output / "archive-entry-manifest.jsonl").open("w") as manifest:
            for entry in entries:
                manifest.write(json.dumps({
                    "name": entry.filename, "directory": entry.is_dir(), "bytes": entry.file_size,
                    "compressedBytes": entry.compress_size, "crc32": f"{entry.CRC:08x}",
                    "compression": entry.compress_type, "flags": entry.flag_bits,
                    "externalAttributes": entry.external_attr, "dateTime": entry.date_time,
                }, sort_keys=True) + "\n")
        # Validate all names before extracting any content; never use extractall.
        for entry in entries:
            parts = safe_parts(entry.filename, entry.is_dir())
            canonical_name = "/".join(parts)
            if canonical_name in names:
                raise ExportError("Duplicate ZIP member path")
            names.add(canonical_name)
            selected = selected_member(parts)
            if selected:
                if stat.S_ISLNK(entry.external_attr >> 16):
                    raise ExportError("Selected ZIP member is a symbolic link")
                if entry.flag_bits & 1:
                    raise ExportError("Selected ZIP member is encrypted")
                total_selected_bytes += entry.file_size
                selections.append((entry, parts))
            else:
                excluded_count += 1
        if not any(parts[0] == "qualification" and not entry.is_dir() for entry, parts in selections):
            raise ExportError("Original artifact contains no qualification files")
        if shutil.disk_usage(destination).free < total_selected_bytes + 128 * 1024 * 1024:
            raise ExportError("Insufficient disk space for all qualification evidence")
        for entry, parts in selections:
            target = destination.joinpath(*parts)
            target.resolve().relative_to(destination.resolve())
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            count = 0
            with archive.open(entry) as source, target.open("xb") as sink:
                while block := source.read(1024 * 1024):
                    digest.update(block)
                    count += len(block)
                    sink.write(block)
            if count != entry.file_size:
                raise ExportError("Extracted member length differs from ZIP manifest")
            retained.append({"name": entry.filename, "bytes": count, "sha256": digest.hexdigest()})
    write_json(output / "retained-file-sha256.json", retained)
    return {
        "originalEntryCount": len(entries), "retainedFileCount": len(retained),
        "retainedFileBytes": sum(item["bytes"] for item in retained),
        "excludedSourceWorktreeEntryCount": excluded_count,
        "exclusionPolicy": "Only qualification-sources; every qualification file and registered plan/tree file is retained without extension or size filtering",
    }


def export_one(config, output):
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "request.json", config)
    receipt = {
        "startedAt": timestamp(), "status": "incomplete", "retimingPerformed": False,
        "exporter": exporter_identity(),
    }
    try:
        artifact_id = int(os.environ["EXPORT_ARTIFACT_ID"])
        artifact = api_json(config, f"actions/artifacts/{artifact_id}")
        write_json(output / "original-artifact.json", artifact)
        validate_artifact(config, artifact)
        if (artifact["id"], artifact["name"], artifact["size_in_bytes"], artifact["digest"]) != (
            artifact_id, os.environ["EXPORT_ARTIFACT_NAME"], int(os.environ["EXPORT_ARTIFACT_SIZE"]), os.environ["EXPORT_ARTIFACT_DIGEST"],
        ):
            raise ExportError("Original artifact changed since inventory")
        with tempfile.TemporaryDirectory(prefix="manabitan-evidence-export-") as temporary:
            archive_path = pathlib.Path(temporary) / "original.zip"
            receipt["originalZip"] = download_original(config, artifact, archive_path)
            write_json(output / "export-receipt.json", receipt)
            receipt["extraction"] = extract_evidence(archive_path, output)
            receipt["status"] = "complete-original-sha-verified"
        receipt["finishedAt"] = timestamp()
    except Exception as error:
        receipt["status"] = "failed"
        receipt["errorType"] = type(error).__name__
        receipt["error"] = str(error) if isinstance(error, ExportError) else "Unexpected local processing failure; inspect traceback"
        receipt["finishedAt"] = timestamp()
        raise
    finally:
        write_json(output / "export-receipt.json", receipt)
    print(json.dumps({"artifactId": artifact_id, "status": receipt["status"], **receipt["extraction"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("discover", "export"))
    parser.add_argument("--request", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    config = request_config(args.request)
    if args.mode == "discover":
        discover(config, args.output)
    else:
        export_one(config, args.output)


if __name__ == "__main__":
    main()
